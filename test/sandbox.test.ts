import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { planSandboxInvocation } from "../src/sandbox/planner.js";
import { inferCapabilities, resolveSandboxPolicy } from "../src/sandbox/policy.js";
import { MacosSeatbeltBackend, seatbeltPolicy } from "../src/sandbox/backends/macos-seatbelt.js";
import { LinuxBubblewrapBackend, bubblewrapArgs, readOnlyMountsForPolicy } from "../src/sandbox/backends/linux-bubblewrap.js";
import { runSandboxedProcess, runtimeSandboxInfo } from "../src/sandbox/runner.js";
import type { SandboxExecutionInfo } from "../src/sandbox/types.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

function config(): VllmAgentConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function workspace(root = path.join(os.tmpdir(), "inferoa-sandbox-test")): WorkspaceIdentity {
  return { id: "w_sandbox", root, alias: "sandbox" };
}

test("sandbox defaults are explicit and off", () => {
  const sandbox = config().sandbox;
  assert.equal(sandbox.mode, "off");
  assert.equal(sandbox.backend, "auto");
  assert.equal(sandbox.network, "restricted");
  assert.equal(sandbox.fail_if_unavailable, true);
  assert.deepEqual(sandbox.extra_writable_roots, []);
  assert.deepEqual(sandbox.env_passthrough, []);
});

test("workspace_write protects control metadata while allowing agent artifact roots", () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-policy");
  const next = config();
  next.sandbox.mode = "workspace_write";
  const base = resolveSandboxPolicy({ config: next, workspace: workspace(root), cwd: root, command: "git status" });
  assert.deepEqual(base.writableRoots.slice(0, 2), [root, os.tmpdir()]);
  assert.ok(base.protectedWritePaths.includes(path.join(root, ".git")));
  assert.ok(base.protectedWritePaths.includes(path.join(root, ".inferoa")));
  assert.ok(base.protectedWritePaths.includes(path.join(root, ".inferoa", "config")));
  assert.ok(base.protectedWritePaths.includes(path.join(root, ".codex")));
  assert.ok(base.agentWritableRoots.includes(path.join(root, ".inferoa", "exports")));
  assert.ok(base.agentWritableRoots.includes(path.join(root, ".inferoa", "tmp")));

  const commit = resolveSandboxPolicy({ config: next, workspace: workspace(root), cwd: root, command: "git commit -m test" });
  assert.equal(commit.capabilities.includes("git_metadata_write"), true);
  assert.equal(commit.protectedWritePaths.includes(path.join(root, ".git")), false);
  assert.ok(commit.protectedWritePaths.includes(path.join(root, ".inferoa")));

  const hardReset = resolveSandboxPolicy({ config: next, workspace: workspace(root), cwd: root, command: "git reset --hard HEAD" });
  assert.equal(hardReset.capabilities.includes("git_metadata_write"), false);
  assert.ok(hardReset.protectedWritePaths.includes(path.join(root, ".git")));
});

