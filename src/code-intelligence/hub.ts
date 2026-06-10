import type { JsonObject, ToolDefinition, ToolResult, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { LSP_REGISTRY } from "../tools/code-intelligence.js";
import {
  CodeGraphContextEngine,
  normalizeContextEngineConfig,
  type ContextEngineListener,
  type ContextEngineStatus,
} from "./codegraph-engine.js";

export interface CodeIntelligenceStatus {
  state: "ready" | "indexing" | "syncing" | "degraded" | "off";
  codegraph: ContextEngineStatus;
  lsp: {
    state: "ready";
    languages: Array<{ id: string; fallback_adapter?: string; commands: string[] }>;
  };
  ast: {
    state: "ready";
    languages: string[];
  };
}

export class CodeIntelligenceHub {
  private readonly codegraph: CodeGraphContextEngine;

  constructor(
    private readonly config: VllmAgentConfig,
    private readonly workspace: WorkspaceIdentity,
  ) {
    this.codegraph = new CodeGraphContextEngine(normalizeContextEngineConfig(config), workspace, config);
  }

  dispose(): void {
    this.codegraph.dispose();
  }

  handlesTool(name: string): boolean {
    return this.codegraph.handlesTool(name);
  }

  onStatus(listener: ContextEngineListener): () => void {
    return this.codegraph.onStatus(listener);
  }

  requireReadyBeforeChat(): boolean {
    return this.codegraph.requireReadyBeforeChat();
  }

  shouldStartOnWelcome(): boolean {
    return this.codegraph.shouldStartOnWelcome();
  }

  startIndexing(reason: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ContextEngineStatus> {
    return this.codegraph.startIndexing(reason, options);
  }

  status(): CodeIntelligenceStatus {
    const codegraph = this.codegraph.status();
    return {
      state: aggregateState(codegraph.state),
      codegraph,
      lsp: {
        state: "ready",
        languages: LSP_REGISTRY.map((spec) => ({
          id: spec.id,
          fallback_adapter: spec.fallback_adapter,
          commands: spec.commands,
        })),
      },
      ast: {
        state: "ready",
        languages: ["typescript", "javascript", "tsx", "jsx", "python"],
      },
    };
  }

  toolDefinitions(): ToolDefinition[] {
    return this.codegraph.toolDefinitions();
  }

  async waitUntilReadyBeforeChat(signal?: AbortSignal): Promise<ContextEngineStatus> {
    return await this.codegraph.waitUntilReady("chat_gate", signal);
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<ToolResult> {
    return await this.codegraph.callTool(name, args, signal);
  }
}

function aggregateState(state: ContextEngineStatus["state"]): CodeIntelligenceStatus["state"] {
  if (state === "off" || state === "idle") {
    return state === "off" ? "off" : "indexing";
  }
  return state;
}
