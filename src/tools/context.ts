import type { ClarifyRequest, ClarifyResponse, JsonObject, ModelRequest, ToolResult, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { SessionStore } from "../session/store.js";

export interface ToolExecutionContext {
  config: VllmAgentConfig;
  workspace: WorkspaceIdentity;
  session_id: string;
  run_id?: string;
  step_id?: string;
  step_index?: number;
  request_class?: ModelRequest["request_class"];
  visibility?: "normal" | "internal";
  tool_call_id?: string;
  tool_name?: string;
  control_plane?: boolean;
  store: SessionStore;
  clarify?: (request: ClarifyRequest) => Promise<ClarifyResponse>;
}

export type ToolHandler = (args: JsonObject, context: ToolExecutionContext) => Promise<ToolResult>;