test("backend generators encode write roots, protected metadata, and network restriction", () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-backend");
  const next = config();
  next.sandbox.mode = "workspace_write";
  const policy = resolveSandboxPolicy({ config: next, workspace: workspace(root), cwd: root, command: "echo hi" });

  const seatbelt = seatbeltPolicy(policy);
  assert.match(seatbelt, /\(deny file-write\*/);
  assert.match(seatbelt, new RegExp(`\\(require-not \\(subpath "${escapeRegExp(root)}"\\)\\)`));
  assert.match(seatbelt, new RegExp(`\\(deny file-write\\* \\(literal "${escapeRegExp(path.join(root, ".git"))}"\\)\\)`));
  assert.match(seatbelt, new RegExp(`\\(deny file-write\\* \\(subpath "${escapeRegExp(path.join(root, ".git"))}"\\)\\)`));
  assert.match(seatbelt, new RegExp(`\\(deny file-write\\* \\(subpath "${escapeRegExp(path.join(root, ".inferoa"))}"\\)\\)`));
  assert.match(seatbelt, new RegExp(`\\(allow file-write\\* \\(subpath "${escapeRegExp(path.join(root, ".inferoa", "exports"))}"\\)\\)`));
  assert.match(seatbelt, /\(allow file-read\* file-test-existence file-write-data[\s\S]*"\/dev\/null"[\s\S]*"\/dev\/zero"/);
  assert.match(seatbelt, /\(allow pseudo-tty\)/);
  assert.match(seatbelt, /\(deny network\*\)/);

  const bwrap = bubblewrapArgs(policy, ["/bin/sh", "-c", "echo hi"]);
  assert.ok(bwrap.includes("--proc"));
  assert.ok(bwrap.includes("--unshare-net"));
  assert.deepEqual(bwrap.slice(bwrap.indexOf("--bind"), bwrap.indexOf("--bind") + 3), ["--bind", root, root]);
  const gitIndex = bwrap.indexOf(path.join(root, ".git"));
  assert.equal(bwrap[gitIndex - 1], "--ro-bind");
  const inferoaIndex = bwrap.indexOf(path.join(root, ".inferoa"));
  assert.equal(bwrap[inferoaIndex - 1], "--ro-bind");
  const exportsBindIndex = bwrap.indexOf(path.join(root, ".inferoa", "exports"));
  assert.equal(bwrap[exportsBindIndex - 1], "--bind");
  const separator = bwrap.lastIndexOf("--");
  assert.deepEqual(bwrap.slice(separator), ["--", "/bin/sh", "-c", "echo hi"]);

  const fallbackBwrap = bubblewrapArgs(policy, ["/bin/sh", "-c", "echo hi"], undefined, { procMode: "readonly_bind" });
  const procIndex = fallbackBwrap.indexOf("/proc");
  assert.equal(fallbackBwrap[procIndex - 1], "--ro-bind");
  assert.equal(fallbackBwrap[procIndex + 1], "/proc");
});

test("linux protected metadata masks skip missing children already covered by a read-only parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inferoa-sandbox-bwrap-masks-"));
  try {
    await mkdir(path.join(root, ".inferoa", "exports"), { recursive: true });
    const next = config();
    next.sandbox.mode = "workspace_write";
    const policy = resolveSandboxPolicy({ config: next, workspace: workspace(root), cwd: root, command: "echo hi" });

    const mounts = await readOnlyMountsForPolicy(policy);
    assert.ok(mounts.some((mount) => mount.dest === path.join(root, ".inferoa")));
    assert.equal(mounts.some((mount) => mount.dest === path.join(root, ".inferoa", "config")), false);
    assert.ok(mounts.some((mount) => mount.dest === path.join(root, ".git")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner keeps env intact when sandbox is off", async () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-off");
  const env = { PATH: process.env.PATH ?? "", SECRET_TOKEN: "visible" };
  const planned = await planSandboxInvocation({
    config: config(),
    workspace: workspace(root),
    command: "node",
    args: ["-v"],
    shell: false,
    cwd: root,
    env,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.ok && planned.invocation.info.mode, "off");
  assert.equal(planned.ok && planned.invocation.info.backend, "none");
  assert.equal(planned.ok && planned.invocation.env.SECRET_TOKEN, "visible");
});

test("planner scrubs sensitive env when a sandbox mode is active", async () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-env");
  const next = config();
  next.sandbox.mode = "read_only";
  next.sandbox.backend = "none";
  next.sandbox.env_passthrough = ["SECRET_TOKEN"];
  const planned = await planSandboxInvocation({
    config: next,
    workspace: workspace(root),
    command: "node",
    args: ["-v"],
    shell: false,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      NORMAL_VALUE: "kept",
      OPENAI_API_KEY: "removed",
      SECRET_TOKEN: "kept-by-policy",
    },
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.ok && planned.invocation.env.NORMAL_VALUE, "kept");
  assert.equal(planned.ok && planned.invocation.env.OPENAI_API_KEY, undefined);
  assert.equal(planned.ok && planned.invocation.env.SECRET_TOKEN, "kept-by-policy");
});

test("planner infers sandbox capabilities from original commands after rewrites", async () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-original-command");
  const next = config();
  next.sandbox.mode = "workspace_write";
  next.sandbox.backend = "none";
  const planned = await planSandboxInvocation({
    config: next,
    workspace: workspace(root),
    command: "node",
    args: ["-e", "console.log('rewritten wrapper without git text')"],
    shell: false,
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    originalCommand: "git branch inferoa-sandbox-probe && git branch -D inferoa-sandbox-probe",
    rewrittenCommand: "node -e \"console.log('rewritten wrapper without git text')\"",
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.ok && planned.invocation.info.capabilities?.includes("git_metadata_write"), true);
  assert.equal(planned.ok && planned.invocation.info.suspected_subcommand, "branch");
});

