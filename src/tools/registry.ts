import type { JsonObject, ToolCall, ToolDefinition, ToolResult, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { CodeIntelligenceHub } from "../code-intelligence/hub.js";
import { SessionStore } from "../session/store.js";
import { fail, truncateText } from "../util/limit.js";
import { PermissionPolicy } from "./permissions.js";
import { configuredToolDefinitions } from "./schemas.js";
import type { ToolExecutionContext, ToolHandler } from "./context.js";
import {
  applyPatchTool,
  completeStep,
  editFile,
  exportResource,
  fileSearch,
  gitDiff,
  gitShow,
  gitStatus,
  globPaths,
  listDir,
  readFile,
  readResource,
  sessionNote,
  todoWrite,
  writeFile,
} from "./workspace-tools.js";
import { readProcess, runCommand, stopProcess, writeProcess } from "./process-tools.js";
import { astEdit, astGrep, lspRenameTool, lspTool } from "./code-intelligence.js";
import { webOpen, webSearch } from "./web-search.js";
import { skillDisable, skillEnable, skillList, skillRead } from "./skill-tools.js";
import { goalTool } from "./goal-tools.js";
import { planTool } from "./plan-tools.js";
import { clarifyTool } from "./clarify-tool.js";
import { subagentTool } from "./subagent-tool.js";
import { validateToolArguments } from "./schema-validation.js";
import { initExperiment, logExperiment, runExperiment, updateExperiment, updateNotes } from "./autoresearch-tools.js";
import {
  audioGeneration,
  audioUnderstanding,
  imageEdit,
  imageGeneration,
  speechGeneration,
  speechVoices,
  videoGeneration,
  videoUnderstanding,
  visionUnderstanding,
} from "./omni-tools.js";

const HANDLERS: Record<string, ToolHandler> = {
  apply_patch: applyPatchTool,
  ast_edit: astEdit,
  ast_grep: astGrep,
  audio_generation: audioGeneration,
  audio_understanding: audioUnderstanding,
  clarify: clarifyTool,
  complete_step: completeStep,
  edit_file: editFile,
  export_resource: exportResource,
  file_search: fileSearch,
  git_diff: gitDiff,
  git_show: gitShow,
  git_status: gitStatus,
  glob: globPaths,
  goal: goalTool,
  image_edit: imageEdit,
  image_generation: imageGeneration,
  init_experiment: initExperiment,
  list_dir: listDir,
  log_experiment: logExperiment,
  lsp: lspTool,
  lsp_rename: lspRenameTool,
  plan: planTool,
  read_file: readFile,
  read_process: readProcess,
  read_resource: readResource,
  run_command: runCommand,
  run_experiment: runExperiment,
  session_note: sessionNote,
  skill_disable: skillDisable,
  skill_enable: skillEnable,
  skill_list: skillList,
  skill_read: skillRead,
  stop_process: stopProcess,
  subagent: subagentTool,
  speech_generation: speechGeneration,
  speech_voices: speechVoices,
  todo_write: todoWrite,
  update_notes: updateNotes,
  update_experiment: updateExperiment,
  video_generation: videoGeneration,
  video_understanding: videoUnderstanding,
  vision_understanding: visionUnderstanding,
  web_open: webOpen,
  web_search: webSearch,
  write_file: writeFile,
  write_process: writeProcess,
};

export class ToolRegistry {
  private readonly policy: PermissionPolicy;

  constructor(
    private readonly config: VllmAgentConfig,
    private readonly workspace: WorkspaceIdentity,
    private readonly store: SessionStore,
    private readonly codeIntelligence: CodeIntelligenceHub = new CodeIntelligenceHub(config, workspace),
  ) {
    this.policy = new PermissionPolicy(config, workspace);
  }

  list(): ToolDefinition[] {
    return [...configuredToolDefinitions(this.config), ...this.codeIntelligence.toolDefinitions()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(
    call: ToolCall,
    context: {
      session_id: string;
      run_id?: string;
      step_id?: string;
      step_index?: number;
      request_class?: ToolExecutionContext["request_class"];
      visibility?: ToolExecutionContext["visibility"];
      control_plane?: boolean;
      clarify?: ToolExecutionContext["clarify"];
    },
  ): Promise<ToolResult> {
    const definition = this.list().find((tool) => tool.name === call.name);
    if (!definition) {
      const result = fail("unknown_tool", `Unknown tool: ${call.name}`);
      this.recordCall(context, call);
      this.recordResult(context, call, result);
      return result;
    }
    this.recordCall(context, call);
    if (!context.control_plane) {
      const invalidArguments = validateToolArguments(definition, call.arguments);
      if (invalidArguments) {
        this.recordResult(context, call, invalidArguments);
        return invalidArguments;
      }
    }
    const decision = this.policy.decide(definition, call.arguments, { request_class: context.request_class });
    if (decision.status !== "allow") {
      this.store.appendEvent({
        session_id: context.session_id,
        run_id: context.run_id,
        type: decision.status === "ask" ? "permission.requested" : "permission.denied",
        data: {
          tool_call_id: call.id,
          tool_name: call.name,
          step_id: context.step_id,
          step_index: context.step_index,
          request_class: context.request_class,
          visibility: context.visibility,
          decision: decision as unknown as JsonObject,
          arguments: call.arguments,
        },
      });
      const blocked = fail(
        decision.status === "ask" ? "permission_required" : "permission_denied",
        `Tool ${call.name} blocked: ${decision.reason}`,
      );
      this.store.appendEvent({
        session_id: context.session_id,
        run_id: context.run_id,
        type: "tool.result",
        data: {
          tool_call_id: call.id,
          tool_name: call.name,
          step_id: context.step_id,
          step_index: context.step_index,
          request_class: context.request_class,
          visibility: context.visibility,
          result: blocked as unknown as JsonObject,
        },
      });
      return blocked;
    }
    this.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "permission.resolved",
      data: {
        tool_call_id: call.id,
        tool_name: call.name,
        step_id: context.step_id,
        step_index: context.step_index,
        request_class: context.request_class,
        visibility: context.visibility,
        decision: decision as unknown as JsonObject,
        arguments: call.arguments,
      },
    });
    const execContext: ToolExecutionContext = {
      config: this.config,
      workspace: this.workspace,
      session_id: context.session_id,
      run_id: context.run_id,
      step_id: context.step_id,
      step_index: context.step_index,
      request_class: context.request_class,
      visibility: context.visibility,
      control_plane: context.control_plane,
      tool_call_id: call.id,
      tool_name: call.name,
      store: this.store,
      clarify: context.clarify,
    };
    let result: ToolResult;
    try {
      if (this.codeIntelligence.handlesTool(call.name)) {
        result = await this.codeIntelligence.callTool(call.name, call.arguments);
      } else {
        const handler = HANDLERS[call.name];
        if (!handler) {
          result = fail("tool_not_implemented", `Tool schema exists but handler is not implemented: ${call.name}`);
        } else {
          result = await handler(call.arguments, execContext);
        }
      }
    } catch (error) {
      result = fail("tool_exception", error instanceof Error ? error.message : String(error));
    }
    const serialized = JSON.stringify(result);
    if (serialized.length > 30_000 && !result.resource_uri) {
      const resource = this.store.putResource(context.session_id, `tool.${call.name}.result`, serialized, {
        tool_name: call.name,
        tool_call_id: call.id,
      });
      const truncated = truncateText(serialized, 12_000);
      result = {
        ok: result.ok,
        summary: result.summary,
        data: { truncated_result: truncated.text },
        resource_uri: resource.uri,
        error: result.error,
      };
    }
    this.recordResult(context, call, result);
    return result;
  }

  private recordCall(
    context: {
      session_id: string;
      run_id?: string;
      step_id?: string;
      step_index?: number;
      request_class?: ToolExecutionContext["request_class"];
      visibility?: ToolExecutionContext["visibility"];
    },
    call: ToolCall,
  ): void {
    this.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "tool.call",
      data: {
        tool_call_id: call.id,
        tool_name: call.name,
        step_id: context.step_id,
        step_index: context.step_index,
        request_class: context.request_class,
        visibility: context.visibility,
        arguments: call.arguments,
      },
    });
  }

  private recordResult(
    context: {
      session_id: string;
      run_id?: string;
      step_id?: string;
      step_index?: number;
      request_class?: ToolExecutionContext["request_class"];
      visibility?: ToolExecutionContext["visibility"];
    },
    call: ToolCall,
    result: ToolResult,
  ): void {
    this.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "tool.result",
      data: {
        tool_call_id: call.id,
        tool_name: call.name,
        step_id: context.step_id,
        step_index: context.step_index,
        request_class: context.request_class,
        visibility: context.visibility,
        result: result as unknown as JsonObject,
      },
    });
  }
}
