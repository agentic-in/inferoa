import path from "node:path";
import { base32UrlSha256 } from "../util/hash.js";
import { findGitRoot, pathExists, realpathOrResolve } from "../util/fs.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../types.js";

export async function resolveWorkspace(cwd: string, config: VllmAgentConfig, explicit?: string): Promise<WorkspaceIdentity> {
  const cwdGitRoot = await findGitRoot(cwd);
  const raw = explicit ?? config.workspace?.root ?? cwdGitRoot ?? cwd;
  const root = await realpathOrResolve(path.resolve(cwd, raw));
  const workspaceGitRoot = (await pathExists(root)) ? await findGitRoot(root) : undefined;
  const gitRoot = workspaceGitRoot ? await realpathOrResolve(workspaceGitRoot) : undefined;
  const digest = base32UrlSha256(`inferoa:workspace:v1\0${root}`, 20);
  return {
    root,
    id: `w_${digest}`,
    alias: path.basename(root) || root,
    gitRoot,
  };
}