test("runtime denial classifier does not treat sandbox text alone as a sandbox block", async () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-false-positive");
  const next = config();
  next.sandbox.mode = "workspace_write";
  next.sandbox.backend = "none";
  const result = await runSandboxedProcess({
    config: next,
    workspace: workspace(root),
    command: "/sandbox status",
    shell: true,
    cwd: root,
    timeoutMs: 5_000,
  });
  assert.equal(result.code, 127);
  assert.equal(result.sandbox.blocked, false);
  assert.equal(result.sandbox.policy_rule, undefined);
});

test("runtime denial classifier explains restricted network failures even when stderr is empty", () => {
  const root = path.join(os.tmpdir(), "inferoa-sandbox-network-classifier");
  const info: SandboxExecutionInfo = {
    backend: "linux_bubblewrap",
    mode: "workspace_write",
    network: "restricted",
    workspace_root: root,
    cwd: root,
    command: "node -e \"const net=require('node:net'); net.connect({host:'1.1.1.1',port:80})\"",
    blocked: false,
  };

  const classified = runtimeSandboxInfo(info, 1, "");
  assert.equal(classified.blocked, true);
  assert.equal(classified.policy_rule, "network_restricted");
  assert.equal(classified.reason, "Network is restricted inside the sandbox.");

  const noBackend = runtimeSandboxInfo({ ...info, backend: "none" }, 1, "");
  assert.equal(noBackend.blocked, false);
  assert.equal(noBackend.policy_rule, undefined);
});

test("git capability inference only upgrades non-dangerous metadata commands", () => {
  assert.deepEqual(inferCapabilities("git status --short"), []);
  assert.deepEqual(inferCapabilities("git commit -m test"), ["git_metadata_write"]);
  assert.deepEqual(inferCapabilities("git -C repo branch feature"), ["git_metadata_write"]);
  assert.deepEqual(inferCapabilities("git reset --hard HEAD"), []);
  assert.deepEqual(inferCapabilities("git clean -fd"), []);
});

