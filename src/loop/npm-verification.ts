import { readGoalState } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { runSmallCommand } from "../util/fs.js";
import { randomId } from "../util/hash.js";
import type { GoalLoopVerification, GoalLoopVerificationConfidence, GoalLoopVerificationVerdict } from "./types.js";
import { recordGoalVerification } from "./verification.js";

export interface VerifyNpmPackageStatusOptions {
  session_id: string;
  package_name: string;
  version: string;
  tag?: string;
  timeout_ms?: number;
  run_id?: string;
}

interface NpmPackageStatus {
  versions: string[];
  dist_tags: Record<string, string>;
}

const DEFAULT_NPM_VERIFIER_TIMEOUT_MS = 30_000;

export async function verifyNpmPackageStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyNpmPackageStatusOptions,
): Promise<GoalLoopVerification> {
  const packageName = parseNpmPackageName(options.package_name);
  const version = parseNpmVersion(options.version);
  const tag = options.tag === undefined ? undefined : parseNpmDistTag(options.tag);
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_npm_package");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "npm",
      role: "npm-package-status",
      package_name: packageName,
      version,
      tag,
    },
  });

  const result = await runSmallCommand(
    "npm",
    ["view", packageName, "versions", "dist-tags", "--json"],
    workspace.root,
    options.timeout_ms ?? DEFAULT_NPM_VERIFIER_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    return recordNpmPackageStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      package_name: packageName,
      version,
      tag,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `npm package metadata could not be read for ${packageName}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `npm view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordNpmPackageStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      package_name: packageName,
      version,
      tag,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `npm package metadata returned invalid JSON for ${packageName}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }

  const status = parseNpmPackageStatus(parsed);
  if (!status) {
    return recordNpmPackageStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      package_name: packageName,
      version,
      tag,
      exit_code: result.code,
      summary: `npm package metadata returned a non-object payload for ${packageName}.`,
      failure_reason: "npm view <package> versions dist-tags --json must return a JSON object.",
    });
  }

  const versionPresent = status.versions.includes(version);
  const actualTaggedVersion = tag ? status.dist_tags[tag] : undefined;
  const tagMatches = tag ? actualTaggedVersion === version : undefined;
  const verdict = versionPresent && (tagMatches ?? true) ? "pass" : "fail";
  return recordNpmPackageStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    verdict,
    confidence: "hard",
    package_name: packageName,
    version,
    tag,
    exit_code: result.code,
    npm_status: status,
    summary: npmPackageStatusSummary(packageName, version, tag, versionPresent, actualTaggedVersion, verdict),
    failure_reason: verdict === "pass" ? undefined : npmPackageStatusFailureReason(packageName, version, tag, versionPresent, actualTaggedVersion),
  });
}

function recordNpmPackageStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number | undefined,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    package_name: string;
    version: string;
    tag?: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    npm_status?: NpmPackageStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  const versions = input.npm_status?.versions ?? [];
  const tagVersion = input.tag && input.npm_status ? input.npm_status.dist_tags[input.tag] : undefined;
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    verifier_role: "npm-package-status",
    evidence: {
      connector: "npm",
      verifier: "npm-package-status",
      package_name: input.package_name,
      version: input.version,
      tag: input.tag,
      tag_version: tagVersion,
      version_present: versions.includes(input.version),
      tag_match: input.tag ? tagVersion === input.version : undefined,
      version_count: versions.length,
      dist_tags: input.npm_status?.dist_tags,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
    } satisfies JsonObject,
    metrics: {
      version_present: versions.includes(input.version) ? 1 : 0,
      tag_match: input.tag ? (tagVersion === input.version ? 1 : 0) : undefined,
      version_count: versions.length,
      exit_code: input.exit_code,
    } satisfies JsonObject,
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function parseNpmPackageStatus(value: unknown): NpmPackageStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const versions = Array.isArray(object.versions)
    ? object.versions.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const tags = object["dist-tags"];
  const distTags: Record<string, string> = {};
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    for (const [key, tagValue] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof tagValue === "string" && tagValue.trim()) {
        distTags[key] = tagValue.trim();
      }
    }
  }
  return { versions, dist_tags: distTags };
}

function npmPackageStatusSummary(
  packageName: string,
  version: string,
  tag: string | undefined,
  versionPresent: boolean,
  actualTaggedVersion: string | undefined,
  verdict: GoalLoopVerificationVerdict,
): string {
  if (verdict === "pass") {
    return tag
      ? `${packageName}@${version} is published and dist-tag ${tag} points to it.`
      : `${packageName}@${version} is published.`;
  }
  if (!versionPresent) {
    return `${packageName}@${version} is not present in npm package metadata.`;
  }
  return `npm dist-tag ${tag} points to ${actualTaggedVersion ?? "nothing"} instead of ${version}.`;
}

function npmPackageStatusFailureReason(
  packageName: string,
  version: string,
  tag: string | undefined,
  versionPresent: boolean,
  actualTaggedVersion: string | undefined,
): string {
  if (!versionPresent) {
    return `${packageName}@${version} is missing from npm versions.`;
  }
  return `dist-tag ${tag} points to ${actualTaggedVersion ?? "nothing"} instead of ${version}.`;
}

function parseNpmPackageName(value: string): string {
  const packageName = value.trim();
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
    throw new Error("npm package verifier requires a package name such as inferoa or @scope/name.");
  }
  return packageName;
}

function parseNpmVersion(value: string): string {
  const version = value.trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("npm package verifier requires an exact package version such as 1.2.3 or 1.2.3-beta.1.");
  }
  return version;
}

function parseNpmDistTag(value: string): string {
  const tag = value.trim();
  if (!tag || tag.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error("--tag must be an npm dist-tag such as latest or beta");
  }
  return tag;
}