test("native OS sandbox probes pass on supported hosts", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox probes are only defined for macOS and Linux");
    return;
  }
  const backend = process.platform === "darwin" ? new MacosSeatbeltBackend() : new LinuxBubblewrapBackend();
  const availability = await backend.available();
  if (!availability.available) {
    if (process.platform === "linux") {
      const root = await mkdtemp(path.join(os.tmpdir(), "inferoa-sandbox-missing-bwrap-"));
      try {
        const next = config();
        next.sandbox.mode = "workspace_write";
        next.sandbox.backend = "linux_bubblewrap";
        const result = await runSandboxedProcess({
          config: next,
          workspace: workspace(root),
          command: "true",
          shell: true,
          cwd: root,
          timeoutMs: 5_000,
        });
        assert.equal(result.code, 126);
        assert.equal(result.sandbox.blocked, true);
        assert.equal(result.sandbox.block_stage, "backend_setup");
        assert.equal(result.sandbox.policy_rule, "sandbox_backend_unavailable");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      return;
    }
    t.skip(availability.reason ?? "native sandbox backend unavailable");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "inferoa-sandbox-native-"));
  const external = path.join(os.homedir(), `.inferoa-sandbox-native-${Date.now()}`);
  try {
    const repoSetup = await runSandboxedProcess({
      config: config(),
      workspace: workspace(root),
      command: "git init . && git -c user.name=Inferoa -c user.email=inferoa@example.com commit --allow-empty -m init",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(repoSetup.code, 0, repoSetup.stderr);

    const next = config();
    next.sandbox.mode = "workspace_write";
    next.sandbox.backend = process.platform === "darwin" ? "macos_seatbelt" : "linux_bubblewrap";
    next.sandbox.network = "restricted";

    const platformPlumbing = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "cat /dev/null && : > /dev/null && f=\"$(mktemp -t inferoa-sandbox.XXXXXX)\" && printf ok > \"$f\" && cat \"$f\" && rm -f \"$f\"",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(platformPlumbing.code, 0, platformPlumbing.stderr);
    assert.equal(platformPlumbing.stdout.trim(), "ok");
    assert.equal(platformPlumbing.sandbox.blocked, false);

    const writeWorkspace = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: `printf ok > ${shellQuote(path.join(root, "ok.txt"))}`,
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(writeWorkspace.code, 0, writeWorkspace.stderr);
    assert.equal(writeWorkspace.sandbox.blocked, false);

    const nodeWriteWorkspace = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "node-ok.txt"))}, 'ok')`],
      shell: false,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(nodeWriteWorkspace.code, 0, nodeWriteWorkspace.stderr);
    assert.equal(nodeWriteWorkspace.sandbox.blocked, false);

    const writeInferoaArtifact = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "printf ok > .inferoa/exports/result.txt && printf ok > .inferoa/tmp/work.txt && cat .inferoa/exports/result.txt",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(writeInferoaArtifact.code, 0, writeInferoaArtifact.stderr);
    assert.equal(writeInferoaArtifact.stdout.trim(), "ok");
    assert.equal(writeInferoaArtifact.sandbox.blocked, false);

    const writeExternal = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: `printf no > ${shellQuote(external)}`,
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(writeExternal.code, 0);
    assert.equal(writeExternal.sandbox.blocked, true);
    assert.equal(writeExternal.sandbox.policy_rule, "outside_workspace_write");

    const writeGit = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: `printf no > ${shellQuote(path.join(root, ".git", "blocked"))}`,
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(writeGit.code, 0);
    assert.equal(writeGit.sandbox.blocked, true);
    assert.equal(writeGit.sandbox.policy_rule, "git_metadata_requires_capability");

    const writeInferoaConfig = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "printf no > .inferoa/config.yaml",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(writeInferoaConfig.code, 0);
    assert.equal(writeInferoaConfig.sandbox.blocked, true);
    assert.equal(writeInferoaConfig.sandbox.policy_rule, "protected_metadata_write");

    const writeInferoaUnknown = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "printf no > .inferoa/unknown.txt",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(writeInferoaUnknown.code, 0);
    assert.equal(writeInferoaUnknown.sandbox.blocked, true);
    assert.equal(writeInferoaUnknown.sandbox.policy_rule, "protected_metadata_write");

    const writeGitWithCapability = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: `printf ok > ${shellQuote(path.join(root, ".git", "allowed"))}`,
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
      capabilities: ["git_metadata_write"],
    });
    assert.equal(writeGitWithCapability.code, 0, writeGitWithCapability.stderr);
    assert.equal(writeGitWithCapability.sandbox.blocked, false);

    const gitBranchWithInferredCapability = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "git branch inferoa-sandbox-probe && git branch -D inferoa-sandbox-probe",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.equal(gitBranchWithInferredCapability.code, 0, gitBranchWithInferredCapability.stderr);
    assert.equal(gitBranchWithInferredCapability.sandbox.blocked, false);

    const gitBranchWithRewrittenMetadata = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: "git branch inferoa-sandbox-probe-rewritten && git branch -D inferoa-sandbox-probe-rewritten",
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
      originalCommand: "git branch inferoa-sandbox-probe-rewritten && git branch -D inferoa-sandbox-probe-rewritten",
      rewrittenCommand: "node -e \"console.log('rtk wrapper without git text')\"",
    });
    assert.equal(gitBranchWithRewrittenMetadata.code, 0, gitBranchWithRewrittenMetadata.stderr);
    assert.equal(gitBranchWithRewrittenMetadata.sandbox.blocked, false);
    assert.equal(gitBranchWithRewrittenMetadata.sandbox.capabilities?.includes("git_metadata_write"), true);

    const symlinkEscape = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: `ln -s ${shellQuote(external)} sandbox-link-out && printf no > sandbox-link-out`,
      shell: true,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(symlinkEscape.code, 0);
    assert.equal(symlinkEscape.sandbox.blocked, true);

    const network = await runSandboxedProcess({
      config: next,
      workspace: workspace(root),
      command: process.execPath,
      args: ["-e", "const net=require('node:net'); const s=net.connect({host:'1.1.1.1',port:80,timeout:500}); s.on('connect',()=>process.exit(0)); s.on('error',(e)=>{console.error(e.code||e.message); process.exit(1);}); s.on('timeout',()=>process.exit(2));"],
      shell: false,
      cwd: root,
      timeoutMs: 8_000,
    });
    assert.notEqual(network.code, 0);
    assert.equal(network.sandbox.blocked, true);
    assert.equal(network.sandbox.policy_rule, "network_restricted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
