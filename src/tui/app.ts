import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { endpointApiKey, saveUserConfig, userConfigPath } from "../config/config.js";
import { readSecret, secretRef, writeSecret } from "../config/secret-vault.js";
import { EndpointSignals } from "../model/endpoint-signals.js";
import { authHeaders } from "../model/endpoint-signals.js";
import {
  discoverExternalProviderStates,
  externalProviderById,
  externalProviderRequiresApiKey,
  externalProviderSetupOptions,
  probeExternalProviderModels,
  type ExternalProviderDefinition,
  type ExternalProviderSetupOption,
  type ExternalProviderState,
} from "../model/providers.js";
import { resolveRtkStatus, type RtkStatus } from "../rtk/manager.js";
import { staticOmniCapabilityMatrix } from "../model/omni-capabilities.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry, type SkillDescriptor } from "../skills/registry.js";
import { attachDaemonJob, cancelDaemonJob, daemonStatus, detachDaemonJob, queueDaemonRun, startDaemon } from "../daemon/supervisor.js";
import type { RuntimeStatusEvent } from "../runtime.js";
import { runFinalAcceptance } from "../validation/acceptance.js";
import {
  attachGoalPlanSnapshot,
  cloneGoalState,
  createGoalState,
  incompleteGoalPlanningMessage,
  goalPlanningProgressSummary,
  readGoalState,
  recordGoalCompletionReport,
  validateTokenBudget,
  writeGoalState,
  type GoalRecord,
  type GoalState,
} from "../goals/state.js";
import { readAutoresearchState, setAutoresearchMode, summarizeAutoresearchProgress, type AutoresearchState } from "../autoresearch/state.js";
import { clonePlanState, createPlanState, planApprovalBlockMessage, readPlanState, writePlanState, type PlanState } from "../plans/state.js";
import type {
  ClarifyRequest,
  ClarifyResponse,
  EndpointSignalSnapshot,
  JsonObject,
  ModelSetup,
  ModelUsage,
  OmniCapabilityStatus,
  OmniEndpointName,
  OmniEndpointConfig,
  PermissionMode,
  SessionEvent,
  SessionRecord,
  VllmAgentConfig,
  WorkspaceIdentity,
} from "../types.js";
import type { SupervisorJob } from "../session/store.js";
import { randomId } from "../util/hash.js";
import { isAbortError } from "../util/abort.js";
import type { loadApp } from "../app.js";
import { ansi, bgLine, bg256, center, centerBlock, fg256, frame, padRight, terminalHeight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { parseSlashCommand, slashCommandWithSubcommands, slashSubcommands, SLASH_COMMANDS, type SlashCommandName } from "./slash.js";
import { renderActivityLine, renderActivityRecordLine } from "./activity.js";
import { cacheTurnKind, formatDuration, renderCacheFooter, renderCacheReportTurn } from "./cache-footer.js";
import { renderCompactEventLine, renderSessionActivityLines, renderTodoEventLines } from "./event-view.js";
import { renderModeMetadataRight } from "./mode-footer.js";
import { renderPlanDocumentSurface } from "./plan-view.js";
import { renderRtkSessionLines } from "./rtk-view.js";
import { composerEraseRowsForResize } from "./resize.js";
import { RESUME_SESSION_PAGE_SIZE, resumeSessionPage } from "./session-picker.js";
import { filterProviderPickerOptions, providerPickerPage } from "./provider-picker.js";
import { renderSessionTranscript } from "./session-transcript.js";
import { renderUnknownSlashCommandNotice } from "./slash-notice.js";
import { effectiveWorkspacePermission, setWorkspacePermissionMode } from "../tools/permissions.js";
import { renderToolCards } from "./tool-renderer.js";
import { withConversationGap } from "./transcript-spacing.js";
import { MarkdownStreamRenderer } from "./markdown.js";
import { renderHomeFrame } from "./home.js";
import {
  backspaceComposer,
  adjustComposerCompactRanges,
  compactRangeBeforeCursor,
  composerPlainPasteFallback,
  insertComposerPaste,
  insertComposerText,
  moveComposerCursorEnd,
  moveComposerCursorHome,
  moveComposerCursorLeft,
  moveComposerCursorRight,
  type ComposerPanel,
  type ComposerCompactRange,
  compactModelLabel,
  normalizeComposerPastedInput,
  renderComposerActivityLine,
  renderComposerSurface,
  renderWelcomeComposerSurface,
} from "./composer.js";
import {
  createPromptQueueState,
  enqueuePromptForSubmission,
  promptQueuePreviewLines,
  shiftPromptForSubmission,
  type PromptQueueState,
} from "./prompt-queue.js";
import { applyClarifyInputToken, createClarifyInputState, renderClarifyComposerPanel } from "./clarify.js";
import type { ContextEngineStatus } from "../code-intelligence/codegraph-engine.js";

type LoadedApp = Awaited<ReturnType<typeof loadApp>>;
type ProviderChoice = "direct" | "auto" | "external";
type WebSearchProviderChoice = VllmAgentConfig["web_search"]["provider"];
type SkillAction = "list" | "manage";
type SessionAction = "resume" | "new" | "rename" | "archive" | "all";
type JobAction = "status" | "queue" | "attach" | "detach" | "cancel";
type ToolTraceMode = "compact" | "expanded";

interface EndpointProbeResult {
  models: string[];
  errors: string[];
}

interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export interface TuiLaunchOptions {
  initialPrompt?: string;
  initialView?: SlashCommandName;
  stateDir?: string;
  noAnimation?: boolean;
}

interface ChatTurnEvidence {
  usage?: ModelUsage;
  requestId?: string;
  responseId?: string;
  model?: string;
  mode?: string;
}

interface ApiKeySelection {
  api_key_ref?: string;
}

interface ComposerItem {
  value: string;
  label: string;
  description: string;
  kind: "command" | "skill";
}

interface ActivityIndicator {
  status(label: string): void;
  record(line: string): void;
  pauseForOutput(options?: { redraw?: boolean }): void;
  stop(options?: { redraw?: boolean }): void;
}

interface ReadComposerOptions {
  placeholder?: string;
  initialBuffer?: string;
  suggestions?: boolean;
}

const CLEAR_TO_END = "\x1b[J";
const CLEAR_LINE = "\x1b[2K";
const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PASTE_TOKEN_PREFIX = "\u{e000}paste:";
const SETUP_TOTAL_STEPS = 7;

export const TUI_OMNI_SETUP_CAPABILITIES: Array<{
  name: OmniEndpointName;
  label: string;
  requiredForAcceptance: boolean;
}> = [
  { name: "vision", label: "Vision understanding", requiredForAcceptance: true },
  { name: "image_generation", label: "Image generation", requiredForAcceptance: true },
  { name: "image_edit", label: "Image edit", requiredForAcceptance: false },
  { name: "video_understanding", label: "Video understanding", requiredForAcceptance: false },
  { name: "video_generation", label: "Video generation", requiredForAcceptance: true },
  { name: "audio_understanding", label: "Audio understanding", requiredForAcceptance: false },
  { name: "audio_generation", label: "Audio generation", requiredForAcceptance: false },
  { name: "speech", label: "Speech generation and voices", requiredForAcceptance: false },
];
export const PREFIX_CACHE_REPORT_TITLE = "Prefix Cache Report";

export class TuiApp {
  #sessionId: string | undefined;
  #rl: Interface | undefined;
  #running = true;
  #inlineMode = false;
  #inlineRenderedLines = 0;
  #inlinePanelStartRow: number | undefined;
  #toolTraceMode: ToolTraceMode = "compact";
  #composerFooter: string | undefined;
  #composerActivity: string | undefined;
  #composerQueue: string[] | undefined;
  #composerPanel: ComposerPanel | undefined;
  #inputModalActive = false;
  #hasTranscript = false;
  #activeComposerErase: (() => void) | undefined;
  #activeComposerRedraw: (() => void) | undefined;
  #activeComposerActivityRedraw: (() => boolean) | undefined;
  #activeWelcomeCodeIntelligenceRedraw: (() => boolean) | undefined;
  #promptQueue: PromptQueueState = createPromptQueueState();
  #promptWorker: Promise<void> | undefined;
  #promptWorkerScheduled = false;
  #activeAbort: AbortController | undefined;
  #welcomeCodeIntelligenceStarted = false;
  #welcomeCodeIntelligenceStop: (() => void) | undefined;
  #shutdownStarted = false;

  constructor(
    private readonly app: LoadedApp,
    private readonly options: TuiLaunchOptions = {},
  ) {}

  async run(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY) {
      this.renderNonInteractiveNotice();
      return;
    }
    stdout.write(ansi.hideCursor);
    try {
      this.renderHome();
      this.startWelcomeCodeIntelligenceIndexing();
      if (this.options.initialView) {
        await this.openView(this.options.initialView, "");
      }
      if (this.options.initialPrompt) {
        this.enqueuePrompt(this.options.initialPrompt);
      }
      await this.loop();
    } finally {
      await this.shutdownBackgroundWork("TUI closed");
      this.#rl?.close();
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      stdout.write(ansi.showCursor);
      stdout.write("\n");
    }
  }

  private renderNonInteractiveNotice(): void {
    console.error("inferoa TUI requires an interactive terminal. Use `inferoa --print \"prompt\"` for non-interactive runs.");
  }

  private async loop(): Promise<void> {
    while (this.#running) {
      const text = (await this.readComposer()).trim();
      if (!text) {
        continue;
      }
      if (text === "/" || text.startsWith("/ ")) {
        try {
          const command = await this.chooseSlashCommand(text.slice(1).trim());
          await this.openView(command, "");
        } catch (error) {
          this.handleViewError(error);
        }
        continue;
      }
      if (text === "$" || text.startsWith("$ ")) {
        try {
          await this.renderSkillLauncher(text.slice(1).trim());
        } catch (error) {
          this.handleViewError(error);
        }
        continue;
      }
      const parsed = parseSlashCommand(text);
      if (parsed.error) {
        this.renderUnknownSlashCommand(text);
        continue;
      }
      if (parsed.command) {
        try {
          await this.openView(parsed.command.name, parsed.args);
        } catch (error) {
          this.handleViewError(error);
        }
        continue;
      }
      this.enqueuePrompt(text);
    }
  }

  private enqueuePrompt(prompt: string, options: { renderPrompt?: boolean } = {}): void {
    const busy = Boolean(this.#activeAbort || this.#promptWorker || this.#promptWorkerScheduled || this.promptRequiresCodeIntelligenceGate());
    this.#composerFooter = undefined;
    const queued = enqueuePromptForSubmission(this.#promptQueue, prompt, { busy, renderPrompt: options.renderPrompt });
    this.#promptQueue = queued.state;
    if (queued.renderSubmittedPromptNow) {
      this.renderSubmittedPrompt(prompt);
    }
    if (busy) {
      this.updateQueueFooter();
    }
    this.schedulePromptWorker();
  }

  private schedulePromptWorker(): void {
    if (this.#promptWorker || this.#promptWorkerScheduled) {
      return;
    }
    this.#promptWorkerScheduled = true;
    setTimeout(() => {
      this.#promptWorkerScheduled = false;
      if (this.#promptWorker || !this.#promptQueue.length || !this.#running) {
        return;
      }
      this.#promptWorker = this.drainPromptQueue()
        .catch((error) => {
          this.writeTranscript(`\n${fg256(203, error instanceof Error ? error.message : String(error))}\n\n`);
        })
        .finally(() => {
          this.#promptWorker = undefined;
          if (this.#promptQueue.length && this.#running) {
            this.schedulePromptWorker();
          } else if (!this.#activeAbort) {
            this.clearQueueFooter();
          }
        });
    }, 0);
  }

  private async drainPromptQueue(): Promise<void> {
    while (this.#promptQueue.length && this.#running) {
      const next = shiftPromptForSubmission(this.#promptQueue);
      this.#promptQueue = next.state;
      const item = next.item;
      if (!item) {
        continue;
      }
      this.updateQueueFooter();
      await this.submitPrompt(item.prompt, { renderPrompt: item.renderPromptAtSubmission });
    }
    this.clearQueueFooter();
  }

  private updateQueueFooter(): void {
    const lines = promptQueuePreviewLines(this.#promptQueue);
    if (!lines.length) {
      this.clearQueueFooter();
      return;
    }
    this.#composerQueue = lines;
    this.#activeComposerRedraw?.();
  }

  private clearQueueFooter(): void {
    if (promptQueuePreviewLines(this.#promptQueue).length || !this.#composerQueue) {
      return;
    }
    this.#composerQueue = undefined;
    this.#activeComposerRedraw?.();
  }

  private interruptActiveLoop(): boolean {
    const aborted = this.abortActiveLoop("User interrupted current loop");
    if (!aborted) {
      return false;
    }
    this.#composerActivity = `${fg256(220, "●")} ${fg256(250, "Interrupting current loop")} ${fg256(244, "queued prompts will run next")}`;
    this.updateQueueFooter();
    this.#activeComposerRedraw?.();
    return true;
  }

  private abortActiveLoop(reason: string): boolean {
    const controller = this.#activeAbort;
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(reason);
    return true;
  }

  private async requestExit(): Promise<void> {
    if (this.#shutdownStarted) {
      return;
    }
    this.#shutdownStarted = true;
    this.#running = false;
    await this.shutdownBackgroundWork("User exited TUI");
    stdout.write(fg256(243, "Resume this workspace with inferoa\n"));
  }

  private async shutdownBackgroundWork(reason: string): Promise<void> {
    this.#running = false;
    this.#welcomeCodeIntelligenceStop?.();
    this.#promptQueue = createPromptQueueState();
    this.clearQueueFooter();
    const aborted = this.abortActiveLoop(reason);
    const worker = this.#promptWorker;
    if (!worker) {
      if (aborted) {
        this.#composerActivity = undefined;
        this.#activeComposerRedraw?.();
      }
      return;
    }
    if (aborted) {
      this.#composerActivity = `${fg256(220, "●")} ${fg256(250, "Stopping current loop")}`;
      this.#activeComposerRedraw?.();
    }
    await worker.catch((error) => {
      this.writeTranscript(`\n${fg256(203, error instanceof Error ? error.message : String(error))}\n\n`);
    });
    this.#composerActivity = undefined;
    this.#activeComposerRedraw?.();
  }

  private async question(prompt: string): Promise<string> {
    this.#rl ??= createInterface({ input: stdin, output: stdout });
    return await this.#rl.question(prompt);
  }

  private async readComposer(options: ReadComposerOptions = {}): Promise<string> {
    const skills = await new SkillRegistry(this.app.workspace, this.app.config).discover().catch(() => [] as SkillDescriptor[]);
    let buffer = options.initialBuffer ?? "";
    let cursor = buffer.length;
    let compactRanges: ComposerCompactRange[] = [];
    let selected = 0;
    let selectionTouched = false;
    let renderedLines = 0;
    let renderedCursorLine = 0;
    let renderedCursorColumn = 0;
    let renderedWidth = 0;
    let renderedActivityLine: number | undefined;
    let renderedCodeIntelligenceLine: number | undefined;
    let renderedCodeIntelligenceColumn: number | undefined;
    let renderedCodeIntelligenceWidth: number | undefined;
    let forceFullRedraw = false;
    let eraseAfterResize = false;
    const pasteState: TerminalPasteState = {};
    this.#rl?.pause();
    stdout.write(`${BRACKETED_PASTE_ENABLE}${ansi.showCursor}`);

    return await new Promise((resolve) => {
      const resetRenderedState = () => {
        renderedLines = 0;
        renderedCursorLine = 0;
        renderedCursorColumn = 0;
        renderedWidth = 0;
        renderedActivityLine = undefined;
        renderedCodeIntelligenceLine = undefined;
        renderedCodeIntelligenceColumn = undefined;
        renderedCodeIntelligenceWidth = undefined;
      };
      const erase = (options: { resized?: boolean } = {}) => {
        if (!renderedLines) {
          return;
        }
        stdout.write(ansi.hideCursor);
        const rowsUp = options.resized
          ? composerEraseRowsForResize({
              renderedCursorLine,
              renderedCursorColumn,
              renderedWidth,
              terminalWidth: safeTerminalWidth(),
            })
          : renderedCursorLine;
        if (rowsUp > 0) {
          stdout.write(`\x1b[${rowsUp}A`);
        }
        stdout.write(`\r${CLEAR_TO_END}`);
        resetRenderedState();
      };
      const redraw = () => {
        render();
      };
      const redrawActivity = (): boolean => {
        if (renderedActivityLine === undefined || !this.#composerActivity || !renderedLines) {
          return false;
        }
        const line = renderComposerActivityLine(this.#composerActivity, safeTerminalWidth());
        stdout.write(ansi.hideCursor);
        moveCursorVertical(renderedActivityLine - renderedCursorLine);
        stdout.write(`\r${CLEAR_LINE}${line}`);
        moveCursorVertical(renderedCursorLine - renderedActivityLine);
        stdout.write("\r");
        if (renderedCursorColumn > 0) {
          stdout.write(`\x1b[${renderedCursorColumn}C`);
        }
        stdout.write(ansi.showCursor);
        return true;
      };
      const redrawWelcomeCodeIntelligence = (): boolean => {
        const label = this.welcomeCodeIntelligenceMeta();
        if (
          renderedCodeIntelligenceLine === undefined ||
          renderedCodeIntelligenceColumn === undefined ||
          renderedCodeIntelligenceWidth === undefined ||
          !label ||
          !renderedLines ||
          !this.shouldRenderWelcomeComposer()
        ) {
          return false;
        }
        const width = safeTerminalWidth();
        const fieldWidth = Math.max(0, Math.min(renderedCodeIntelligenceWidth, width - renderedCodeIntelligenceColumn));
        if (fieldWidth <= 0) {
          return false;
        }
        const text = padRight(fg256(244, truncateToWidth(label, fieldWidth)), fieldWidth);
        stdout.write(ansi.hideCursor);
        moveCursorVertical(renderedCodeIntelligenceLine - renderedCursorLine);
        stdout.write("\r");
        if (renderedCodeIntelligenceColumn > 0) {
          stdout.write(`\x1b[${renderedCodeIntelligenceColumn}C`);
        }
        stdout.write(text);
        moveCursorVertical(renderedCursorLine - renderedCodeIntelligenceLine);
        stdout.write("\r");
        if (renderedCursorColumn > 0) {
          stdout.write(`\x1b[${renderedCursorColumn}C`);
        }
        stdout.write(ansi.showCursor);
        return true;
      };
      const cleanup = () => {
        erase();
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        if (this.#activeComposerErase === erase) {
          this.#activeComposerErase = undefined;
        }
        if (this.#activeComposerRedraw === redraw) {
          this.#activeComposerRedraw = undefined;
        }
        if (this.#activeComposerActivityRedraw === redrawActivity) {
          this.#activeComposerActivityRedraw = undefined;
        }
        if (this.#activeWelcomeCodeIntelligenceRedraw === redrawWelcomeCodeIntelligence) {
          this.#activeWelcomeCodeIntelligenceRedraw = undefined;
        }
        stdout.write(`${BRACKETED_PASTE_DISABLE}${ansi.hideCursor}`);
        this.resumeReadline();
      };
      const finish = (text: string) => {
        cleanup();
        stdout.write(ansi.reset);
        resolve(text);
      };
      const render = () => {
        const items = composerItems();
        if (selected >= items.length) {
          selected = 0;
        }
        if (forceFullRedraw && this.shouldRenderWelcomeComposer()) {
          stdout.write(ansi.clear);
          resetRenderedState();
          forceFullRedraw = false;
        } else {
          erase({ resized: eraseAfterResize });
          forceFullRedraw = false;
          eraseAfterResize = false;
        }
        const width = safeTerminalWidth();
        const height = safeTerminalHeight();
        const block = this.shouldRenderWelcomeComposer()
          ? renderWelcomeComposerSurface({
              buffer,
              cursor,
              compactRanges,
              items,
              selected,
              width,
              height,
              activity: this.#composerActivity,
              queue: this.#composerQueue,
              footer: this.#composerFooter,
              workspaceRoot: this.app.workspace.root,
              mode: this.app.config.model_setup.mode,
              model: this.app.config.model_setup.model ?? "unconfigured",
              contextWindow: this.configuredContextWindow(),
              codeIntelligence: this.welcomeCodeIntelligenceMeta(),
              placeholder: options.placeholder,
            })
          : renderComposerSurface({
              buffer,
              cursor,
              compactRanges,
              items,
              selected,
              width,
              panel: this.#composerPanel,
              activity: this.#composerActivity,
              queue: this.#composerQueue,
              footer: this.#composerFooter,
              metadataLeft: this.composerMetadataLeft(),
              metadataRight: this.composerMetadataRight(),
              placeholder: options.placeholder,
            });
        stdout.write(block.lines.join("\n"));
        renderedLines = block.lines.length;
        renderedCursorLine = block.cursorLine;
        renderedCursorColumn = block.cursorColumn;
        renderedWidth = width;
        renderedActivityLine = block.activityLine;
        renderedCodeIntelligenceLine = block.codeIntelligenceLine;
        renderedCodeIntelligenceColumn = block.codeIntelligenceColumn;
        renderedCodeIntelligenceWidth = block.codeIntelligenceWidth;
        const up = Math.max(0, renderedLines - 1 - block.cursorLine);
        if (up > 0) {
          stdout.write(`\x1b[${up}A`);
        }
        stdout.write("\r");
        if (block.cursorColumn > 0) {
          stdout.write(`\x1b[${block.cursorColumn}C`);
        }
        stdout.write(ansi.showCursor);
      };
      this.#activeComposerErase = erase;
      this.#activeComposerRedraw = redraw;
      this.#activeComposerActivityRedraw = redrawActivity;
      this.#activeWelcomeCodeIntelligenceRedraw = redrawWelcomeCodeIntelligence;
      const composerItems = () => options.suggestions === false ? [] : this.composerSuggestions(buffer, skills);
      const completeSelection = (): boolean => {
        const items = composerItems();
        const item = items[selected];
        if (!item) {
          return false;
        }
        buffer = item.value;
        cursor = buffer.length;
        compactRanges = [];
        selected = 0;
        selectionTouched = false;
        render();
        return true;
      };
      const insertText = (text: string) => {
        const safeCursor = cursor;
        const next = insertComposerText(buffer, cursor, text);
        buffer = next.buffer;
        cursor = next.cursor;
        compactRanges = adjustComposerCompactRanges(compactRanges, safeCursor, safeCursor, text.length);
        selected = 0;
        selectionTouched = false;
        render();
      };
      const insertPaste = (text: string) => {
        const safeCursor = cursor;
        const next = insertComposerPaste(buffer, cursor, normalizeComposerPastedInput(text));
        buffer = next.buffer;
        cursor = next.cursor;
        compactRanges = adjustComposerCompactRanges(compactRanges, safeCursor, safeCursor, next.cursor - safeCursor);
        if (next.compactRange) {
          compactRanges.push(next.compactRange);
        }
        selected = 0;
        selectionTouched = false;
        render();
      };
      const deleteRange = (start: number, end: number) => {
        buffer = `${buffer.slice(0, start)}${buffer.slice(end)}`;
        cursor = start;
        compactRanges = adjustComposerCompactRanges(compactRanges, start, end, 0);
        selected = 0;
        selectionTouched = false;
        render();
      };
      const submit = () => {
        const items = composerItems();
        const item = items[selected];
        const trimmed = buffer.trim();
        const prompt = compactRanges.length ? buffer : trimmed;
        if (!prompt.trim()) {
          render();
          return;
        }
        if (trimmed === "/" && item) {
          finish(item.value);
          return;
        }
        if (trimmed === "$" && item && selectionTouched) {
          finish(item.value);
          return;
        }
        finish(prompt);
      };
      const onData = (chunk: Buffer) => {
        if (this.#inputModalActive) {
          return;
        }
        const rawInput = chunk.toString("utf8");
        const pastedFallback = composerPlainPasteFallback(rawInput);
        if (pastedFallback !== undefined) {
          insertPaste(pastedFallback);
          return;
        }
        let done = false;
        for (const key of terminalInputTokens(rawInput, pasteState)) {
          const pasted = pasteTokenContent(key);
          if (pasted !== undefined) {
            insertPaste(pasted);
          } else if (key === "\u0003") {
            finish("/exit");
            done = true;
          } else if (key === "\u001b") {
            if (buffer) {
              buffer = "";
              cursor = 0;
              compactRanges = [];
              selected = 0;
              selectionTouched = false;
              render();
            } else if (this.interruptActiveLoop()) {
              render();
            } else {
              finish("");
              done = true;
            }
          } else if (key === "\u001b[A") {
            const count = composerItems().length;
            if (count) {
              selected = (selected - 1 + count) % count;
              selectionTouched = true;
              render();
            }
          } else if (key === "\u001b[B") {
            const count = composerItems().length;
            if (count) {
              selected = (selected + 1) % count;
              selectionTouched = true;
              render();
            }
          } else if (key === "\u001b[C") {
            cursor = moveComposerCursorRight(buffer, cursor);
            render();
          } else if (key === "\u001b[D") {
            cursor = moveComposerCursorLeft(buffer, cursor);
            render();
          } else if (key === "\u001b[H" || key === "\u001b[1~") {
            cursor = moveComposerCursorHome(buffer, cursor);
            render();
          } else if (key === "\u001b[F" || key === "\u001b[4~") {
            cursor = moveComposerCursorEnd(buffer, cursor);
            render();
          } else if (key === "\t") {
            const subcommandRoot = slashCommandWithSubcommands(buffer);
            if (subcommandRoot && !buffer.trim().includes(" ")) {
              buffer = `/${subcommandRoot} `;
              cursor = buffer.length;
              compactRanges = [];
              selected = 0;
              selectionTouched = false;
              render();
            } else {
              completeSelection();
            }
          } else if (key === "shift-enter") {
            insertText("\n");
          } else if (key === "\r" || key === "\n") {
            submit();
            done = true;
          } else if (key === "\u0014") {
            finish("/tools expand");
            done = true;
          } else if (key === "\u007f") {
            const compactRange = compactRangeBeforeCursor(compactRanges, cursor);
            if (compactRange) {
              deleteRange(compactRange.start, compactRange.end);
            } else {
              const oldCursor = cursor;
              const next = backspaceComposer(buffer, cursor);
              buffer = next.buffer;
              cursor = next.cursor;
              compactRanges = adjustComposerCompactRanges(compactRanges, cursor, oldCursor, 0);
              selected = 0;
              selectionTouched = false;
              render();
            }
          } else if (isPrintableInput(key)) {
            insertText(printableText(key));
          }
          if (done) {
            return;
          }
        }
      };
      const onResize = () => {
        forceFullRedraw = this.shouldRenderWelcomeComposer();
        eraseAfterResize = !forceFullRedraw;
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private shouldRenderWelcomeComposer(): boolean {
    return !this.#hasTranscript && !this.#sessionId && !this.#activeAbort && !this.#promptWorker && !this.#promptWorkerScheduled;
  }

  private composerSuggestions(buffer: string, skills: SkillDescriptor[]): ComposerItem[] {
    if (buffer.startsWith("/")) {
      const lower = buffer.toLowerCase();
      const subcommandMatch = lower.match(/^\/([a-z]+)\s+(.*)$/);
      if (subcommandMatch) {
        const commandName = subcommandMatch[1] as SlashCommandName;
        const query = subcommandMatch[2]?.trim().toLowerCase() ?? "";
        return slashSubcommands(commandName)
          .filter((item) => !query || `${item.value} ${item.description}`.toLowerCase().includes(query))
          .sort((a, b) => commandScore(a.name, a.description, query) - commandScore(b.name, b.description, query))
          .slice(0, 8)
          .map((item) => ({
            value: item.value,
            label: item.value,
            description: item.description,
            kind: "command" as const,
          }));
      }
      const query = buffer.slice(1).trim().toLowerCase();
      return SLASH_COMMANDS.filter((command) => !query || `${command.name} ${command.description}`.toLowerCase().includes(query))
        .sort((a, b) => commandScore(a.name, a.description, query) - commandScore(b.name, b.description, query))
        .slice(0, 8)
        .map((command) => ({
          value: `/${command.name}`,
          label: `/${command.name}`,
          description: command.description,
          kind: "command" as const,
        }));
    }
    if (buffer.startsWith("$")) {
      const query = buffer.slice(1).trim().toLowerCase();
      const enabled = new Set(this.app.config.skills.enabled);
      return skills
        .filter((skill) => !query || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(query))
        .sort((a, b) => {
          const aEnabled = enabled.has(a.id) || enabled.has(a.name);
          const bEnabled = enabled.has(b.id) || enabled.has(b.name);
          if (aEnabled !== bEnabled) {
            return aEnabled ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
        .slice(0, 8)
        .map((skill) => ({
          value: `$ ${skill.id}`,
          label: skill.name,
          description: `${enabled.has(skill.id) || enabled.has(skill.name) ? "enabled" : "disabled"} · ${skill.description}`,
          kind: "skill" as const,
        }));
    }
    return [];
  }

  private renderHome(): void {
    stdout.write(ansi.clear);
    if (!this.shouldRenderWelcomeComposer()) {
      this.writeHomeFrame();
    }
  }

  private startWelcomeCodeIntelligenceIndexing(): void {
    const hub = this.app.runtime.codeIntelligence;
    if (this.#welcomeCodeIntelligenceStarted || !hub.shouldStartOnWelcome()) {
      return;
    }
    this.#welcomeCodeIntelligenceStarted = true;
    const unsubscribe = hub.onStatus(() => {
      if (!this.#activeWelcomeCodeIntelligenceRedraw?.()) {
        this.#activeComposerRedraw?.();
      }
    });
    this.#welcomeCodeIntelligenceStop = () => {
      unsubscribe();
      this.#welcomeCodeIntelligenceStop = undefined;
    };
    hub.startIndexing("welcome").finally(() => {
      this.#welcomeCodeIntelligenceStop?.();
      if (!this.#activeWelcomeCodeIntelligenceRedraw?.()) {
        this.#activeComposerRedraw?.();
      }
    });
  }

  private promptRequiresCodeIntelligenceGate(): boolean {
    const hub = this.app.runtime.codeIntelligence;
    if (!hub.requireReadyBeforeChat()) {
      return false;
    }
    const state = hub.status().codegraph.state;
    return state !== "ready" && state !== "off";
  }

  private async waitForCodeIntelligenceBeforeChat(): Promise<boolean> {
    const hub = this.app.runtime.codeIntelligence;
    if (!hub.requireReadyBeforeChat()) {
      return true;
    }
    let status = hub.status().codegraph;
    if (status.state === "ready" || status.state === "off") {
      return true;
    }
    const activity = this.startActivityIndicator(codeIntelligenceActivityLabel(status));
    const unsubscribe = hub.onStatus((next) => activity.status(codeIntelligenceActivityLabel(next)));
    try {
      status = await hub.waitUntilReadyBeforeChat();
    } finally {
      unsubscribe();
      activity.stop();
    }
    if (status.state === "ready" || status.state === "off") {
      return true;
    }
    if (status.state !== "degraded") {
      return true;
    }
    const choice = await this.selectOption<"retry" | "continue">(
      "Context Optimization",
      [
        { value: "retry", label: "Retry indexing", description: "Rebuild indexed context before sending this prompt." },
        { value: "continue", label: "Continue", description: "Send this prompt without indexed context for this turn." },
      ],
      0,
      [
        fg256(203, truncateToWidth(status.error ?? "Context optimization is unavailable.", Math.max(24, terminalWidth() - 8))),
        fg256(244, "No chat request has been sent yet."),
      ],
    ).catch(() => "continue" as const);
    if (choice === "retry") {
      const retry = await hub.startIndexing("chat_retry", { force: true });
      if (retry.state === "ready") {
        return true;
      }
      return await this.waitForCodeIntelligenceBeforeChat();
    }
    return true;
  }

  private welcomeCodeIntelligenceMeta(): string | undefined {
    const status = this.app.runtime.codeIntelligence.status().codegraph;
    if (status.provider === "off" || status.provider === "builtin") {
      return undefined;
    }
    if (status.state === "ready") {
      return status.files ? `indexed ${status.files} files` : "indexed";
    }
    if (status.state === "degraded") {
      return "index degraded";
    }
    if (status.state === "indexing" || status.state === "syncing") {
      return `index ${codeIntelligenceProgress(status)}`;
    }
    return "index pending";
  }

  private writeHomeFrame(): void {
    stdout.write(renderHomeFrame({
      workspaceRoot: this.app.workspace.root,
      mode: this.app.config.model_setup.mode,
      model: this.app.config.model_setup.model ?? "unconfigured",
      width: safeTerminalWidth(),
    }).join("\n"));
    stdout.write("\n\n");
  }

  private configuredContextWindow(): number | undefined {
    return this.app.config.model_setup.context_window ?? this.app.config.context.context_window;
  }

  private async askModeObjective(label: string, defaultValue?: string): Promise<string> {
    const previousPanel = this.#composerPanel;
    this.#composerPanel = {
      lines: [
        `  ${fg256(39, label)}`,
        `  ${fg256(244, "enter submit · esc cancel")}`,
      ],
    };
    try {
      return await this.readComposer({
        placeholder: label,
        initialBuffer: defaultValue,
        suggestions: false,
      });
    } finally {
      this.#composerPanel = previousPanel;
    }
  }

  private composerMetadataLeft(): string {
    const model = compactModelLabel(this.app.config.model_setup.model ?? "unconfigured");
    return [
      fg256(75, compactWorkspacePath(this.app.workspace.root)),
      fg256(238, "·"),
      fg256(252, model),
    ].join(" ");
  }

  private composerMetadataRight(): string | undefined {
    const session = this.optionalSession();
    if (!session) {
      return undefined;
    }
    const plan = readPlanState(this.app.store, session.session_id);
    const autoresearch = readAutoresearchState(this.app.store, session.session_id);
    const goal = readGoalState(this.app.store, session.session_id);
    return renderModeMetadataRight({ plan, autoresearch, goal });
  }

  private inputPrompt(): string {
    return `\n${bgLine(236, `›  ${fg256(244, "Ask Inferoa")}`, safeTerminalWidth())}`;
  }

  private async openView(command: SlashCommandName, args: string): Promise<void> {
    if (command !== "clear" && command !== "exit") {
      this.enterChatSurfaceFromWelcome();
    }
    const previousInline = this.#inlineMode;
    this.#inlineMode = true;
    this.#inlineRenderedLines = 0;
    try {
      switch (command) {
        case "setup":
          await this.renderSetupView();
          return;
        case "model":
          await this.renderModelView(args);
          return;
        case "system":
          await this.renderEndpointView();
          return;
        case "access":
          await this.renderAccessView(args);
          return;
        case "skills":
          await this.renderSkillsView(args);
          return;
        case "goal":
          await this.renderGoalView(args);
          return;
        case "plan":
          await this.renderPlanView(args);
          return;
        case "autoresearch":
          await this.renderAutoresearchView(args);
          return;
        case "cache":
          this.renderCacheView();
          return;
        case "rtk":
          this.renderRtkView();
          return;
        case "context":
          await this.renderContextView(args);
          return;
        case "tools":
          this.renderToolsView(args);
          return;
        case "sessions":
          await this.renderSessionsView(args);
          return;
        case "activity":
          this.renderFormattedEventView("Activity", isActivityEvent, renderSessionActivityLines);
          return;
        case "jobs":
          await this.renderJobsView(args);
          return;
        case "todo":
          this.renderFormattedEventView("Todo", (event) => event.type === "todo.updated", renderTodoEventLines);
          return;
        case "acceptance":
          await this.renderAcceptanceView(args);
          return;
        case "help":
          this.renderHelp();
          return;
        case "clear":
          await this.startFreshSessionFromClear();
          return;
        case "resume":
          await this.renderResumeSessionView(args);
          return;
        case "exit":
          await this.requestExit();
          return;
        default:
          this.renderNotice(`Unhandled command: /${command} ${args}`);
      }
    } finally {
      this.#inlineMode = previousInline;
    }
  }

  private enterChatSurfaceFromWelcome(): void {
    if (!this.shouldRenderWelcomeComposer()) {
      return;
    }
    stdout.write(ansi.clear);
    this.writeHomeFrame();
    this.#hasTranscript = true;
  }

  private handleViewError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("cancelled")) {
      return;
    }
    this.renderNotice(message);
  }

  private async renderSetupView(): Promise<void> {
    const nextConfig = structuredClone(this.app.config);
    this.renderCenteredPanel("Setup", [
      setupProgress(1, SETUP_TOTAL_STEPS, "provider"),
      "",
      `${fg256(252, "Model endpoint")}`,
      fg256(244, "Configure chat, context window, web search, and optional Omni endpoints."),
      "",
      `${fg256(244, "current")} ${this.describeModelSetup(this.app.config.model_setup)}`,
      `${fg256(244, "config")}  ${userConfigPath()}`,
    ], true);

    const provider = await this.chooseProvider();
    this.applyProviderChoice(nextConfig.model_setup, provider);
    if (provider === "external") {
      await this.configureExternalModelSetup(nextConfig);
    } else {
      this.renderCenteredPanel("Setup", [setupProgress(2, SETUP_TOTAL_STEPS, "endpoint"), "", fg256(244, "OpenAI-compatible endpoint URL.")], true);
      nextConfig.model_setup.base_url = await this.askRequired("Chat endpoint base URL", nextConfig.model_setup.base_url ?? defaultBaseUrl(provider));
      this.applyApiKeySelection(nextConfig.model_setup, await this.askApiKeySelection(
        secretRef(`chat-${provider}-${nextConfig.model_setup.base_url ?? "endpoint"}`, "api-key"),
        `${providerLabel(provider)} API key`,
        nextConfig.model_setup.api_key_ref,
        false,
      ));
      delete nextConfig.model_setup.api_key;

      this.renderCenteredPanel("Setup", [setupProgress(3, SETUP_TOTAL_STEPS, "model"), "", fg256(244, "Listing endpoint models.")], true);
      const chatProbe = await this.probeChatModels(nextConfig);
      nextConfig.model_setup.model = await this.pickModel("Chat model", chatProbe, nextConfig.model_setup.model);
    }
    this.renderCenteredPanel("Setup", [setupProgress(4, SETUP_TOTAL_STEPS, "context"), "", fg256(244, "Model context window in tokens.")], true);
    const currentContextWindow = nextConfig.model_setup.context_window ?? nextConfig.context.context_window;
    const contextWindowInput = await this.ask("Context window tokens", String(currentContextWindow));
    nextConfig.model_setup.context_window = normalizeContextWindowInput(contextWindowInput, currentContextWindow);
    nextConfig.context.context_window = nextConfig.model_setup.context_window;

    this.renderCenteredPanel("Setup", [setupProgress(5, SETUP_TOTAL_STEPS, "web"), "", fg256(244, "Keyword web search provider.")], true);
    await this.configureWebSearch(nextConfig);

    this.renderCenteredPanel("Setup", [setupProgress(6, SETUP_TOTAL_STEPS, "omni"), "", fg256(244, "Optional multimodal endpoints.")], true);
    if (await this.confirm("Configure Omni multimodal endpoints now?", this.app.config.omni.enabled)) {
      nextConfig.omni.enabled = true;
      for (const capability of TUI_OMNI_SETUP_CAPABILITIES) {
        nextConfig.omni.endpoints[capability.name] = await this.configureOmniEndpoint(
          capability.name,
          capability.label,
          nextConfig.omni.endpoints[capability.name],
          capability.requiredForAcceptance,
        );
      }
    } else {
      nextConfig.omni.enabled = false;
      nextConfig.omni.endpoints = {};
    }

    this.renderCenteredPanel("Setup", [setupProgress(7, SETUP_TOTAL_STEPS, "rtk"), "", fg256(244, "Preparing RTK tool-output compression.")], true);
    const rtkStatus = await this.prepareRtkForSetup(nextConfig);

    if (!(await this.reviewSetupBeforeSave(nextConfig, rtkStatus))) {
      this.renderNotice("Setup cancelled. No config was saved.");
      return;
    }

    const target = await saveUserConfig(nextConfig);
    Object.assign(this.app.config, nextConfig);
    if (!this.app.configFiles.includes(target)) {
      this.app.configFiles.push(target);
    }
    this.#hasTranscript = false;
    this.#composerFooter = undefined;
    this.#composerQueue = undefined;
    this.#composerPanel = undefined;
    this.renderHome();
  }

  private async prepareRtkForSetup(config: VllmAgentConfig): Promise<RtkStatus> {
    return await resolveRtkStatus(config, { allowDownload: config.rtk.auto_download });
  }

  private async reviewSetupBeforeSave(config: VllmAgentConfig, rtkStatus?: RtkStatus): Promise<boolean> {
    const action = await this.reviewAction("Review Setup", () => setupReviewLinesForDisplay(config, setupDialogContentWidth(), rtkStatus));
    return action === "save";
  }

  private async chooseProvider(): Promise<ProviderChoice> {
    const options: SelectOption<ProviderChoice>[] = [
      { value: "direct", label: "Direct", description: "Use your vLLM endpoint for the fastest, most predictable path" },
      { value: "auto", label: "Auto", description: "Let vLLM Semantic Router choose the best route for each request" },
      { value: "external", label: "External", description: "Choose a built-in provider, discovered local session, or custom endpoint" },
    ];
    const current = this.app.config.model_setup.mode === "auto" ? "auto" : this.app.config.model_setup.provider === "external" ? "external" : "direct";
    const defaultIndex = Math.max(0, options.findIndex((option) => option.value === current));
    return await this.selectOption("Provider", options, defaultIndex);
  }

  private async chooseExternalProvider(options: ExternalProviderSetupOption[], currentProviderId?: string): Promise<ExternalProviderSetupOption> {
    if (!options.length) {
      throw new Error("No external providers are available.");
    }
    let query = "";
    let filtered = filterProviderPickerOptions(options, query);
    let defaultIndex = Math.max(0, filtered.findIndex((option) => option.provider.id === currentProviderId));
    let pageIndex = Math.floor(defaultIndex / 5);
    let selected = defaultIndex % 5;
    this.#rl?.pause();

    const clampSelection = () => {
      filtered = filterProviderPickerOptions(options, query);
      const page = providerPickerPage(filtered, pageIndex);
      pageIndex = page.pageIndex;
      selected = Math.max(0, Math.min(selected, Math.max(0, page.items.length - 1)));
      return page;
    };

    const render = () => {
      const page = clampSelection();
      const lines = page.items.length
        ? page.items.map((option, index) => {
          return renderProviderSetupOptionLine(option, index === selected);
        })
        : [fg256(244, query ? `No providers matched ${query}.` : "No providers available.")];
      const searchLabel = query ? ` · search ${query}` : "";
      const pageHint = `${page.pageIndex + 1}/${page.totalPages} · ${page.totalItems} providers${searchLabel} · ←/→ page · type search · enter select · esc cancel`;
      this.renderCenteredPanel("External Provider", [...lines, "", setupHint(pageHint)], true);
    };

    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        const page = clampSelection();
        const option = page.items[selected];
        if (!option) {
          render();
          return;
        }
        cleanup();
        stdout.write("\n");
        resolve(option);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Provider selection cancelled"));
      };
      const resetSearchPosition = () => {
        pageIndex = 0;
        selected = 0;
      };
      const movePage = (delta: number) => {
        const current = providerPickerPage(filtered, pageIndex);
        pageIndex = Math.max(0, Math.min(current.totalPages - 1, pageIndex + delta));
        clampSelection();
        render();
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          if (key === "\u0003" || key === "\u001b") {
            cancel();
            return;
          }
          if (key === "\u001b[A" || key === "k") {
            const page = clampSelection();
            if (page.items.length) {
              selected = (selected - 1 + page.items.length) % page.items.length;
            }
            render();
            continue;
          }
          if (key === "\u001b[B" || key === "j") {
            const page = clampSelection();
            if (page.items.length) {
              selected = (selected + 1) % page.items.length;
            }
            render();
            continue;
          }
          if (key === "\u001b[D" || key === "p") {
            movePage(-1);
            continue;
          }
          if (key === "\u001b[C" || key === "n") {
            movePage(1);
            continue;
          }
          if (key === "\u007f") {
            query = query.slice(0, -1);
            resetSearchPosition();
            render();
            continue;
          }
          if (key === "/" && !query) {
            render();
            continue;
          }
          if (key === " " || key === "\r" || key === "\n") {
            finish();
            return;
          }
          const printable = printableText(key);
          if (printable) {
            query += printable;
            resetSearchPosition();
            render();
          }
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async chooseSlashCommand(query = ""): Promise<SlashCommandName> {
    const normalized = query.toLowerCase();
    const commands = SLASH_COMMANDS.filter((command) => !normalized || `${command.name} ${command.description}`.toLowerCase().includes(normalized));
    if (!commands.length) {
      this.renderNotice(`No command matched ${query}.`);
      return "help";
    }
    return await this.selectOption(
      "Commands",
      commands.map((command) => ({
        value: command.name,
        label: `/${command.name}`,
        description: command.description,
      })),
    );
  }

  private applyProviderChoice(setup: ModelSetup, provider: ProviderChoice): void {
    if (provider === "auto") {
      setup.mode = "auto";
      setup.provider = "vllm";
      delete setup.provider_id;
      setup.router = "vllm-sr";
      setup.profile = "openai_compatible";
      setup.base_url = setup.base_url ?? defaultBaseUrl(provider);
      return;
    }
    setup.mode = "direct";
    delete setup.router;
    delete setup.provider_id;
    setup.profile = "openai_compatible";
    setup.provider = provider === "external" ? "external" : "vllm";
    setup.base_url = setup.base_url ?? defaultBaseUrl(provider);
  }

  private async configureExternalModelSetup(config: VllmAgentConfig): Promise<void> {
    this.renderCenteredPanel("Setup", [
      setupProgress(2, SETUP_TOTAL_STEPS, "provider"),
      "",
      fg256(244, "Discovering available external providers."),
    ], true);
    const states = await discoverExternalProviderStates();
    const option = await this.chooseExternalProvider(externalProviderSetupOptions(states), config.model_setup.provider_id);
    const provider = option.provider;
    this.applyExternalProviderChoice(config.model_setup, provider);
    const state = option.state ?? states.find((candidate) => candidate.provider.id === provider.id);

    this.renderCenteredPanel("Setup", [
      setupProgress(2, SETUP_TOTAL_STEPS, "endpoint"),
      "",
      fg256(244, provider.description),
    ], true);
    if (provider.supports_custom_base_url || !provider.base_url) {
      config.model_setup.base_url = await this.askRequired(`${provider.label} base URL`, config.model_setup.base_url ?? provider.base_url ?? defaultBaseUrl("external"));
    } else {
      config.model_setup.base_url = state?.base_url ?? provider.base_url;
    }

    await this.configureExternalProviderAuth(config.model_setup, provider, state);

    this.renderCenteredPanel("Setup", [
      setupProgress(3, SETUP_TOTAL_STEPS, "model"),
      "",
      fg256(244, `Listing ${provider.label} models.`),
    ], true);
    const chatProbe = await this.probeExternalModels(config.model_setup, provider);
    config.model_setup.model = await this.pickModel(`${provider.label} model`, chatProbe, config.model_setup.model ?? provider.default_model);
  }

  private applyExternalProviderChoice(setup: ModelSetup, provider: ExternalProviderDefinition): void {
    const previousProviderId = setup.provider_id;
    setup.mode = "direct";
    setup.provider = "external";
    setup.provider_id = provider.id;
    setup.profile = provider.profile;
    setup.base_url = provider.base_url ?? setup.base_url ?? defaultBaseUrl("external");
    setup.model = provider.default_model ?? setup.model;
    setup.headers = provider.extra_headers ? { ...provider.extra_headers } : undefined;
    delete setup.router;
    delete setup.api_key;
    if (previousProviderId !== provider.id) {
      delete setup.api_key_ref;
    }
  }

  private async configureExternalProviderAuth(
    setup: ModelSetup,
    provider: ExternalProviderDefinition,
    state?: ExternalProviderState,
  ): Promise<void> {
    if (!externalProviderRequiresApiKey(provider)) {
      delete setup.api_key_ref;
      delete setup.api_key;
      return;
    }
    if (state?.credential?.value) {
      const ref = secretRef(`chat-${provider.id}`, "api-key");
      await writeSecret(ref, state.credential.value);
      setup.api_key_ref = ref;
      delete setup.api_key;
      this.renderCenteredPanel("Auto Auth", [
        `${fg256(48, "auto")} ${provider.label}`,
        fg256(243, `source ${state.credential.source}`),
        fg256(243, "Config stores only api_key_ref."),
      ], true);
      return;
    }
    this.applyApiKeySelection(
      setup,
      await this.askApiKeySelection(
        secretRef(`chat-${provider.id}`, "api-key"),
        `${provider.label} API key`,
        setup.api_key_ref,
        true,
      ),
    );
    delete setup.api_key;
  }

  private async probeExternalModels(setup: ModelSetup, provider: ExternalProviderDefinition): Promise<EndpointProbeResult> {
    return await probeExternalProviderModels(provider, {
      baseUrl: setup.base_url,
      apiKey: endpointApiKey(setup),
    });
  }

  private async configureWebSearch(config: VllmAgentConfig): Promise<void> {
    const provider = await this.chooseWebSearchProvider(config.web_search.provider);
    config.web_search.provider = provider;
    delete config.web_search.api_key;
    if (provider === "auto" || provider === "off") {
      delete config.web_search.base_url;
      delete config.web_search.api_key_ref;
      return;
    }
    if (provider === "brave") {
      delete config.web_search.base_url;
      this.applyApiKeySelection(
        config.web_search,
        await this.askApiKeySelection(secretRef("web-brave-api-key", "api-key"), "Brave Search API key", config.web_search.api_key_ref, true),
      );
      return;
    }
    if (provider === "jina") {
      delete config.web_search.base_url;
      this.applyApiKeySelection(
        config.web_search,
        await this.askApiKeySelection(secretRef("web-jina-api-key", "api-key"), "Jina Search API key", config.web_search.api_key_ref),
      );
      return;
    }
    if (provider === "searxng" || provider === "custom") {
      config.web_search.base_url = await this.askRequired(
        `${webSearchProviderLabel(provider)} base URL`,
        config.web_search.base_url ?? "http://localhost:8080",
      );
      this.applyApiKeySelection(
        config.web_search,
        await this.askApiKeySelection(secretRef(`web-${provider}`, "api-key"), `${webSearchProviderLabel(provider)} API key`, config.web_search.api_key_ref),
      );
      return;
    }
    delete config.web_search.base_url;
    delete config.web_search.api_key_ref;
  }

  private async chooseWebSearchProvider(current: WebSearchProviderChoice): Promise<WebSearchProviderChoice> {
    const options = webSearchProviderSetupOptions();
    const defaultIndex = Math.max(0, options.findIndex((option) => option.value === current));
    return await this.selectOption("Web Search", options, defaultIndex, [
      fg256(244, "Direct URLs are fetched by web_fetch even when keyword search uses fallback."),
    ]);
  }

  private async configureOmniEndpoint(
    name: OmniEndpointName,
    label: string,
    current?: OmniEndpointConfig,
    requiredForAcceptance = false,
  ): Promise<OmniEndpointConfig | undefined> {
    const suffix = requiredForAcceptance ? "required for final acceptance" : "optional";
    const shouldConfigure = await this.confirm(`${label}: configure endpoint? (${suffix})`, Boolean(current?.base_url && current.model));
    if (!shouldConfigure) {
      return current;
    }
    const endpoint: OmniEndpointConfig = { ...(current ?? {}) };
    endpoint.base_url = await this.askRequired(`${label} base URL`, endpoint.base_url ?? this.app.config.model_setup.base_url ?? "http://localhost:8000/v1");
    this.applyApiKeySelection(
      endpoint,
      await this.askApiKeySelection(secretRef(`omni-${name}-${endpoint.base_url}`, "api-key"), `${label} API key`, endpoint.api_key_ref),
    );
    delete endpoint.api_key;
    const probe = await this.probeOpenAiModels(endpoint);
    endpoint.model = await this.pickModel(`${label} model`, probe, endpoint.model);
    return endpoint;
  }

  private async configureSkillSelection(config: VllmAgentConfig, query = ""): Promise<string[]> {
    const discovered = await new SkillRegistry(this.app.workspace, config).discover();
    const normalizedQuery = query.toLowerCase();
    const skills = discovered
      .filter((skill) => !normalizedQuery || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => {
        const enabled = new Set(config.skills.enabled);
        const aEnabled = enabled.has(a.id) || enabled.has(a.name);
        const bEnabled = enabled.has(b.id) || enabled.has(b.name);
        if (aEnabled !== bEnabled) {
          return aEnabled ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    if (!skills.length) {
      this.renderCenteredPanel("Skills", [query ? `No skills matched ${query}.` : "No skills discovered."], true);
      return config.skills.enabled;
    }
    const enabled = new Set(config.skills.enabled);
    const visible = skills.slice(0, 160);
    return await this.multiSelect(
      "Skills",
      visible.map((skill) => ({
        value: skill.id,
        label: skill.name,
        description: `${skill.trust} · ${skill.description}`,
      })),
      visible.map((skill) => enabled.has(skill.id) || enabled.has(skill.name)),
      [
        fg256(244, "Only the index is injected into the prompt. skill_read loads details on demand."),
        ...(skills.length > visible.length ? [fg256(244, `${skills.length - visible.length} more hidden; open /skills with a filter.`)] : []),
      ],
    );
  }

  private async probeChatModels(config: VllmAgentConfig): Promise<EndpointProbeResult> {
    this.renderCenteredPanel("Model Discovery", [
      `${fg256(39, "GET")} ${(config.model_setup.base_url ?? "").replace(/\/$/, "")}/models`,
      fg256(243, "Listing models before selection."),
    ], true);
    const snapshot = await new EndpointSignals(config).snapshot();
    return {
      models: modelsFromSnapshot(snapshot),
      errors: snapshot.errors ?? [],
    };
  }

  private async probeOpenAiModels(endpoint: OmniEndpointConfig): Promise<EndpointProbeResult> {
    if (!endpoint.base_url) {
      return { models: [], errors: ["base_url is required"] };
    }
    const base = endpoint.base_url.replace(/\/$/, "");
    this.renderCenteredPanel("Model Discovery", [`${fg256(39, "GET")} ${base}/models`, fg256(243, "Listing multimodal endpoint models.")], true);
    try {
      const response = await fetch(`${base}/models`, {
        method: "GET",
        headers: authHeaders(endpoint),
      });
      if (!response.ok) {
        return { models: [], errors: [`/models returned ${response.status}`] };
      }
      const json = (await response.json()) as Record<string, unknown>;
      const data = Array.isArray(json.data) ? dataAsJsonObjects(json.data) : [];
      return { models: data.map((model) => stringField(model.id) ?? stringField(model.name)).filter((model): model is string => Boolean(model)), errors: [] };
    } catch (error) {
      return { models: [], errors: [`/models unavailable: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  private async pickModel(title: string, probe: EndpointProbeResult, current?: string): Promise<string> {
    if (probe.models.length) {
      const defaultModel = current && probe.models.includes(current) ? current : probe.models[0] ?? current;
      const defaultIndex = defaultModel && probe.models.includes(defaultModel) ? probe.models.indexOf(defaultModel) : 0;
      return await this.selectModelOption(title, probe.models, defaultIndex, probe.errors);
    }
    this.renderCenteredPanel(title, ["No models returned. Type a model id manually.", ...probe.errors.map((error) => fg256(203, error))]);
    while (true) {
      const answer = await this.ask("Model id", current);
      const index = Number.parseInt(answer, 10) - 1;
      const selected = probe.models[index] ?? (answer.trim() || current);
      if (selected) {
        return selected;
      }
      this.renderNotice("A model id is required.");
    }
  }

  private async selectModelOption(title: string, models: string[], defaultIndex = 0, errors: string[] = []): Promise<string> {
    let query = "";
    let filtered = models;
    let pageIndex = Math.floor(Math.max(0, defaultIndex) / RESUME_SESSION_PAGE_SIZE);
    let selected = Math.max(0, defaultIndex) % RESUME_SESSION_PAGE_SIZE;
    this.#rl?.pause();

    const clampSelection = () => {
      const normalized = query.trim().toLowerCase();
      filtered = normalized ? models.filter((model) => model.toLowerCase().includes(normalized)) : models;
      const page = resumeSessionPage(filtered, pageIndex, RESUME_SESSION_PAGE_SIZE);
      pageIndex = page.pageIndex;
      selected = Math.max(0, Math.min(selected, Math.max(0, page.items.length - 1)));
      return page;
    };

    const render = () => {
      const page = clampSelection();
      const lines = page.items.length
        ? page.items.map((model, index) => renderSetupOptionLine(model, undefined, index === selected))
        : [fg256(244, query ? `No models matched ${query}. Enter uses the typed id.` : "No models available.")];
      const searchLabel = query ? ` · search ${query}` : "";
      const hint = `${page.pageIndex + 1}/${page.totalPages} · ${page.totalItems} models${searchLabel} · ←/→ page · type search · enter select · esc cancel`;
      const footer = errors.length ? ["", fg256(203, "Probe errors"), ...errors.map((error) => `  ${error}`)] : [];
      this.renderCenteredPanel(title, [...lines, "", setupHint(hint), ...footer], true);
    };

    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        const page = clampSelection();
        const model = page.items[selected] ?? query.trim();
        if (!model) {
          render();
          return;
        }
        cleanup();
        stdout.write("\n");
        resolve(model);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Model selection cancelled"));
      };
      const resetSearchPosition = () => {
        pageIndex = 0;
        selected = 0;
      };
      const movePage = (delta: number) => {
        const current = resumeSessionPage(filtered, pageIndex, RESUME_SESSION_PAGE_SIZE);
        pageIndex = Math.max(0, Math.min(current.totalPages - 1, pageIndex + delta));
        clampSelection();
        render();
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          if (key === "\u0003" || key === "\u001b") {
            cancel();
            return;
          }
          if (key === "\u001b[A" || key === "k") {
            const page = clampSelection();
            if (page.items.length) {
              selected = (selected - 1 + page.items.length) % page.items.length;
            }
            render();
            continue;
          }
          if (key === "\u001b[B" || key === "j") {
            const page = clampSelection();
            if (page.items.length) {
              selected = (selected + 1) % page.items.length;
            }
            render();
            continue;
          }
          if (key === "\u001b[D" || key === "p") {
            movePage(-1);
            continue;
          }
          if (key === "\u001b[C" || key === "n") {
            movePage(1);
            continue;
          }
          if (key === "\u007f") {
            query = query.slice(0, -1);
            resetSearchPosition();
            render();
            continue;
          }
          if (key === " " || key === "\r" || key === "\n") {
            finish();
            return;
          }
          const printable = printableText(key);
          if (printable) {
            query += printable;
            resetSearchPosition();
            render();
          }
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async ask(label: string, defaultValue?: string, options: { secret?: boolean } = {}): Promise<string> {
    if (!stdin.isTTY) {
      return defaultValue ?? "";
    }
    let value = "";
    this.#rl?.pause();
    stdout.write(ansi.hideCursor);
    return await new Promise((resolve, reject) => {
      const render = () => {
        const panelInputWidth = Math.min(76, Math.max(48, terminalWidth() - 14));
        const display = options.secret ? "•".repeat(value.length) : value;
        const shown = truncateToWidth(display, panelInputWidth - 5);
        const cursor = fg256(75, "▌");
        const defaultHint = defaultValue && !options.secret ? `enter accept · default ${defaultValue}` : "enter accept";
        this.renderCenteredPanel(label, [
          `${fg256(75, "›")} ${shown}${cursor}${shown ? "" : ` ${fg256(238, "type to override")}`}`,
          "",
          setupHint(`${defaultHint} · esc cancel`),
        ], true);
      };
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdout.write(ansi.hideCursor);
        this.resumeReadline();
      };
      const finish = () => {
        cleanup();
        resolve(value.trim() || defaultValue || "");
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Input cancelled"));
      };
      const onData = (chunk: Buffer) => {
        let done = false;
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          if (key === "\u0003" || key === "\u001b") {
            cancel();
            done = true;
          } else if (key === "\r" || key === "\n") {
            finish();
            done = true;
          } else if (key === "\u007f") {
            value = value.slice(0, -1);
            render();
          } else {
            const printable = printableText(key);
            if (printable) {
              value += printable;
              render();
            }
          }
          if (done) {
            return;
          }
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async askClarification(request: ClarifyRequest): Promise<ClarifyResponse> {
    if (!stdin.isTTY) {
      throw new Error("Clarification requires an interactive terminal.");
    }
    let state = createClarifyInputState(request);
    this.#inputModalActive = true;
    const composerWasActive = Boolean(this.#activeComposerRedraw);
    this.#rl?.pause();
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdout.write(ansi.showCursor);
    return await new Promise((resolve, reject) => {
      const render = () => {
        this.#composerPanel = renderClarifyComposerPanel(request, state, safeTerminalWidth());
        this.#activeComposerRedraw?.();
      };
      const cleanup = () => {
        this.#inputModalActive = false;
        this.#composerPanel = undefined;
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(composerWasActive);
        }
        stdout.write(ansi.hideCursor);
        this.resumeReadline();
        this.#activeComposerRedraw?.();
      };
      const finish = (response: ClarifyResponse) => {
        cleanup();
        resolve(response);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Clarification cancelled"));
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          const result = applyClarifyInputToken(state, request, key);
          state = result.state;
          if (result.cancelled) {
            cancel();
            return;
          }
          if (result.response) {
            finish(result.response);
            return;
          }
          render();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async askRequired(label: string, defaultValue?: string): Promise<string> {
    while (true) {
      const value = await this.ask(label, defaultValue);
      if (value) {
        return value;
      }
      this.renderNotice(`${label} is required.`);
    }
  }

  private async askApiKeySelection(defaultRef: string, label: string, currentRef?: string, required = false): Promise<ApiKeySelection> {
    const hasCurrentSecret = Boolean(currentRef && readSecret(currentRef));
    const effectiveRequired = required || Boolean(currentRef && !hasCurrentSecret);
    const hint = hasCurrentSecret ? "blank keeps current vault key" : effectiveRequired ? "paste key" : "blank for no auth";
    const value = (await this.ask(`${label} (${hint})`, undefined, { secret: true })).trim();
    if (!value) {
      if (hasCurrentSecret && currentRef) {
        return { api_key_ref: currentRef };
      }
      if (effectiveRequired) {
        this.renderNotice(`${label} is required. Paste the key so Inferoa can store it in the local vault.`);
        return await this.askApiKeySelection(defaultRef, label, undefined, true);
      }
      return {};
    }
    if (isEnvVarName(value) && !looksLikeApiKey(value)) {
      this.renderNotice("Setup stores API keys in the local vault. Paste the actual key instead of an environment variable name.");
      return await this.askApiKeySelection(defaultRef, label, currentRef, required);
    }
    const vaultPath = await writeSecret(defaultRef, value);
    this.renderCenteredPanel("Local Vault", [
      `${fg256(48, "✓")} stored as ${defaultRef}`,
      fg256(243, vaultPath),
      fg256(243, "Config stores only api_key_ref."),
    ], true);
    return { api_key_ref: defaultRef };
  }

  private applyApiKeySelection(endpoint: { api_key_ref?: string }, selection: ApiKeySelection): void {
    endpoint.api_key_ref = selection.api_key_ref;
    delete (endpoint as { api_key_env?: string }).api_key_env;
  }

  private async confirm(label: string, defaultValue: boolean): Promise<boolean> {
    return (
      (await this.selectOption(
        label,
        [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        defaultValue ? 0 : 1,
      )) === "yes"
    );
  }

  private async selectOption<T extends string>(title: string, options: SelectOption<T>[], defaultIndex = 0, footer: string[] = []): Promise<T> {
    if (!options.length) {
      throw new Error(`${title} has no options`);
    }
    let selected = Math.max(0, Math.min(defaultIndex, options.length - 1));
    this.#rl?.pause();
    const render = () => {
      const lines = options.map((option, index) => {
        const active = index === selected;
        return renderSetupOptionLine(option.label, option.description, active);
      });
      this.renderCenteredPanel(title, [...lines, "", setupHint("↑/↓ move · space/enter select · esc cancel"), ...footer], true);
    };
    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        const value = options[selected]?.value ?? options[0]!.value;
        cleanup();
        stdout.write("\n");
        resolve(value);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key.includes("\u0003")) {
          cancel();
          return;
        }
        if (key === "\u001b") {
          cancel();
          return;
        }
        if (key.includes("\u001b[A") || key === "k") {
          selected = (selected - 1 + options.length) % options.length;
          render();
          return;
        }
        if (key.includes("\u001b[B") || key === "j") {
          selected = (selected + 1) % options.length;
          render();
          return;
        }
        if (key.includes(" ") || key.includes("\r") || key.includes("\n")) {
          finish();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async reviewAction(title: string, body: string[] | (() => string[])): Promise<"save" | "cancel"> {
    const options: SelectOption<"save" | "cancel">[] = [
      { value: "save", label: "Save setup", description: "Write the user config now." },
      { value: "cancel", label: "Cancel", description: "Return to chat without changing config." },
    ];
    let selected = 0;
    this.#rl?.pause();
    const render = () => {
      const bodyLines = typeof body === "function" ? body() : body;
      const choices = options.map((option, index) => {
        const active = index === selected;
        return renderSetupOptionLine(option.label, option.description, active);
      });
      this.renderCenteredPanel(title, [...bodyLines, "", ...choices, "", setupHint("↑/↓ move · space/enter select · esc cancel")], true);
    };
    render();
    return await new Promise((resolve) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = (value: "save" | "cancel") => {
        cleanup();
        stdout.write("\n");
        resolve(value);
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key.includes("\u0003") || key === "\u001b") {
          finish("cancel");
          return;
        }
        if (key.includes("\u001b[A") || key === "k") {
          selected = (selected - 1 + options.length) % options.length;
          render();
          return;
        }
        if (key.includes("\u001b[B") || key === "j") {
          selected = (selected + 1) % options.length;
          render();
          return;
        }
        if (key.includes(" ") || key.includes("\r") || key.includes("\n")) {
          finish(options[selected]?.value ?? "save");
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async multiSelect<T extends string>(title: string, options: SelectOption<T>[], defaults: boolean[] = [], footer: string[] = []): Promise<T[]> {
    if (!options.length) {
      return [];
    }
    let selected = 0;
    const checked = new Set<T>();
    options.forEach((option, index) => {
      if (defaults[index]) {
        checked.add(option.value);
      }
    });
    this.#rl?.pause();
    const render = () => {
      const start = Math.max(0, Math.min(selected - 6, Math.max(0, options.length - 12)));
      const visible = options.slice(start, start + 12);
      const lines = visible.map((option, offset) => {
        const index = start + offset;
        const active = index === selected;
        const mark = checked.has(option.value) ? fg256(75, "on ") : fg256(244, "off");
        const label = `${mark} ${option.label}`;
        return renderSetupOptionLine(label, option.description, active);
      });
      this.renderCenteredPanel(title, [...lines, "", setupHint("↑/↓ move · space toggle · enter save · esc cancel"), ...footer], true);
    };
    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        cleanup();
        stdout.write("\n");
        resolve([...checked]);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key.includes("\u0003") || key === "\u001b") {
          cancel();
          return;
        }
        if (key.includes("\u001b[A") || key === "k") {
          selected = (selected - 1 + options.length) % options.length;
          render();
          return;
        }
        if (key.includes("\u001b[B") || key === "j") {
          selected = (selected + 1) % options.length;
          render();
          return;
        }
        if (key.includes(" ")) {
          const value = options[selected]?.value;
          if (value) {
            if (checked.has(value)) {
              checked.delete(value);
            } else {
              checked.add(value);
            }
          }
          render();
          return;
        }
        if (key.includes("\r") || key.includes("\n")) {
          finish();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private describeModelSetup(setup: ModelSetup): string {
    return describeModelSetupForDisplay(setup);
  }

  private describeOmniConfig(config: VllmAgentConfig): string {
    const configured = Object.entries(config.omni.endpoints).filter(([, endpoint]) => endpoint?.base_url && endpoint.model);
    if (!config.omni.enabled || !configured.length) {
      return "disabled";
    }
    return configured.map(([name, endpoint]) => `${name}:${endpoint?.model}`).join(" · ");
  }

  private describeWebSearchConfig(config: VllmAgentConfig): string {
    const web = config.web_search;
    const label = webSearchProviderLabel(web.provider);
    if (web.provider === "auto") {
      return `${label} · fallback ready`;
    }
    if (web.provider === "off") {
      return `${label} · zero-key fallback`;
    }
    const auth = web.api_key_ref ? "vault auth" : web.provider === "jina" ? "public/no auth" : "no auth";
    const base = web.base_url ? ` · ${web.base_url}` : "";
    return `${label}${base} · ${auth}`;
  }

  private async renderModelView(args: string): Promise<void> {
    if (!this.app.config.model_setup.base_url) {
      this.renderNotice("No model endpoint configured. Use /setup first.");
      return;
    }
    const probe = await this.probeChatModels(this.app.config);
    if (probe.errors.some((error) => error.includes("API key is missing from the local vault"))) {
      this.renderPanel("Model", [
        fg256(203, "The external provider key is missing from the local vault."),
        "Run /setup and paste the API key once. The user config stores only api_key_ref.",
      ]);
      return;
    }
    const requested = args.trim();
    const selected = requested ? this.resolveModelSelection(requested, probe.models) : await this.pickModel("Model Selector", probe, this.app.config.model_setup.model);
    if (!selected) {
      this.renderNotice("No model selected.");
      return;
    }
    this.app.config.model_setup.model = selected;
    const target = await saveUserConfig(this.app.config);
    if (!this.app.configFiles.includes(target)) {
      this.app.configFiles.push(target);
    }
    this.renderPanel("Model Saved", [`${fg256(48, "✓")} ${selected}`, `${fg256(39, "Config")} ${target}`]);
  }

  private async renderAccessView(args: string): Promise<void> {
    if (isAccessStatusRequest(args)) {
      this.renderPanel("Access", accessStatusLines(this.app.config, this.app.workspace));
      return;
    }
    const requested = parseAccessMode(args);
    if (args.trim() && !requested) {
      this.renderNotice("Unknown access mode. Use /access full, auto, ask, custom, or status.");
      return;
    }
    const mode = requested ?? await this.chooseAccessMode();
    const nextConfig = structuredClone(this.app.config);
    setWorkspacePermissionMode(nextConfig, this.app.workspace, mode);
    const target = await saveUserConfig(nextConfig);
    Object.assign(this.app.config, nextConfig);
    if (!this.app.configFiles.includes(target)) {
      this.app.configFiles.push(target);
    }
    this.renderPanel("Access", accessStatusLines(this.app.config, this.app.workspace, target));
  }

  private async chooseAccessMode(): Promise<PermissionMode> {
    const current = effectiveWorkspacePermission(this.app.config, this.app.workspace).mode;
    const options: SelectOption<PermissionMode>[] = [
      { value: "full_access", label: "Full access", description: "Read/write local files and run tools without approval prompts" },
      { value: "auto_approve", label: "Auto approve", description: "Run normal tools automatically; stop for risky or external access" },
      { value: "ask", label: "Request approval", description: "Ask before writes, shell, network, or external file access" },
      { value: "custom", label: "Custom", description: "Use this workspace's custom rules from config" },
    ];
    const defaultIndex = Math.max(0, options.findIndex((option) => option.value === current));
    return await this.selectOption("Access", options, defaultIndex, [
      `${fg256(39, "Workspace")} ${compactWorkspacePath(this.app.workspace.root)}`,
      `${fg256(39, "Current")} ${accessModeLabel(current)}`,
    ]);
  }

  private async renderEndpointView(): Promise<void> {
    const snapshot = await new EndpointSignals(this.app.config).snapshot();
    const rtk = await resolveRtkStatus(this.app.config, { allowDownload: false });
    this.renderPanel("System", endpointStatusLinesForDisplay(snapshot, this.app.config, this.describeWebSearchConfig(this.app.config), rtk));
  }

  private renderCacheView(): void {
    const session = this.optionalSession();
    if (!session) {
      this.renderPanel(PREFIX_CACHE_REPORT_TITLE, ["No active session yet. Run a prompt first."]);
      return;
    }
    const evidence = this.app.store.listEndpointEvidence(session.session_id);
    const events = this.app.store.listEvents(session.session_id);
    const lines = evidence.slice(-12).map((item, index) => {
      const usage = item.usage as ModelUsage | undefined;
      return `  ${index + 1}. ${renderCacheReportTurn({
        usage,
        cacheKind: cacheTurnKind(events, stringField(item.run_id)),
      })}`;
    });
    this.renderPanel(
      PREFIX_CACHE_REPORT_TITLE,
      evidence.length
        ? [...cacheEvidenceOverview(evidence, events), "", fg256(39, "Recent turns"), ...lines]
        : ["No prefix cache records yet."],
    );
  }

  private renderRtkView(): void {
    const session = this.optionalSession();
    if (!session) {
      this.renderPanel("RTK", ["No active session yet. Run a prompt first."]);
      return;
    }
    this.renderPanel("RTK", renderRtkSessionLines(this.app.store.listEvents(session.session_id), terminalWidth()));
  }

  private async renderContextView(args = ""): Promise<void> {
    const action = args.trim().toLowerCase();
    if (action === "reindex" || action === "rebuild") {
      this.app.runtime.codeIntelligence.startIndexing("manual_reindex", { force: true });
      this.renderPanel("Context", ["Context index rebuild requested.", fg256(244, "Use /context to inspect progress.")]);
      return;
    }
    const session = this.optionalSession();
    const contextWindow = this.app.config.model_setup.context_window ?? this.app.config.context.context_window;
    const allEvents = session ? this.app.store.listEvents(session.session_id) : [];
    const events = allEvents.filter((event) => isContextCompressionEvent(event));
    const latestCompacted = allEvents.filter((event) => event.type === "context.compacted").at(-1);
    const latestEvidence = allEvents.filter((event) => event.type === "evidence.context_compression").at(-1);
    const summary = stringField(latestCompacted?.data.summary);
    const summaryLines = summary ? summary.split(/\r?\n/).filter(Boolean).slice(0, 8) : [];
    const latest = latestCompacted
      ? [
          `${fg256(39, "reason")} ${stringField(latestCompacted.data.reason) ?? "unknown"}`,
          `${fg256(39, "archive")} ${stringField(latestCompacted.data.archive_resource_uri) ?? "none"}`,
          `${fg256(39, "protected")} ${numberField(latestCompacted.data.protected_tail_events) ?? "unknown"} user prompts preserved`,
          `${fg256(39, "before")} ${numberField(latestCompacted.data.estimated_tokens_before) ?? "unknown"} estimated tokens`,
          ...(latestEvidence
            ? [
                `${fg256(39, "threshold")} ${numberField(latestEvidence.data.threshold_tokens) ?? "unknown"} tokens`,
                `${fg256(39, "record")} persisted`,
              ]
            : []),
          ...(summaryLines.length ? ["", fg256(39, "Summary"), ...summaryLines.map((line) => `  ${truncateToWidth(line, Math.max(20, terminalWidth() - 8))}`)] : []),
        ]
      : ["  none"];
    const recent = events.slice(-8).map((event) => {
      const reason = stringField(event.data.reason);
      const uri = stringField(event.data.archive_resource_uri);
      const suffix = [reason, uri].filter(Boolean).join(" · ");
      return `  ${event.created_at} ${event.type}${suffix ? ` · ${truncateToWidth(suffix, Math.max(24, terminalWidth() - 42))}` : ""}`;
    });
    const intelligence = this.app.runtime.codeIntelligence.status();
    const cg = intelligence.codegraph;
    this.renderPanel("Context", [
      `threshold ${(this.app.config.context.compression_threshold * 100).toFixed(0)}%`,
      `window ${contextWindow}`,
      `protected recent loops ${this.app.config.context.protected_recent_loops ?? 3}`,
      `forced ${this.app.config.context.force_compression ? "on" : "off"}`,
      "",
      fg256(39, "Code intelligence"),
      `  engine ${cg.state}${cg.phase ? ` · ${cg.phase}` : ""}${cg.current !== undefined && cg.total !== undefined ? ` · ${cg.current}/${cg.total}` : ""}`,
      `  index ${cg.files ?? "?"} files · ${cg.nodes ?? "?"} symbols · ${cg.edges ?? "?"} links · watcher ${cg.watcher ?? "unknown"}`,
      `  lsp ${intelligence.lsp.languages.length} language profiles · ast ${intelligence.ast.languages.join(", ")}`,
      ...(cg.languages?.length ? [`  languages ${cg.languages.slice(0, 10).join(", ")}`] : []),
      ...(cg.frameworks?.length ? [`  frameworks ${cg.frameworks.slice(0, 8).join(", ")}`] : []),
      ...(cg.error ? [`  ${fg256(203, truncateToWidth(cg.error, Math.max(24, terminalWidth() - 8)))}`] : []),
      `  ${fg256(39, "/context reindex")} rebuild context index`,
      "",
      fg256(39, "Latest compression"),
      ...latest,
      "",
      fg256(39, "Compression events"),
      ...(recent.length ? recent : ["  none"]),
    ]);
  }

  private renderToolsView(args = ""): void {
    const action = args.trim().toLowerCase();
    if (action === "expand" || action === "full") {
      this.#toolTraceMode = "expanded";
      this.renderLatestToolTrace("Tool Trace", false);
      return;
    }
    if (action === "compact" || action === "fold") {
      this.#toolTraceMode = "compact";
      this.renderLatestToolTrace("Tool Trace", true);
      return;
    }
    if (action === "last") {
      this.renderLatestToolTrace("Tool Trace", this.#toolTraceMode === "compact");
      return;
    }
    const registry = new ToolRegistry(this.app.config, this.app.workspace, this.app.store);
    const tools = registry.list();
    this.renderPanel("Tools", [
      `${tools.length} fixed tools`,
      `${fg256(39, "/tools expand")} full latest tool run · ${fg256(39, "/tools compact")} fold long successful runs`,
      "",
      ...tools.map((tool) => `  ${fg256(permissionColor(tool.permission), tool.permission.padEnd(13))} ${displayToolName(tool.name)}`),
      "",
      fg256(243, "Renderers: diff, shell/process, git, todo, activity, code intelligence, and Omni cards."),
    ]);
  }

  private renderLatestToolTrace(title: string, collapseCompact: boolean): void {
    const sessionId = this.#sessionId;
    if (!sessionId) {
      this.renderPanel(title, ["No active session yet."]);
      return;
    }
    const toolEvents = this.app.store.listEvents(sessionId).filter((event) => event.type === "tool.call" || event.type === "tool.result");
    const lastRunId = toolEvents.slice().reverse().find((event) => event.run_id)?.run_id;
    if (!lastRunId) {
      this.renderPanel(title, ["No tool trace recorded yet."]);
      return;
    }
    const lines = renderToolCards(
      toolEvents.filter((event) => event.run_id === lastRunId),
      this.app.store,
      { collapseCompact },
    );
    this.renderPanel(title, [
      `${collapseCompact ? "compact" : "expanded"} · run ${lastRunId}`,
      "",
      ...(lines.length ? lines : ["No tool trace recorded yet."]),
    ]);
  }

  private async renderSkillsView(args: string): Promise<void> {
    const query = args.trim();
    if (query === "list" || query.startsWith("list ")) {
      await this.renderSkillLauncher(query.replace(/^list\s*/, ""));
      return;
    }
    if (query === "manage") {
      const nextConfig = structuredClone(this.app.config);
      nextConfig.skills.enabled = await this.manageSkillSelection(nextConfig, "");
      const target = await saveUserConfig(nextConfig);
      Object.assign(this.app.config, nextConfig);
      if (!this.app.configFiles.includes(target)) {
        this.app.configFiles.push(target);
      }
      this.renderPanel("Skills Saved", [`${fg256(48, "✓")} ${nextConfig.skills.enabled.length} enabled`, `${fg256(39, "Config")} ${target}`]);
      return;
    }
    if (!query) {
      const action = await this.chooseSkillAction();
      if (action === "list") {
        await this.renderSkillLauncher("");
        return;
      }
      if (action === "manage") {
        await this.renderSkillsView("manage");
        return;
      }
    }
    await this.renderSkillLauncher(query);
  }

  private async renderSkillLauncher(query: string): Promise<void> {
    const skills = await new SkillRegistry(this.app.workspace, this.app.config).discover();
    if (!skills.length) {
      this.renderPanel("Skills", ["No skills discovered."]);
      return;
    }
    const direct = query ? this.resolveSkillQuery(query, skills) : undefined;
    const skill = direct ?? (await this.chooseSkillFromCatalog(skills, query));
    await this.triggerSkill(skill);
  }

  private async triggerSkill(skill: SkillDescriptor): Promise<void> {
    const enabled = new Set(this.app.config.skills.enabled);
    const wasEnabled = enabled.has(skill.id) || enabled.has(skill.name);
    if (!wasEnabled) {
      enabled.add(skill.id);
      this.app.config.skills.enabled = [...enabled].sort();
      const target = await saveUserConfig(this.app.config);
      if (!this.app.configFiles.includes(target)) {
        this.app.configFiles.push(target);
      }
    }
    this.renderPanel("Skill", [
      `${fg256(48, "✓")} ${wasEnabled ? "ready" : "enabled"} · ${skill.name}`,
      fg256(244, "Only the compact skill index is kept in the prompt. The agent can load details with skill_read."),
    ]);
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Skill is enabled. Configure a model with /setup before triggering model work.");
      return;
    }
    this.enqueuePrompt(`Use the ${skill.name} skill (${skill.id}). Read its body with skill_read if useful, then apply it to the current task. If no concrete task is present, ask one concise clarifying question.`);
  }

  private resolveSkillQuery(query: string, skills: SkillDescriptor[]): SkillDescriptor | undefined {
    const normalized = query.toLowerCase();
    return skills.find((skill) => skill.id.toLowerCase() === normalized || skill.name.toLowerCase() === normalized);
  }

  private async chooseSkillFromCatalog(skills: SkillDescriptor[], initialQuery = ""): Promise<SkillDescriptor> {
    const enabled = new Set(this.app.config.skills.enabled);
    let query = initialQuery;
    let selected = 0;
    let renderedLines = 0;
    this.#rl?.pause();

    const filteredSkills = () => {
      const normalized = query.toLowerCase();
      return skills
        .filter((skill) => !normalized || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(normalized))
        .sort((a, b) => {
          const aEnabled = enabled.has(a.id) || enabled.has(a.name);
          const bEnabled = enabled.has(b.id) || enabled.has(b.name);
          if (aEnabled !== bEnabled) {
            return aEnabled ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
    };

    return await new Promise((resolve, reject) => {
      const erase = () => {
        if (renderedLines) {
          stdout.write(`\x1b[${Math.max(0, renderedLines - 1)}A\r\x1b[J`);
          renderedLines = 0;
        }
      };
      const cleanup = () => {
        erase();
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        const skill = filteredSkills()[selected];
        if (!skill) {
          render();
          return;
        }
        cleanup();
        resolve(skill);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const render = () => {
        const filtered = filteredSkills();
        selected = Math.max(0, Math.min(selected, Math.max(0, filtered.length - 1)));
        const width = terminalWidth();
        const start = Math.max(0, Math.min(selected - 3, Math.max(0, filtered.length - 7)));
        const visible = filtered.slice(start, start + 7);
        const lines = [
          bg256(236, padRight("  Skills", width)),
          bg256(236, padRight(`  ${skills.length} discovered · ${enabled.size} enabled · type to filter`, width)),
          bg256(236, padRight("", width)),
          bg256(236, padRight(`  search  ${query || fg256(244, "all skills")}`, width)),
          ...visible.map((skill, offset) => {
            const index = start + offset;
            const active = index === selected;
            const on = enabled.has(skill.id) || enabled.has(skill.name);
            const marker = active ? fg256(75, "›") : " ";
            const name = active ? fg256(87, padRight(truncateToWidth(skill.name, 28), 30)) : fg256(250, padRight(truncateToWidth(skill.name, 28), 30));
            const status = on ? fg256(75, "enabled ") : fg256(244, "disabled");
            const desc = fg256(244, truncateToWidth(skill.description, Math.max(20, width - 54)));
            return bg256(236, padRight(`${marker} ${name} ${status} · ${desc}`, width));
          }),
          bg256(236, padRight("", width)),
          fg256(244, "  tab insert skill · enter trigger · ↑/↓ choose · esc clear"),
        ];
        erase();
        renderedLines = lines.length;
        stdout.write(lines.join("\n"));
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key.includes("\u0003") || key === "\u001b") {
          cancel();
          return;
        }
        if (key.includes("\u001b[A")) {
          selected = (selected - 1 + filteredSkills().length) % Math.max(1, filteredSkills().length);
          render();
          return;
        }
        if (key.includes("\u001b[B")) {
          selected = (selected + 1) % Math.max(1, filteredSkills().length);
          render();
          return;
        }
        if (key.includes("\r") || key.includes("\n") || key.includes("\t")) {
          finish();
          return;
        }
        if (key.includes("\u007f")) {
          query = query.slice(0, -1);
          selected = 0;
          render();
          return;
        }
        const printable = printableText(key);
        if (printable) {
          query += printable;
          selected = 0;
          render();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async renderSkillDetailView(skill: SkillDescriptor): Promise<void> {
    const enabled = this.app.config.skills.enabled.includes(skill.id) || this.app.config.skills.enabled.includes(skill.name);
    const body = skill.path ? await fs.readFile(skill.path, "utf8").catch(() => "") : "";
    const preview = stripFrontmatter(body)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(0, 12);
    this.renderPanel("Skill", [
      `${enabled ? fg256(75, "enabled") : fg256(244, "disabled")} · ${skill.name}`,
      fg256(244, skill.description || "No description"),
      "",
      `${fg256(75, "Use")} ${fg256(252, `$ ${skill.id}`)} ${fg256(244, "to reopen this skill. /skills manage changes enabled skills.")}`,
      ...(preview.length ? ["", fg256(75, "Preview"), ...preview.map((line) => `  ${truncateToWidth(line, Math.max(20, terminalWidth() - 8))}`)] : []),
    ]);
  }

  private async chooseSkillAction(): Promise<SkillAction> {
    const options: SelectOption<SkillAction>[] = [
      { value: "list", label: "List skills", description: "Open the skill catalog and trigger a skill." },
      { value: "manage", label: "Enable/Disable", description: "Turn skills on or off." },
    ];
    let selected = 0;
    let renderedLines = 0;
    this.#rl?.pause();
    return await new Promise((resolve, reject) => {
      const erase = () => {
        if (renderedLines) {
          stdout.write(`\x1b[${Math.max(0, renderedLines - 1)}A\r\x1b[J`);
          renderedLines = 0;
        }
      };
      const cleanup = () => {
        erase();
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const render = () => {
        const width = terminalWidth();
        const lines = [
          bg256(236, padRight("  Skills", width)),
          bg256(236, padRight("  Choose an action", width)),
          bg256(236, padRight("", width)),
          ...options.map((option, index) => {
            const active = index === selected;
            const marker = active ? fg256(75, "›") : " ";
            const label = active ? fg256(87, padRight(`${index + 1}. ${option.label}`, 24)) : fg256(250, padRight(`${index + 1}. ${option.label}`, 24));
            return bg256(236, padRight(`${marker} ${label} ${fg256(244, option.description ?? "")}`, width));
          }),
          bg256(236, padRight("", width)),
          fg256(244, "  ↑/↓ move · enter select · esc cancel · $ opens the skill catalog"),
        ];
        erase();
        renderedLines = lines.length;
        stdout.write(lines.join("\n"));
      };
      const finish = () => {
        const value = options[selected]?.value ?? "list";
        cleanup();
        resolve(value);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key.includes("\u0003") || key === "\u001b") {
          cancel();
          return;
        }
        if (key.includes("\u001b[A")) {
          selected = (selected - 1 + options.length) % options.length;
          render();
        }
        if (key.includes("\u001b[B")) {
          selected = (selected + 1) % options.length;
          render();
        }
        if (key.includes("\r") || key.includes("\n")) {
          finish();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async renderSkillListView(query: string): Promise<void> {
    const skills = await new SkillRegistry(this.app.workspace, this.app.config).discover();
    const enabled = new Set(this.app.config.skills.enabled);
    const normalized = query.toLowerCase();
    const filtered = skills
      .filter((skill) => !normalized || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(normalized))
      .slice(0, 24);
    this.renderPanel("Skills", [
      `${enabled.size} enabled · ${skills.length} discovered`,
      "",
      ...filtered.map((skill) => {
        const status = enabled.has(skill.id) || enabled.has(skill.name) ? fg256(75, "on ") : fg256(244, "off");
        return `  ${status} ${padRight(truncateToWidth(skill.name, 26), 28)} ${fg256(244, truncateToWidth(skill.description, Math.max(24, terminalWidth() - 42)))}`;
      }),
      ...(skills.length > filtered.length ? ["", fg256(244, `Showing ${filtered.length}; use $ and type to filter.`)] : []),
    ]);
  }

  private async renderGoalView(args: string): Promise<void> {
    const parsed = parseModeAction(args, new Set(["show", "set", "plan", "pause", "resume", "budget", "complete", "drop"]));
    const existingSession = this.optionalSession();
    if (!existingSession && parsed.action === "show") {
      this.renderPanel("Goal", ["No active session yet. Use /goal <objective> to start one."]);
      return;
    }
    const session = existingSession ?? this.createModeSession(titleFromPromptForMode(parsed.rest || "Goal"));
    const current = readGoalState(this.app.store, session.session_id);

    if (!parsed.action && !parsed.rest) {
      if (current) {
        this.renderGoalPanel(current);
        return;
      }
      const objective = (await this.askModeObjective("Goal objective")).trim();
      if (!objective) {
        this.renderNotice("No goal objective entered.");
        return;
      }
      await this.startGoal(session, objective);
      return;
    }

    if (!parsed.action || parsed.action === "set") {
      const objective = parsed.rest.trim() || (await this.askModeObjective("Goal objective", current?.goal.objective)).trim();
      if (!objective) {
        this.renderNotice("No goal objective entered.");
        return;
      }
      await this.startGoal(session, objective);
      return;
    }

    if (parsed.action === "show") {
      this.renderGoalPanel(current);
      return;
    }

    if (!current) {
      this.renderPanel("Goal", ["No goal set. Use /goal <objective> to start one."]);
      return;
    }

    if (parsed.action === "pause") {
      const next = cloneGoalState(current);
      next.enabled = false;
      if (next.goal.status === "active" || next.goal.status === "budget-limited") {
        next.goal.status = "paused";
      }
      next.goal.updated_at = new Date().toISOString();
      this.renderGoalPanel(writeGoalState(this.app.store, session.session_id, next));
      return;
    }

    if (parsed.action === "resume") {
      const next = cloneGoalState(current);
      if (next.goal.status === "complete" || next.goal.status === "dropped") {
        this.renderNotice(`Cannot resume a ${next.goal.status} goal.`);
        return;
      }
      next.enabled = true;
      next.goal.status = "active";
      next.goal.updated_at = new Date().toISOString();
      const saved = writeGoalState(this.app.store, session.session_id, next);
      this.renderGoalPanel(saved);
      this.enqueueGoalContinuation(saved.goal.objective);
      return;
    }

    if (parsed.action === "plan") {
      this.renderGoalPanel(current);
      this.enqueueGoalPlanningContinuation(current.goal.objective);
      return;
    }

    if (parsed.action === "budget") {
      const raw = parsed.rest.trim() || (await this.ask("Goal budget (positive integer or off)", current.goal.token_budget === undefined ? "off" : String(current.goal.token_budget))).trim();
      const next = cloneGoalState(current);
      if (raw.toLowerCase() === "off") {
        delete next.goal.token_budget;
      } else {
        const value = Number.parseInt(raw, 10);
        validateTokenBudget(value);
        next.goal.token_budget = value;
        if (next.goal.status === "budget-limited" && next.goal.tokens_used < value) {
          next.goal.status = "active";
          next.enabled = true;
        }
      }
      next.goal.updated_at = new Date().toISOString();
      this.renderGoalPanel(writeGoalState(this.app.store, session.session_id, next));
      return;
    }

    if (parsed.action === "complete" || parsed.action === "drop") {
      if (parsed.action === "complete") {
        const incompleteMessage = incompleteGoalPlanningMessage(current.goal);
        if (incompleteMessage) {
          this.renderNotice(incompleteMessage);
          this.renderGoalPanel(current);
          return;
        }
      }
      const next = cloneGoalState(current);
      const summary = parsed.rest.trim() || (await this.ask(parsed.action === "complete" ? "Completion summary" : "Drop reason", current.goal.summary)).trim();
      if (parsed.action === "complete" && !summary) {
        this.renderNotice("Completion summary is required.");
        return;
      }
      if (summary) {
        next.goal.summary = summary;
      }
      next.enabled = false;
      next.goal.status = parsed.action === "complete" ? "complete" : "dropped";
      next.goal.updated_at = new Date().toISOString();
      const runId = parsed.action === "complete" ? randomId("goal") : undefined;
      const saved = writeGoalState(this.app.store, session.session_id, next, runId);
      if (parsed.action === "complete" && runId) {
        recordGoalCompletionReport(this.app.store, session.session_id, runId);
      }
      this.renderGoalPanel(saved);
    }
  }

  private async startGoal(session: SessionRecord, objective: string): Promise<void> {
    const state = writeGoalState(this.app.store, session.session_id, createGoalState({ objective }));
    this.renderGoalPanel(state);
    this.enqueueGoalContinuation(objective);
  }

  private enqueueGoalContinuation(objective: string): void {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Goal is saved. Configure a model with /setup before triggering model work.");
      return;
    }
    this.enqueuePrompt(
      [
        `Goal objective: ${objective}`,
        "If this goal is broad or multi-step, call the goal tool with op=decompose to create internal steps before risky edits.",
        "Execute the goal while keeping step status, notes, and evidence current with goal op=update_step. Complete only when the objective is genuinely handled.",
      ].join("\n"),
      { renderPrompt: false },
    );
  }

  private enqueueGoalPlanningContinuation(objective: string): void {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Goal is saved. Configure a model with /setup before triggering model planning.");
      return;
    }
    this.enqueuePrompt(
      [
        `Goal objective: ${objective}`,
        "Review the current goal state. Decompose or update the internal goal plan with the goal tool, including active step, blockers, and verification steps.",
      ].join("\n"),
      { renderPrompt: false },
    );
  }

  private renderGoalPanel(state: GoalState | undefined): void {
    if (!state) {
      this.renderPanel("Goal", ["No goal set."]);
      return;
    }
    const goal = state.goal;
    const status = `${goal.status}${state.enabled ? "" : " (paused)"}`;
    const lines = [`${fg256(39, status)} ${goal.objective}`];
    const usage = goalPanelUsage(goal);
    if (usage) {
      lines.push(fg256(244, usage));
    }
    if (goal.summary) {
      lines.push(`${fg256(39, "summary")} ${goal.summary}`);
    }
    if (goal.planning) {
      lines.push(`${fg256(39, "plan")} ${goalPlanningProgressSummary(goal.planning)}`);
      const active = goal.planning.active_step_id ? goal.planning.steps.find((step) => step.id === goal.planning?.active_step_id) : undefined;
      if (active) {
        lines.push(`${fg256(39, "now")} ${goalStepStatusMarker(active.status)} ${active.id} ${active.title}`);
      }
    } else {
      lines.push(fg256(244, "No internal plan yet."));
    }
    lines.push("", `${fg256(39, "/goal plan")} plan · ${fg256(39, "/goal complete")} complete · ${fg256(39, "/goal pause")} pause · ${fg256(39, "/goal drop")} drop`);
    this.renderPanel("Goal", lines);
  }

  private async renderPlanView(args: string): Promise<void> {
    const parsed = parseModeAction(args, new Set(["show", "set", "pause", "resume", "approve", "drop"]));
    const existingSession = this.optionalSession();
    if (!existingSession && parsed.action === "show") {
      this.renderPanel("Plan", ["No active session yet. Use /plan <objective> to start one."]);
      return;
    }
    const session = existingSession ?? this.createModeSession(titleFromPromptForMode(parsed.rest || "Plan"));
    const current = readPlanState(this.app.store, session.session_id);

    if (!parsed.action && !parsed.rest) {
      if (current) {
        this.renderPlanPanel(current);
        return;
      }
      const objective = (await this.askModeObjective("Plan objective")).trim();
      if (!objective) {
        this.renderNotice("No plan objective entered.");
        return;
      }
      await this.startPlan(session, objective);
      return;
    }

    if (!parsed.action || parsed.action === "set") {
      const objective = parsed.rest.trim() || (await this.askModeObjective("Plan objective", current?.plan.objective)).trim();
      if (!objective) {
        this.renderNotice("No plan objective entered.");
        return;
      }
      await this.startPlan(session, objective);
      return;
    }

    if (parsed.action === "show") {
      this.renderPlanPanel(current);
      return;
    }

    if (!current) {
      this.renderPanel("Plan", ["No plan set. Use /plan <objective> to start one."]);
      return;
    }

    if (parsed.action === "pause") {
      const next = clonePlanState(current);
      next.enabled = false;
      if (next.plan.status === "drafting") {
        next.plan.status = "paused";
      }
      next.plan.updated_at = new Date().toISOString();
      this.renderPlanPanel(writePlanState(this.app.store, session.session_id, next));
      return;
    }

    if (parsed.action === "resume") {
      const next = clonePlanState(current);
      if (next.plan.status === "approved" || next.plan.status === "dropped") {
        this.renderNotice(`Cannot resume an ${next.plan.status} plan.`);
        return;
      }
      next.enabled = true;
      next.plan.status = "drafting";
      next.plan.updated_at = new Date().toISOString();
      const saved = writePlanState(this.app.store, session.session_id, next);
      this.renderPlanPanel(saved);
      this.enqueuePlanContinuation(saved.plan.objective);
      return;
    }

    if (parsed.action === "approve" || parsed.action === "drop") {
      const next = clonePlanState(current);
      if (parsed.action === "approve") {
        const blockMessage = planApprovalBlockMessage(next);
        if (blockMessage) {
          this.renderNotice(blockMessage);
          this.renderPlanPanel(current);
          return;
        }
      }
      const summary = parsed.rest.trim() || (await this.ask(parsed.action === "approve" ? "Approval summary" : "Drop reason", current.plan.summary)).trim();
      if (summary) {
        next.plan.summary = summary;
      }
      next.enabled = false;
      next.plan.status = parsed.action === "approve" ? "approved" : "dropped";
      next.plan.updated_at = new Date().toISOString();
      const saved = writePlanState(this.app.store, session.session_id, next);
      this.renderPlanPanel(saved);
      if (parsed.action === "approve") {
        this.attachApprovedPlanToGoal(saved, session.session_id);
        this.enqueueApprovedPlanExecution(saved);
      }
    }
  }

  private async startPlan(session: SessionRecord, objective: string): Promise<void> {
    const state = writePlanState(this.app.store, session.session_id, createPlanState({ objective }));
    this.renderPlanPanel(state);
    this.enqueuePlanContinuation(objective);
  }

  private enqueuePlanContinuation(objective: string): void {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Plan is saved. Configure a model with /setup before triggering model work.");
      return;
    }
    this.enqueuePrompt(
      [
        `Plan objective: ${objective}`,
        "Enter plan mode for the active plan. Do not call plan create again unless there is no active plan; use plan get/update for the existing draft. Inspect first and avoid state-changing actions while drafting unless the user explicitly requested that specific action. For non-trivial tasks, ask concise clarify questions before the final plan when scope, constraints, risk tolerance, tradeoffs, or execution preference could change the plan. Resolve open questions before finalizing. Keep the plan updated with the plan tool, then call plan approve as soon as the proposed plan is ready so the user can implement it or type revision feedback. If approval is declined, revise the plan from the feedback and ask again.",
      ].join("\n"),
      { renderPrompt: false },
    );
  }

  private enqueueApprovedPlanExecution(state: PlanState): void {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Plan is approved. Configure a model with /setup before triggering model work.");
      return;
    }
    this.enqueuePrompt(
      [
        `Approved plan objective: ${state.plan.objective}`,
        state.plan.summary ? `Plan summary: ${state.plan.summary}` : undefined,
        state.plan.body ? `Plan body:\n${state.plan.body}` : undefined,
        "Execute the approved plan. Keep todo state current and verify before final response.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n\n"),
      { renderPrompt: false },
    );
  }

  private attachApprovedPlanToGoal(planState: PlanState, sessionId: string): void {
    const goalState = readGoalState(this.app.store, sessionId);
    if (!goalState || goalState.goal.status === "complete" || goalState.goal.status === "dropped") {
      return;
    }
    writeGoalState(
      this.app.store,
      sessionId,
      attachGoalPlanSnapshot(goalState, {
        id: planState.plan.id,
        objective: planState.plan.objective,
        summary: planState.plan.summary,
        body: planState.plan.body,
        approved_at: planState.plan.updated_at,
      }),
    );
  }

  private renderPlanPanel(state: PlanState | undefined): void {
    if (!state) {
      this.renderPanel("Plan", ["No plan set."]);
      return;
    }
    const plan = state.plan;
    const status = state.enabled ? plan.status : `${plan.status} inactive`;
    const header = `${fg256(75, "Plan")} ${fg256(244, "·")} ${fg256(252, truncateToWidth(plan.objective, Math.max(24, safeTerminalWidth() - 22)))} ${fg256(244, `· ${status}`)}`;
    const hasBody = Boolean(plan.body?.trim());
    const lines = hasBody
      ? [
          header,
          "",
          ...renderPlanDocumentSurface(plan, { width: safeTerminalWidth(), maxBodyLines: Number.POSITIVE_INFINITY, includeHeader: true }),
          "",
          `${fg256(244, "Review")} ${fg256(39, "/plan approve")} ${fg256(244, "or type requested changes when asked.")}`,
        ]
      : [
          header,
          fg256(244, "Drafting. The agent will inspect, ask clarifying questions when needed, then present a plan for approval."),
        ];
    this.writeTranscript(`${lines.join("\n")}\n\n`);
  }

  private async renderAutoresearchView(args: string): Promise<void> {
    const parsed = parseModeAction(args, new Set(["status", "off", "clear"]));
    const existingSession = this.optionalSession();
    if (!existingSession && parsed.action === "status") {
      this.renderPanel("Autoresearch", ["No active session yet. Use /autoresearch <goal> to start one."]);
      return;
    }
    const session = existingSession ?? this.createModeSession(titleFromPromptForMode(parsed.rest || "Autoresearch"));
    const state = readAutoresearchState(this.app.store, session.session_id);

    if (parsed.action === "status") {
      this.renderAutoresearchPanel(state);
      return;
    }
    if (parsed.action === "off") {
      this.renderAutoresearchPanel(setAutoresearchMode(this.app.store, session.session_id, { mode: "off", goal: state.goal }));
      return;
    }
    if (parsed.action === "clear") {
      this.renderAutoresearchPanel(setAutoresearchMode(this.app.store, session.session_id, { mode: "clear" }));
      return;
    }

    if (!parsed.rest && state.enabled) {
      this.renderAutoresearchPanel(setAutoresearchMode(this.app.store, session.session_id, { mode: "off", goal: state.goal }));
      return;
    }

    const goal = parsed.rest.trim() || (await this.askModeObjective("Autoresearch goal", state.goal)).trim();
    const next = setAutoresearchMode(this.app.store, session.session_id, { mode: "on", goal: goal || state.goal });
    await this.renderAutoresearchStartSummary(goal || state.goal, next);
    this.renderAutoresearchPanel(next);
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Autoresearch is enabled. Configure a model with /setup before triggering model work.");
      return;
    }
    this.enqueuePrompt(
      [
        goal ? `Autoresearch goal: ${goal}` : "Autoresearch is enabled.",
        "Set up or continue the benchmark-driven experiment loop. If no experiment exists, create ./autoresearch.sh, validate it, then call init_experiment.",
      ].join("\n"),
    );
  }

  private async renderAutoresearchStartSummary(goal: string | undefined, state: AutoresearchState): Promise<void> {
    let harness = "missing";
    try {
      await fs.access(path.join(this.app.workspace.root, "autoresearch.sh"));
      harness = "present";
    } catch {
      harness = "missing";
    }
    const experiment = state.experiment;
    this.renderPanel("Autoresearch Preflight", [
      `${fg256(39, "Goal")} ${goal ?? experiment?.goal ?? "none"}`,
      `${fg256(39, "Harness")} ${harness} at ./autoresearch.sh`,
      `${fg256(39, "Pending run")} ${experiment?.pending_run ? `run ${experiment.pending_run.id} must be logged first` : "none"}`,
      `${fg256(39, "Prompt cache")} stable system prefix; autoresearch context is injected at the current turn tail`,
      `${fg256(39, "Loop")} validate harness -> run baseline -> log result -> iterate`,
    ]);
  }

  private renderAutoresearchPanel(state: AutoresearchState): void {
    const experiment = state.experiment;
    if (!state.enabled && !experiment) {
      this.renderPanel("Autoresearch", ["disabled"]);
      return;
    }
    const progress = experiment ? summarizeAutoresearchProgress(experiment) : undefined;
    this.renderPanel("Autoresearch", [
      `${fg256(39, "Mode")} ${state.enabled ? "on" : "off"}`,
      `${fg256(39, "Goal")} ${state.goal ?? experiment?.goal ?? "none"}`,
      ...(experiment
        ? [
            `${fg256(39, "Experiment")} ${experiment.name}`,
            `${fg256(39, "Metric")} ${experiment.primary_metric} (${experiment.metric_unit || "unitless"}, ${experiment.direction} is better)`,
            `${fg256(39, "Best")} ${experiment.best_metric ?? "none"}`,
            `${fg256(39, "Runs")} ${progress?.logged_runs ?? 0} logged · ${progress?.kept_runs ?? 0}${progress?.keep_cap ? `/${progress.keep_cap}` : ""} keep${experiment.pending_run ? ` · pending ${experiment.pending_run.id}` : ""}`,
            ...(experiment.harness_status ? [`${fg256(39, "Harness")} ${experiment.harness_status.message}`] : []),
          ]
        : [fg256(244, "Phase 1: create ./autoresearch.sh and call init_experiment.")]),
      "",
      `${fg256(39, "/autoresearch status")} show · ${fg256(39, "/autoresearch off")} disable · ${fg256(39, "/autoresearch clear")} clear`,
    ]);
  }

  private async manageSkillSelection(config: VllmAgentConfig, initialQuery = ""): Promise<string[]> {
    const skills = await new SkillRegistry(this.app.workspace, config).discover();
    if (!skills.length) {
      this.renderPanel("Skills", ["No skills discovered."]);
      return config.skills.enabled;
    }
    const checked = new Set(config.skills.enabled);
    let query = initialQuery;
    let selected = 0;
    let renderedLines = 0;
    this.#rl?.pause();

    const filteredSkills = () => {
      const normalized = query.toLowerCase();
      return skills
        .filter((skill) => !normalized || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(normalized))
        .sort((a, b) => {
          const aEnabled = checked.has(a.id) || checked.has(a.name);
          const bEnabled = checked.has(b.id) || checked.has(b.name);
          if (aEnabled !== bEnabled) {
            return aEnabled ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
    };

    return await new Promise((resolve, reject) => {
      const erase = () => {
        if (renderedLines) {
          stdout.write(`\x1b[${Math.max(0, renderedLines - 1)}A\r\x1b[J`);
          renderedLines = 0;
        }
      };
      const cleanup = () => {
        erase();
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        cleanup();
        resolve([...checked].sort());
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const render = () => {
        const filtered = filteredSkills();
        selected = Math.max(0, Math.min(selected, Math.max(0, filtered.length - 1)));
        const width = terminalWidth();
        const start = Math.max(0, Math.min(selected - 4, Math.max(0, filtered.length - 9)));
        const visible = filtered.slice(start, start + 9);
        const lines = [
          bg256(236, padRight("  Skills", width)),
          bg256(236, padRight(`  ${checked.size} enabled · ${skills.length} discovered · type to filter`, width)),
          bg256(236, padRight("", width)),
          bg256(236, padRight(`  search  ${query || fg256(244, "all skills")}`, width)),
          ...visible.map((skill, offset) => {
            const index = start + offset;
            const active = index === selected;
            const enabled = checked.has(skill.id) || checked.has(skill.name);
            const marker = active ? fg256(75, "›") : " ";
            const box = enabled ? fg256(87, "[x]") : fg256(244, "[ ]");
            const name = active ? fg256(87, padRight(truncateToWidth(skill.name, 26), 28)) : fg256(250, padRight(truncateToWidth(skill.name, 26), 28));
            const desc = fg256(244, truncateToWidth(skill.description, Math.max(20, width - 42)));
            return bg256(236, padRight(`${marker} ${box} ${name} ${desc}`, width));
          }),
          bg256(236, padRight("", width)),
          fg256(244, "  ↑/↓ move · space toggle · enter save · esc cancel"),
        ];
        erase();
        renderedLines = lines.length;
        stdout.write(lines.join("\n"));
      };
      const toggle = () => {
        const skill = filteredSkills()[selected];
        if (!skill) {
          return;
        }
        if (checked.has(skill.id)) {
          checked.delete(skill.id);
          checked.delete(skill.name);
        } else {
          checked.add(skill.id);
        }
      };
      const onData = (chunk: Buffer) => {
        const key = chunk.toString("utf8");
        if (key === "\u0003" || key === "\u001b") {
          cancel();
          return;
        }
        if (key === "\u001b[A") {
          selected = (selected - 1 + filteredSkills().length) % Math.max(1, filteredSkills().length);
          render();
          return;
        }
        if (key === "\u001b[B") {
          selected = (selected + 1) % Math.max(1, filteredSkills().length);
          render();
          return;
        }
        if (key === " ") {
          toggle();
          render();
          return;
        }
        if (key === "\r" || key === "\n") {
          finish();
          return;
        }
        if (key === "\u007f") {
          query = query.slice(0, -1);
          selected = 0;
          render();
          return;
        }
        if (isPrintableInput(key)) {
          query += printableText(key);
          selected = 0;
          render();
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private async renderSessionsView(args: string): Promise<void> {
    const requested = args.trim();
    if (requested) {
      if (requested === "resume") {
        await this.renderResumeSessionView("");
        return;
      }
      if (requested === "new") {
        const session = await this.createTuiSession();
        this.renderPanel("Session Created", [this.sessionLabel(session)]);
        return;
      }
      if (requested === "all") {
        this.renderSessionList(true);
        return;
      }
      const sessions = this.app.store.listSessions(this.app.workspace.id, { includeArchived: true });
      const match = this.resolveSessionSelection(requested, sessions);
      if (!match) {
        this.renderNotice(`No session matched ${requested}.`);
        return;
      }
      this.resumeSession(match);
      return;
    }
    const action = await this.selectOption<SessionAction>(
      "Sessions",
      [
        { value: "resume", label: "Resume", description: "Attach to an existing session." },
        { value: "new", label: "New session", description: "Start a fresh session in this workspace." },
        { value: "rename", label: "Rename", description: "Change a session title." },
        { value: "archive", label: "Archive", description: "Hide a finished or stale session from the default list." },
        { value: "all", label: "Show all", description: "Include archived sessions and lock state." },
      ],
      0,
      [fg256(244, "Use /clear, /resume, or /sessions all for direct actions.")],
    );
    if (action === "new") {
      const session = await this.createTuiSession();
      this.renderPanel("Session Created", [this.sessionLabel(session)]);
      return;
    }
    if (action === "all") {
      this.renderSessionList(true);
      return;
    }
    const includeArchived = action === "rename";
    const target = action === "resume"
      ? await this.chooseResumeSession("Resume Session", false)
      : await this.chooseSession(action === "rename" ? "Rename Session" : "Archive Session", includeArchived);
    if (!target) {
      return;
    }
    if (action === "resume") {
      this.resumeSession(target);
      return;
    }
    if (action === "rename") {
      const title = await this.ask("Session title", target.title);
      const renamed = this.app.store.renameSession(target.session_id, title);
      if (this.#sessionId === target.session_id) {
        this.#sessionId = renamed.session_id;
      }
      this.renderPanel("Session Renamed", [this.sessionLabel(renamed)]);
      return;
    }
    if (action === "archive") {
      const confirmed = await this.confirm(`Archive ${target.session_id.slice(0, 12)}?`, false);
      if (!confirmed) {
        this.renderNotice("Archive cancelled.");
        return;
      }
      const archived = this.app.store.archiveSession(target.session_id);
      if (this.#sessionId === archived.session_id) {
        this.#sessionId = undefined;
      }
      this.renderPanel("Session Archived", [this.sessionLabel(archived)]);
    }
  }

  private async renderResumeSessionView(args: string): Promise<void> {
    const requested = args.trim();
    if (requested) {
      const sessions = this.app.store.listSessions(this.app.workspace.id, { includeArchived: true });
      const match = this.resolveSessionSelection(requested, sessions);
      if (!match) {
        this.renderNotice(`No session matched ${requested}.`);
        return;
      }
      this.resumeSession(match);
      return;
    }
    const target = await this.chooseResumeSession("Resume Session", false);
    if (!target) {
      return;
    }
    this.resumeSession(target);
  }

  private async startFreshSessionFromClear(): Promise<void> {
    const session = this.app.store.createSession(this.app.workspace);
    this.#sessionId = session.session_id;
    this.resetVisibleSessionSurface();
    stdout.write(ansi.clear);
    this.writeHomeFrame();
    this.#hasTranscript = true;
  }

  private resumeSession(session: SessionRecord): void {
    this.#sessionId = session.session_id;
    this.resetVisibleSessionSurface();
    stdout.write(ansi.clear);
    this.writeHomeFrame();
    const transcript = renderSessionTranscript(this.app.store.listEvents(session.session_id), safeTerminalWidth());
    if (transcript) {
      stdout.write(transcript);
    } else {
      stdout.write(`${fg256(244, "No prior chat history in this session.")}\n\n`);
    }
    this.#hasTranscript = true;
  }

  private resetVisibleSessionSurface(): void {
    this.#inlineRenderedLines = 0;
    this.#inlinePanelStartRow = undefined;
    this.#composerFooter = undefined;
    this.#composerActivity = undefined;
    this.#composerQueue = undefined;
    this.#composerPanel = undefined;
    this.#hasTranscript = false;
  }

  private async createTuiSession(): Promise<SessionRecord> {
    const title = await this.ask("New session title", "New session");
    const session = this.app.store.createSession(this.app.workspace, title || "New session");
    this.#sessionId = session.session_id;
    return session;
  }

  private createModeSession(title: string): SessionRecord {
    const session = this.app.store.createSession(this.app.workspace, title);
    this.#sessionId = session.session_id;
    return session;
  }

  private async chooseSession(title: string, includeArchived: boolean): Promise<SessionRecord | undefined> {
    const sessions = this.app.store.listSessions(this.app.workspace.id, { includeArchived });
    if (!sessions.length) {
      this.renderPanel(title, [includeArchived ? "No sessions for this workspace." : "No active sessions for this workspace."]);
      return undefined;
    }
    const defaultIndex = Math.max(0, sessions.findIndex((session) => session.session_id === this.#sessionId));
    const selected = await this.selectOption(
      title,
      sessions.map((session) => ({
        value: session.session_id,
        label: `${session.session_id.slice(0, 12)} · ${truncateToWidth(session.title, 36)}`,
        description: this.sessionDescription(session),
      })),
      defaultIndex,
    );
    return sessions.find((session) => session.session_id === selected);
  }

  private async chooseResumeSession(title: string, includeArchived: boolean): Promise<SessionRecord | undefined> {
    const sessions = this.app.store.listSessions(this.app.workspace.id, { includeArchived });
    if (!sessions.length) {
      this.renderPanel(title, [includeArchived ? "No sessions for this workspace." : "No active sessions for this workspace."]);
      return undefined;
    }

    const defaultIndex = Math.max(0, sessions.findIndex((session) => session.session_id === this.#sessionId));
    let pageIndex = Math.floor(defaultIndex / RESUME_SESSION_PAGE_SIZE);
    let selected = defaultIndex % RESUME_SESSION_PAGE_SIZE;
    this.#rl?.pause();

    const clampSelection = () => {
      const page = resumeSessionPage(sessions, pageIndex);
      pageIndex = page.pageIndex;
      selected = Math.max(0, Math.min(selected, Math.max(0, page.items.length - 1)));
      return page;
    };

    const render = () => {
      const page = clampSelection();
      const lines = page.items.map((session, index) => {
        const label = `${session.session_id.slice(0, 12)} · ${truncateToWidth(session.title, 44)}`;
        return renderSetupOptionLine(label, this.sessionDescription(session), index === selected);
      });
      const pageHint = `${page.pageIndex + 1}/${page.totalPages} · ${page.totalItems} sessions · ←/→ page · ↑/↓ move · enter resume · esc cancel`;
      this.renderCenteredPanel(title, [...lines, "", setupHint(pageHint)], true);
    };

    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        this.resumeReadline();
      };
      const finish = () => {
        const page = clampSelection();
        const session = page.items[selected];
        cleanup();
        stdout.write("\n");
        resolve(session);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Selection cancelled"));
      };
      const movePage = (delta: number) => {
        const current = resumeSessionPage(sessions, pageIndex);
        pageIndex = Math.max(0, Math.min(current.totalPages - 1, pageIndex + delta));
        clampSelection();
        render();
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          if (key === "\u0003" || key === "\u001b") {
            cancel();
            return;
          }
          if (key === "\u001b[A" || key === "k") {
            const page = clampSelection();
            selected = (selected - 1 + page.items.length) % page.items.length;
            render();
            continue;
          }
          if (key === "\u001b[B" || key === "j") {
            const page = clampSelection();
            selected = (selected + 1) % page.items.length;
            render();
            continue;
          }
          if (key === "\u001b[D") {
            movePage(-1);
            continue;
          }
          if (key === "\u001b[C") {
            movePage(1);
            continue;
          }
          if (key === " " || key === "\r" || key === "\n") {
            finish();
            return;
          }
        }
      };
      const onResize = () => {
        render();
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private renderSessionList(includeArchived: boolean): void {
    const sessions = this.app.store.listSessions(this.app.workspace.id, { includeArchived });
    this.renderPanel(
      includeArchived ? "All Sessions" : "Sessions",
      sessions.length
        ? sessions.map((session, index) => `  ${index + 1}. ${this.sessionLabel(session)}`)
        : [includeArchived ? "No sessions for this workspace." : "No active sessions for this workspace."],
    );
  }

  private async renderJobsView(args = ""): Promise<void> {
    const requested = args.trim().toLowerCase() as JobAction | "";
    const action = requested
      ? requested
      : await this.selectOption<JobAction>(
      "Jobs",
      [
        { value: "status", label: "Status", description: "Show daemon and job state." },
        { value: "queue", label: "Queue run", description: "Start a supervised background task." },
        { value: "attach", label: "Attach", description: "Inspect a job and recent session events." },
        { value: "detach", label: "Detach", description: "Leave a queued or running job supervised." },
        { value: "cancel", label: "Cancel", description: "Request cancellation for an active job." },
      ],
      0,
      [fg256(244, "Jobs use the same durable session event log as chat.")],
    );
    if (!["status", "queue", "attach", "detach", "cancel"].includes(action)) {
      this.renderNotice(`Unknown jobs action ${args}.`);
      return;
    }
    switch (action) {
      case "status":
        await this.renderDaemonStatusPanel();
        return;
      case "queue":
        await this.queueDaemonRunFromTui();
        return;
      case "attach":
        await this.attachDaemonJobFromTui();
        return;
      case "detach":
        await this.detachDaemonJobFromTui();
        return;
      case "cancel":
        await this.cancelDaemonJobFromTui();
        return;
    }
  }

  private async renderDaemonStatusPanel(): Promise<void> {
    const status = await daemonStatus(this.options.stateDir);
    this.renderPanel("Jobs", [
      `${fg256(39, "Daemon")} ${status.alive ? `alive pid ${status.pid}` : "not running"}`,
      "",
      ...(status.jobs.length ? status.jobs.map((job) => `  ${this.jobLabel(job)}`) : ["  no jobs"]),
    ]);
  }

  private async queueDaemonRunFromTui(): Promise<void> {
    const prompt = await this.ask("Background task", "Run repository validation and record evidence");
    const trimmed = prompt.trim();
    if (!trimmed) {
      this.renderNotice("No background task queued.");
      return;
    }
    const job = await queueDaemonRun({
      stateDir: this.options.stateDir,
      workspaceRoot: this.app.workspace.root,
      sessionId: this.#sessionId,
      prompt: trimmed,
      title: titleFromPrompt(trimmed),
    });
    const status = await startDaemon({ stateDir: this.options.stateDir });
    this.#sessionId = job.session_id;
    this.renderPanel("Job Queued", [
      `${fg256(48, "•")} ${this.jobLabel(job)}`,
      `${fg256(39, "Daemon")} ${status.alive ? `alive pid ${status.pid}` : "start requested"}`,
    ]);
  }

  private async attachDaemonJobFromTui(): Promise<void> {
    const job = await this.chooseDaemonJob("Attach Job");
    if (!job) {
      return;
    }
    const attached = await attachDaemonJob(this.options.stateDir, job.job_id);
    this.#sessionId = attached.job.session_id;
    const events = (attached.events as SessionEvent[]).slice(-10);
    this.renderPanel("Job Attached", [
      this.jobLabel(attached.job),
      "",
      fg256(39, "Recent events"),
      ...(events.length ? events.map((event) => `  ${renderCompactEventLine(event)}`) : ["  no events"]),
    ]);
  }

  private async detachDaemonJobFromTui(): Promise<void> {
    const job = await this.chooseDaemonJob("Detach Job", (item) => item.status === "queued" || item.status === "running" || item.status === "detached");
    if (!job) {
      return;
    }
    const detached = await detachDaemonJob(this.options.stateDir, job.job_id);
    this.renderPanel("Job Detached", [this.jobLabel(detached)]);
  }

  private async cancelDaemonJobFromTui(): Promise<void> {
    const job = await this.chooseDaemonJob("Cancel Job", isCancellableJob);
    if (!job) {
      return;
    }
    const confirmed = await this.confirm(`Cancel ${job.job_id.slice(0, 12)}?`, false);
    if (!confirmed) {
      this.renderNotice("Cancel skipped.");
      return;
    }
    const cancelled = await cancelDaemonJob(this.options.stateDir, job.job_id);
    this.renderPanel("Job Cancel", [this.jobLabel(cancelled)]);
  }

  private async chooseDaemonJob(title: string, filter: (job: SupervisorJob) => boolean = () => true): Promise<SupervisorJob | undefined> {
    const jobs = (await daemonStatus(this.options.stateDir)).jobs.filter(filter);
    if (!jobs.length) {
      this.renderPanel(title, ["No matching jobs."]);
      return undefined;
    }
    const selected = await this.selectOption(
      title,
      jobs.map((job) => ({
        value: job.job_id,
        label: `${job.job_id.slice(0, 12)} · ${job.status}`,
        description: `${job.session_id.slice(0, 12)} · ${truncateToWidth(job.prompt, 70)}`,
      })),
    );
    return jobs.find((job) => job.job_id === selected);
  }

  private jobLabel(job: SupervisorJob): string {
    const session = this.app.store.getSession(job.session_id);
    const sessionLabel = session ? `${session.session_id.slice(0, 12)} · ${session.title}` : job.session_id.slice(0, 12);
    return `${job.status.padEnd(16)} ${job.job_id.slice(0, 12)} · ${sessionLabel} · ${truncateToWidth(job.prompt, Math.max(24, terminalWidth() - 54))}`;
  }

  private renderFormattedEventView(title: string, filter: (event: SessionEvent) => boolean, render: (events: SessionEvent[]) => string[]): void {
    const session = this.optionalSession();
    if (!session) {
      this.renderPanel(title, ["No active session yet."]);
      return;
    }
    this.renderPanel(title, render(this.app.store.listEvents(session.session_id).filter(filter)));
  }

  private async renderAcceptanceView(args = ""): Promise<void> {
    const action = args.trim().toLowerCase();
    if (action === "run") {
      await this.runAcceptanceFromTui();
      return;
    }
    if (action && action !== "status") {
      this.renderNotice(`Unknown acceptance action ${args}. Use /acceptance status or /acceptance run.`);
      return;
    }
    const directConfigured = Boolean(this.app.config.model_setup.base_url && this.app.config.model_setup.model);
    let matrix = staticOmniCapabilityMatrix(this.app.config);
    try {
      matrix = (await new EndpointSignals(this.app.config).snapshot()).omni_capabilities ?? matrix;
    } catch {
      // Static config state is still useful when the endpoint is unreachable.
    }
    const lines = [
      `${checkbox(directConfigured)} coding endpoint configured`,
      ...matrix.map((capability) => {
        const suffix = capability.required_for_acceptance ? fg256(244, "required") : fg256(244, "optional");
        return `${checkbox(capability.runtime_passed === true)} Omni ${capability.label} · ${omniCapabilitySummary(capability)} · ${suffix}`;
      }),
      `${checkbox(false)} AMD direct vLLM deployment check`,
      `${checkbox(false)} AMD vLLM-Omni deployment check`,
      `${checkbox(false)} TUI-driven coding task with tools`,
      `${checkbox(false)} context compression and continuation`,
      `${checkbox(false)} daemon attach/detach/status/cancel on final task`,
      "",
      `${fg256(39, "/acceptance run")} runs the real endpoint workflow from inside the TUI.`,
      fg256(243, "It fails fast until direct vLLM and all Omni endpoints are configured."),
    ];
    this.renderPanel("Final Acceptance", lines);
  }

  private async runAcceptanceFromTui(): Promise<void> {
    this.renderPanel("Final Acceptance", [
      `${fg256(75, "•")} starting real endpoint workflow`,
      fg256(243, "Using configured chat, Omni, session, context, tool, activity, and daemon paths."),
    ]);
    try {
      const result = await runFinalAcceptance({
        workspaceRoot: this.app.workspace.root,
        stateDir: this.options.stateDir,
        daemon: true,
      });
      if (result.session_id) {
        this.#sessionId = result.session_id;
      }
      const evidence = result.evidence as JsonObject;
      const toolCalls = Array.isArray(evidence.tool_calls) ? evidence.tool_calls : [];
      const cachedEvidence = Array.isArray(evidence.direct_cached_token_evidence) ? evidence.direct_cached_token_evidence : [];
      const report = stringField(evidence.report_path);
      const lines = [
        result.ok ? fg256(48, "✓ passed") : fg256(203, "× failed"),
        ...(result.session_id ? [`${fg256(39, "session")} ${result.session_id}`] : []),
        ...(report ? [`${fg256(39, "report")} ${report}`] : []),
        `${fg256(39, "tools")} ${toolCalls.length}`,
        `${fg256(39, "direct cache samples")} ${cachedEvidence.length}`,
        "",
        ...(result.failures.length
          ? [
              fg256(203, "Failures"),
              ...result.failures.slice(0, 12).map((failure) => `  ${failure}`),
              ...(result.failures.length > 12 ? [fg256(244, `  ... ${result.failures.length - 12} more`)] : []),
            ]
          : [fg256(48, "All acceptance checks passed.")]),
      ];
      this.renderPanel("Final Acceptance", lines);
    } catch (error) {
      this.renderPanel("Final Acceptance", [fg256(203, error instanceof Error ? error.message : String(error))]);
    }
  }

  private renderHelp(): void {
    this.renderPanel("Help", [
      fg256(39, "Keyboard"),
      "  Enter sends a prompt",
      "  / opens product commands",
      "  $ opens the skill catalog",
      "  Esc interrupts the active loop when the composer is empty",
      "  Ctrl+T expands compact tool traces",
      "",
      fg256(39, "Commands"),
      ...SLASH_COMMANDS.map((command) => `  /${command.name.padEnd(11)} ${command.description}`),
      "",
      fg256(39, "Subcommands"),
      `  /skills    list · manage`,
      `  /goal      show · set · pause · resume · budget · complete · drop`,
      `  /plan      show · set · pause · resume · approve · drop`,
      `  /autoresearch status · off · clear`,
      `  /tools     expand · compact · last`,
      `  /jobs      status · queue · attach · detach · cancel`,
      `  /sessions  resume · new · all`,
      `  /acceptance status · run`,
    ]);
  }

  private async submitPrompt(prompt: string, options: { renderPrompt?: boolean } = {}): Promise<void> {
    if (!(await this.waitForCodeIntelligenceBeforeChat())) {
      return;
    }
    if (options.renderPrompt !== false) {
      this.renderSubmittedPrompt(prompt);
    }
    const startedAt = Date.now();
    const markdown = new MarkdownStreamRenderer({ width: Math.max(40, terminalWidth() - 4) });
    const renderState: { lastSegment: "none" | "assistant" | "tool" } = {
      lastSegment: "none",
    };
    const liveToolCallIds = new Set<string>();
    const activity = this.startActivityIndicator("Prefill with Inferoa");
    let sawModelDelta = false;
    const abort = new AbortController();
    this.#activeAbort = abort;
    try {
      const result = await this.app.runtime.run({
        prompt,
        session_id: this.#sessionId,
        client_id: randomId("tui"),
        signal: abort.signal,
        onDelta: (text) => {
          if (!sawModelDelta) {
            sawModelDelta = true;
            activity.status("Decode with Inferoa");
          }
          const rendered = markdown.write(text);
          if (!rendered) {
            return;
          }
          activity.pauseForOutput({ redraw: false });
          if (renderState.lastSegment === "tool") {
            this.writeTranscript("\n");
          }
          this.writeTranscript(rendered);
          renderState.lastSegment = "assistant";
        },
        onStatus: (event) => {
          if (event.type === "model_retry") {
            activity.status(`Retrying Inferoa in ${formatDuration(event.delay_ms)}`);
          }
          if (event.type === "compression_start") {
            activity.status(formatCompressionStartActivity(event));
          }
          if (event.type === "compression_end") {
            activity.record(formatCompressionActivityLine(event));
          }
          if (event.type === "tool_start") {
            activity.status(event.summary ?? toolActivityAction(event.tool_name));
          }
          if (event.type === "tool_end") {
            let output = "";
            const flushed = markdown.flush();
            if (flushed) {
              if (renderState.lastSegment === "tool") {
                output += "\n";
              }
              output += flushed;
              renderState.lastSegment = "assistant";
            }
            const toolBlock = this.toolTraceForCallBlock(event.session_id, event.run_id, event.tool_call_id, renderState.lastSegment === "assistant");
            if (toolBlock) {
              output += toolBlock;
              liveToolCallIds.add(event.tool_call_id);
              renderState.lastSegment = "tool";
            }
            if (output) {
              activity.pauseForOutput({ redraw: false });
              this.writeTranscript(output);
            } else {
              activity.status(formatToolActivityLine(event.tool_name, event.ok, event.summary, event.duration_ms));
            }
          }
        },
        onClarify: async (request) => {
          activity.pauseForOutput({ redraw: false });
          return await this.askClarification(request);
        },
      });
      activity.stop({ redraw: false });
      let finalOutput = "";
      const flushed = markdown.flush();
      if (flushed) {
        if (renderState.lastSegment === "tool") {
          finalOutput += "\n";
        }
        finalOutput += flushed;
        renderState.lastSegment = "assistant";
      }
      this.#sessionId = result.session.session_id;
      const evidence = this.latestTurnEvidence(result.session.session_id, result.run_id);
      const toolSummary = this.toolSummaryBlock(result.session.session_id, result.run_id, renderState.lastSegment === "assistant", liveToolCallIds);
      if (toolSummary) {
        finalOutput += toolSummary;
        renderState.lastSegment = "tool";
      }
      const footer = renderCacheFooter({
        ...evidence,
        latencyMs: Date.now() - startedAt,
        cacheKind: cacheTurnKind(this.app.store.listEvents(result.session.session_id), result.run_id),
      });
      this.#composerFooter = footer || undefined;
      this.writeTranscript(withConversationGap(finalOutput));
    } catch (error) {
      activity.stop({ redraw: false });
      const flushed = markdown.flush();
      const message = error instanceof Error ? error.message : String(error);
      const renderedError = isAbortError(error) ? fg256(244, `Interrupted current loop: ${message}`) : fg256(203, message);
      this.writeTranscript(`${flushed}${flushed ? "\n" : ""}${renderedError}\n\n`);
    } finally {
      if (this.#activeAbort === abort) {
        this.#activeAbort = undefined;
      }
    }
  }

  private startActivityIndicator(label: string): ActivityIndicator {
    let active = false;
    let frameIndex = 0;
    let currentLabel = label;
    let startedAt = Date.now();
    let hasStarted = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const render = () => {
      if (!active) {
        return;
      }
      const now = Date.now();
      const width = safeTerminalWidth();
      this.#composerActivity = renderActivityLine(currentLabel, now - startedAt, frameIndex, width);
      frameIndex += 1;
      if (!this.#activeComposerActivityRedraw?.()) {
        this.#activeComposerRedraw?.();
      }
    };
    const ensure = () => {
      if (active) {
        return;
      }
      active = true;
      if (!hasStarted) {
        startedAt = Date.now();
        hasStarted = true;
      }
      render();
      timer = setInterval(render, 140);
      (timer as { unref?: () => void }).unref?.();
    };
    const clear = (options: { redraw?: boolean } = {}) => {
      if (!active && !this.#composerActivity) {
        return;
      }
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const hadActivity = Boolean(this.#composerActivity);
      if (this.#composerActivity) {
        this.#composerActivity = undefined;
      }
      if (hadActivity && options.redraw !== false) {
        this.#activeComposerRedraw?.();
      }
    };

    ensure();
    const writeTranscript = (text: string) => this.writeTranscript(text);
    return {
      status(nextLabel: string) {
        currentLabel = nextLabel;
        ensure();
        render();
      },
      record(line: string) {
        clear({ redraw: false });
        writeTranscript(`${line}\n\n`);
        ensure();
      },
      pauseForOutput(options?: { redraw?: boolean }) {
        clear(options);
      },
      stop(options?: { redraw?: boolean }) {
        clear(options);
      },
    };
  }

  private renderSubmittedPrompt(prompt: string): void {
    if (!this.#hasTranscript && !this.#sessionId) {
      this.writeHomeFrame();
    }
    const width = safeTerminalWidth();
    const maxPromptLines = 10;
    const rawLines = prompt.split(/\r?\n/);
    const promptLines = rawLines.slice(0, maxPromptLines);
    if (rawLines.length > maxPromptLines) {
      promptLines.push(`... ${rawLines.length - maxPromptLines} more lines`);
    }
    const body = promptLines.length ? promptLines : [""];
    const lines = [
      bgLine(236, "", width),
      ...body.map((line, index) => {
        const prefix = index === 0 ? "› " : "  ";
        return bgLine(236, `${prefix}${truncateToWidth(line, Math.max(10, width - visibleWidth(prefix) - 1))}`, width);
      }),
      bgLine(236, "", width),
    ];
    this.writeTranscript(withConversationGap(lines.join("\n")));
  }

  private writeTranscript(text: string): void {
    if (!text) {
      return;
    }
    this.#hasTranscript = true;
    const erase = this.#activeComposerErase;
    const redraw = this.#activeComposerRedraw;
    if (!erase || !redraw) {
      stdout.write(text);
      return;
    }
    erase();
    stdout.write(text);
    if (!text.endsWith("\n")) {
      stdout.write("\n");
    }
    redraw();
  }

  private toolTraceForCallBlock(sessionId: string, runId: string, toolCallId: string, leadingGap = true): string | undefined {
    const events = this.app.store
      .listEvents(sessionId)
      .filter(
        (event) =>
          event.run_id === runId &&
          (event.type === "tool.call" || event.type === "tool.result") &&
          stringField(event.data.tool_call_id) === toolCallId,
      );
    if (!events.some((event) => event.type === "tool.result")) {
      return undefined;
    }
    const lines = renderToolCards(events, this.app.store, { collapseCompact: false });
    return `${leadingGap ? "\n" : ""}${lines.join("\n")}\n`;
  }

  private toolSummaryBlock(sessionId: string, runId: string, leadingGap = true, excludeToolCallIds: ReadonlySet<string> = new Set()): string | undefined {
    const events = this.app.store.listEvents(sessionId).filter((event) => {
      if (event.run_id !== runId || (event.type !== "tool.call" && event.type !== "tool.result")) {
        return false;
      }
      const toolCallId = stringField(event.data.tool_call_id);
      return !toolCallId || !excludeToolCallIds.has(toolCallId);
    });
    if (!events.length) {
      return undefined;
    }
    const lines = renderToolCards(events, this.app.store, { collapseCompact: this.#toolTraceMode === "compact" });
    return `${leadingGap ? "\n" : ""}${lines.join("\n")}\n`;
  }

  private latestTurnEvidence(sessionId: string, runId: string): ChatTurnEvidence {
    const evidence = this.app.store.listEndpointEvidence(sessionId).slice().reverse().find((item) => item.run_id === runId) ?? {};
    const events = this.app.store.listEvents(sessionId).filter((event) => event.run_id === runId && event.type === "model.response.settled");
    const settled = events.at(-1)?.data ?? {};
    return {
      usage: (settled.usage as ModelUsage | undefined) ?? (evidence.usage as ModelUsage | undefined),
      requestId: stringField(settled.request_id) ?? stringField(evidence.request_id),
      responseId: stringField(settled.response_id) ?? stringField(evidence.response_id),
      model: stringField(settled.model) ?? stringField(evidence.model),
      mode: this.app.config.model_setup.mode,
    };
  }

  private renderPanel(title: string, body: string[]): void {
    if (this.#inlineMode) {
      this.renderInlinePanel(title, body);
      return;
    }
    stdout.write("\n");
    stdout.write(frame(title, body).join("\n"));
    stdout.write("\n\n");
  }

  private renderCenteredPanel(title: string, body: string[], clear = false): void {
    if (this.#inlineMode) {
      this.renderInlineCenteredPanel(title, body);
      return;
    }
    const panelWidth = setupDialogTitle(title) ? setupDialogFrameWidth() : Math.min(terminalWidth() - 4, 86);
    const lines = commandDeckFrame(title, body, panelWidth);
    const topPad = Math.max(1, Math.floor((terminalHeight() - lines.length) / 2));
    if (clear) {
      stdout.write(ansi.clear);
    } else {
      stdout.write("\n");
    }
    stdout.write("\n".repeat(topPad));
    stdout.write(centerBlock(lines, terminalWidth()).join("\n"));
    stdout.write("\n\n");
  }

  private renderInlinePanel(title: string, body: string[]): void {
    this.eraseInlinePanel();
    const width = safeTerminalWidth();
    const lines = [
      bg256(236, padRight(`  ${title}`, width)),
      bg256(236, padRight("", width)),
      ...body.map((line) => bg256(236, padRight(`  ${line}`, width))),
      bg256(236, padRight("", width)),
    ];
    this.#inlineRenderedLines = lines.length;
    this.#inlinePanelStartRow = undefined;
    stdout.write(lines.join("\n"));
    stdout.write("\n");
  }

  private renderInlineCenteredPanel(title: string, body: string[]): void {
    this.eraseInlinePanel();
    if (!setupDialogTitle(title)) {
      this.renderInlinePanel(title, body);
      return;
    }
    const panelWidth = setupDialogTitle(title)
      ? setupDialogFrameWidth()
      : Math.min(Math.max(52, Math.floor(terminalWidth() * 0.58)), 96, Math.max(52, terminalWidth() - 6));
    const lines = commandDeckFrame(title, body, panelWidth);
    const startRow = Math.max(1, terminalHeight() - lines.length - 2);
    this.#inlineRenderedLines = terminalHeight() - startRow + 1;
    this.#inlinePanelStartRow = startRow;
    stdout.write(`\x1b[${startRow};1H\x1b[J`);
    stdout.write(lines.join("\n"));
  }

  private eraseInlinePanel(): void {
    if (!this.#inlineRenderedLines) {
      return;
    }
    if (this.#inlinePanelStartRow !== undefined) {
      stdout.write(`\x1b[${this.#inlinePanelStartRow};1H\x1b[J`);
    } else {
      stdout.write(`\x1b[${Math.max(0, this.#inlineRenderedLines)}A\r\x1b[J`);
    }
    this.#inlineRenderedLines = 0;
    this.#inlinePanelStartRow = undefined;
  }

  private resumeReadline(): void {
    try {
      this.#rl?.resume();
    } catch {
      // Ctrl+C can close readline before raw-mode cleanup runs.
    }
  }

  private renderNotice(message: string): void {
    this.renderPanel("Notice", [fg256(203, message)]);
  }

  private renderUnknownSlashCommand(input: string): void {
    if (!this.#hasTranscript && !this.#sessionId) {
      this.writeHomeFrame();
    }
    const command = input.trim().slice(1).split(/\s+/)[0] ?? "";
    this.writeTranscript(withConversationGap(renderUnknownSlashCommandNotice(command)));
  }

  private optionalSession(): SessionRecord | undefined {
    return this.#sessionId ? this.app.store.getSession(this.#sessionId) : undefined;
  }

  private requiredSession(): SessionRecord {
    const session = this.optionalSession();
    if (!session) {
      throw new Error("No active session");
    }
    return session;
  }

  private resolveModelSelection(input: string, models: string[]): string | undefined {
    const index = Number.parseInt(input, 10) - 1;
    if (models[index]) {
      return models[index];
    }
    return input.trim() || undefined;
  }

  private resolveSessionSelection(input: string, sessions: SessionRecord[]): SessionRecord | undefined {
    const index = Number.parseInt(input, 10) - 1;
    if (sessions[index]) {
      return sessions[index];
    }
    const matches = sessions.filter((session) => session.session_id.startsWith(input));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private sessionLabel(session: SessionRecord): string {
    return `${session.session_id.slice(0, 12)} · ${session.title} · ${this.sessionDescription(session)} · ${session.updated_at}`;
  }

  private sessionDescription(session: SessionRecord): string {
    const lock = this.app.store.getLock(session.session_id);
    const lockLabel = lock ? `locked ${lock.owner_kind} ${formatAge(lock.heartbeat_at)}` : "unlocked";
    return `${session.status} · ${lockLabel}`;
  }

}

function parseModeAction(args: string, actions: Set<string>): { action?: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { rest: "" };
  }
  const [head = "", ...tail] = trimmed.split(/\s+/);
  const normalized = head.toLowerCase();
  if (actions.has(normalized)) {
    return { action: normalized, rest: tail.join(" ").trim() };
  }
  return { rest: trimmed };
}

function goalPanelUsage(goal: GoalRecord): string | undefined {
  const parts: string[] = [];
  if (goal.token_budget !== undefined || goal.tokens_used > 0) {
    parts.push(goal.token_budget === undefined ? `${goal.tokens_used} tokens` : `${goal.tokens_used}/${goal.token_budget} tokens`);
  }
  if (goal.tool_rounds_used > 0 || goal.tool_calls_used > 0) {
    parts.push(`${goal.tool_rounds_used} loops · ${goal.tool_calls_used} tools`);
  }
  if (goal.time_used_ms > 0) {
    parts.push(formatDuration(goal.time_used_ms));
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function goalStepStatusMarker(status: string): string {
  switch (status) {
    case "completed":
      return fg256(48, "x");
    case "in_progress":
      return fg256(220, "*");
    case "blocked":
      return fg256(203, "!");
    case "skipped":
      return fg256(244, "-");
    default:
      return fg256(244, " ");
  }
}

function titleFromPromptForMode(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 80) || "New session";
}

function modelsFromSnapshot(snapshot: { models?: JsonObject[] }): string[] {
  return (snapshot.models ?? [])
    .map((model) => stringField(model.id) ?? stringField(model.name))
    .filter((model): model is string => Boolean(model));
}

function dataAsJsonObjects(value: unknown[]): JsonObject[] {
  return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as JsonObject[];
}

function defaultBaseUrl(provider: ProviderChoice): string {
  switch (provider) {
    case "auto":
      return "http://localhost:8899/v1";
    case "external":
      return "https://api.openai.com/v1";
    case "direct":
    default:
      return "http://localhost:8000/v1";
  }
}

export function normalizeContextWindowInput(input: string, fallback: number): number {
  const trimmed = input.trim().toLowerCase();
  const raw = trimmed || String(fallback);
  const match = raw.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match?.[1]) {
    throw new Error("Context window must be a token count such as 32768, 128k, or 1m.");
  }
  const value = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokens = Math.floor(value * multiplier);
  if (!Number.isFinite(tokens) || tokens < 1024) {
    throw new Error("Context window must be at least 1024 tokens.");
  }
  return tokens;
}

export function describeModelSetupForDisplay(setup: ModelSetup): string {
  const contextWindow = setup.context_window ? ` · ctx ${setup.context_window}` : "";
  const provider = setup.provider_id ? `${setup.provider}:${setup.provider_id}` : setup.provider ?? setup.router ?? "unknown";
  return `${setup.mode} · ${provider} · ${setup.model ?? "unconfigured"} · ${setup.base_url ?? "unconfigured"}${contextWindow}`;
}

export function endpointStatusLinesForDisplay(snapshot: EndpointSignalSnapshot, config: VllmAgentConfig, webDescription: string, rtk?: RtkStatus): string[] {
  const omni = (snapshot.omni_capabilities ?? staticOmniCapabilityMatrix(config)).map((capability) => {
    const endpoint = capability.base_url && capability.model ? ` · ${capability.base_url} · ${capability.model}` : "";
    return `  ${capability.label}: ${omniCapabilitySummary(capability)}${endpoint}`;
  });
  return [
    `${fg256(39, "Mode")} ${snapshot.mode}`,
    `${fg256(39, "Provider")} ${snapshot.provider_id}`,
    `${fg256(39, "Base URL")} ${snapshot.base_url ?? "unconfigured"}`,
    `${fg256(39, "Model")} ${snapshot.model ?? "unconfigured"}`,
    `${fg256(39, "Web")} ${webDescription}`,
    `${fg256(39, "RTK")} ${rtkStatusLabel(rtk)}`,
    "",
    fg256(39, "Omni endpoints"),
    ...(omni.length ? omni : ["  none"]),
    ...(snapshot.errors?.length ? ["", fg256(203, "Errors"), ...snapshot.errors.map((error) => `  ${error}`)] : []),
  ];
}

function rtkStatusLabel(rtk?: RtkStatus): string {
  if (!rtk) {
    return "unknown";
  }
  if (!rtk.enabled) {
    return "disabled";
  }
  const source = rtk.source === "managed" ? `managed v${rtk.version}` : rtk.source;
  const state = rtk.available ? "available" : "unavailable";
  const pathLabel = rtk.binary_path ? ` · ${compactWorkspacePath(rtk.binary_path)}` : "";
  const error = rtk.error ? ` · ${rtk.error}` : "";
  return `${state} · ${source}${pathLabel}${error}`;
}

function omniCapabilitySummary(capability: OmniCapabilityStatus): string {
  return [
    capability.configured ? "configured" : "unconfigured",
    routeStatus(capability.route_present),
    profileStatus(capability.profile_compatible),
    runtimeStatus(capability.runtime_passed),
    capability.unavailable_reason ? `reason ${capability.unavailable_reason}` : undefined,
  ].filter(Boolean).join(" · ");
}

function routeStatus(routePresent: boolean | undefined): string {
  if (routePresent === true) {
    return "route present";
  }
  if (routePresent === false) {
    return "route missing";
  }
  return "route unknown";
}

function profileStatus(profileCompatible: boolean | undefined): string {
  if (profileCompatible === true) {
    return "profile compatible";
  }
  if (profileCompatible === false) {
    return "profile incompatible";
  }
  return "profile unverified";
}

function runtimeStatus(runtimePassed: boolean | undefined): string {
  if (runtimePassed === true) {
    return "runtime passed";
  }
  if (runtimePassed === false) {
    return "runtime failed";
  }
  return "runtime unverified";
}

export function setupReviewLinesForDisplay(config: VllmAgentConfig, contentWidth = setupDialogContentWidth(), rtkStatus?: RtkStatus): string[] {
  const chat = config.model_setup;
  const lines: string[] = [
    setupProgress(SETUP_TOTAL_STEPS, SETUP_TOTAL_STEPS, "review"),
    "",
    `${fg256(244, "chat")} ${chat.mode}`,
  ];
  appendReviewField(lines, "provider", chat.provider_id ?? chat.provider ?? chat.router ?? "unknown", contentWidth);
  appendReviewField(lines, "model", chat.model ?? "unconfigured", contentWidth);
  appendReviewField(lines, "endpoint", chat.base_url ?? "unconfigured", contentWidth);
  appendReviewField(lines, "context", String(chat.context_window ?? config.context.context_window), contentWidth);
  lines.push(`${fg256(244, "auth")} ${modelSetupAuthSummary(chat)}`, "");

  const web = config.web_search;
  lines.push(`${fg256(244, "web")} ${webSearchProviderLabel(web.provider)}`);
  if (web.base_url) {
    appendReviewField(lines, "endpoint", web.base_url, contentWidth);
  }
  appendReviewField(lines, "mode", webSearchModeSummary(web), contentWidth);
  lines.push("");

  const omniEndpoints = Object.entries(config.omni.endpoints).filter(([, endpoint]) => endpoint?.base_url || endpoint?.model);
  lines.push(`${fg256(244, "omni")} ${config.omni.enabled && omniEndpoints.length ? "enabled" : "disabled"}`);
  if (!config.omni.enabled || !omniEndpoints.length) {
    lines.push("  none");
  } else {
    for (const [name, endpoint] of omniEndpoints) {
      lines.push(`  ${name}`);
      appendReviewField(lines, "model", endpoint?.model ?? "unconfigured", contentWidth, 4);
      appendReviewField(lines, "endpoint", endpoint?.base_url ?? "no url", contentWidth, 4);
      appendReviewField(lines, "auth", endpoint?.api_key_ref ? "vault auth" : "no auth", contentWidth, 4);
    }
  }
  lines.push("");
  appendRtkReviewLines(lines, rtkStatus, contentWidth);
  lines.push("");
  appendReviewText(lines, "Config will store endpoints, selected models, and vault references only.", contentWidth, 244);
  return lines;
}

function appendRtkReviewLines(lines: string[], rtk?: RtkStatus, contentWidth = setupDialogContentWidth()): void {
  if (!rtk) {
    lines.push(`${fg256(244, "rtk")} unknown`);
    return;
  }
  if (!rtk.enabled) {
    lines.push(`${fg256(244, "rtk")} disabled`);
    return;
  }
  const source = rtk.source === "managed" ? `managed v${rtk.version}` : rtk.source;
  lines.push(`${fg256(244, "rtk")} ${rtk.available ? "available" : "unavailable"} · ${source}`);
  if (rtk.binary_path) {
    appendReviewField(lines, "path", rtk.binary_path, contentWidth);
  }
  if (rtk.error) {
    appendReviewField(lines, "error", rtk.error, contentWidth);
  }
}

export function webSearchProviderSetupOptions(): SelectOption<WebSearchProviderChoice>[] {
  return [
    { value: "auto", label: "Auto chain", description: "Use configured provider when supported, otherwise zero-key HTTP fallback" },
    { value: "brave", label: "Brave", description: "Requires Brave Search API key" },
    { value: "jina", label: "Jina", description: "Optional Jina API key; public endpoint works as fallback" },
    { value: "searxng", label: "SearXNG", description: "Use a SearXNG JSON endpoint" },
    { value: "custom", label: "Custom", description: "Use a SearXNG-compatible /search JSON endpoint" },
  ];
}

function appendReviewField(lines: string[], label: string, value: string, contentWidth: number, indent = 2): void {
  const prefixText = `${" ".repeat(indent)}${label.padEnd(8)} `;
  const prefix = `${" ".repeat(indent)}${fg256(244, label.padEnd(8))} `;
  const continuation = " ".repeat(visibleWidth(prefixText));
  const chunks = wrapPlainText(value, Math.max(8, contentWidth - visibleWidth(prefixText)));
  lines.push(`${prefix}${chunks[0] ?? ""}`);
  for (const chunk of chunks.slice(1)) {
    lines.push(`${continuation}${chunk}`);
  }
}

function appendReviewText(lines: string[], text: string, contentWidth: number, color?: number): void {
  for (const chunk of wrapPlainText(text, Math.max(8, contentWidth))) {
    lines.push(color === undefined ? chunk : fg256(color, chunk));
  }
}

function wrapPlainText(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) {
    return [text];
  }
  const lines: string[] = [];
  let rest = text;
  while (visibleWidth(rest) > width) {
    const hardEnd = fittingPlainTextEnd(rest, width);
    const end = preferredPlainTextWrapEnd(rest, hardEnd, width);
    const slice = rest.slice(0, end).trimEnd();
    lines.push(slice);
    rest = rest.slice(end).trimStart();
  }
  if (rest) {
    lines.push(rest);
  }
  return lines;
}

function fittingPlainTextEnd(text: string, width: number): number {
  let count = 0;
  let end = 0;
  for (const char of text) {
    const next = count + visibleWidth(char);
    if (next > width) {
      break;
    }
    count = next;
    end += char.length;
  }
  return Math.max(1, end);
}

function preferredPlainTextWrapEnd(text: string, hardEnd: number, width: number): number {
  const candidate = text.slice(0, hardEnd);
  const minWidth = Math.max(8, Math.floor(width * 0.45));
  let separatorEnd = 0;
  let whitespaceEnd = 0;
  for (let index = 0; index < candidate.length;) {
    const char = [...candidate.slice(index)][0] ?? "";
    if (!char) {
      break;
    }
    const nextIndex = index + char.length;
    const beforeWidth = visibleWidth(candidate.slice(0, index));
    if (beforeWidth >= minWidth && /\s/.test(char)) {
      whitespaceEnd = index;
    }
    if (beforeWidth >= minWidth && /[\/._?&=-]/.test(char)) {
      separatorEnd = nextIndex;
    }
    index = nextIndex;
  }
  return whitespaceEnd || separatorEnd || hardEnd;
}

function webSearchModeSummary(web: VllmAgentConfig["web_search"]): string {
  if (web.provider === "auto") {
    return "fallback ready";
  }
  if (web.provider === "off") {
    return "zero-key fallback";
  }
  return web.api_key_ref ? "vault auth" : web.provider === "jina" ? "public/no auth" : "no auth";
}

function modelSetupAuthSummary(setup: ModelSetup): string {
  if (setup.api_key_ref) {
    return "local vault";
  }
  const provider = externalProviderById(setup.provider_id);
  if (!provider) {
    return "none";
  }
  if (provider.auth_type === "none") {
    return "no auth";
  }
  if (provider.auth_type === "oauth_external") {
    return "auto auth";
  }
  return "not stored";
}

function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function looksLikeApiKey(value: string): boolean {
  return /^(sk-|sk_|xai-|ak-|rk-|AIza|ya29\.|ghp_|github_pat_)/i.test(value) || /^bearer\s+/i.test(value);
}

function isPrintableInput(value: string): boolean {
  return printableText(value).length > 0;
}

function printableText(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && code !== 0x1b;
  }).join("");
}

interface TerminalPasteState {
  pending?: string;
}

function terminalInputTokens(value: string, pasteState?: TerminalPasteState): string[] {
  const tokens: string[] = [];
  const shiftEnterSequences = ["\u001b[13;2u", "\u001b[13;2~", "\u001b[27;2;13~"];
  const knownSequences = [
    "\u001b[A",
    "\u001b[B",
    "\u001b[C",
    "\u001b[D",
    "\u001b[H",
    "\u001b[F",
    "\u001b[1~",
    "\u001b[4~",
  ];
  for (let index = 0; index < value.length;) {
    if (pasteState?.pending !== undefined) {
      const end = value.indexOf(BRACKETED_PASTE_END, index);
      if (end < 0) {
        pasteState.pending += value.slice(index);
        break;
      }
      tokens.push(pasteToken(pasteState.pending + value.slice(index, end)));
      pasteState.pending = undefined;
      index = end + BRACKETED_PASTE_END.length;
      continue;
    }
    const rest = value.slice(index);
    if (rest.startsWith(BRACKETED_PASTE_START)) {
      const contentStart = index + BRACKETED_PASTE_START.length;
      const end = value.indexOf(BRACKETED_PASTE_END, contentStart);
      if (end < 0) {
        if (pasteState) {
          pasteState.pending = value.slice(contentStart);
        }
        break;
      }
      tokens.push(pasteToken(value.slice(contentStart, end)));
      index = end + BRACKETED_PASTE_END.length;
      continue;
    }
    const shiftEnter = shiftEnterSequences.find((sequence) => rest.startsWith(sequence));
    if (shiftEnter) {
      tokens.push("shift-enter");
      index += shiftEnter.length;
      continue;
    }
    const knownSequence = knownSequences.find((sequence) => rest.startsWith(sequence));
    if (knownSequence) {
      tokens.push(knownSequence);
      index += knownSequence.length;
      continue;
    }
    const char = [...rest][0] ?? "";
    if (!char) {
      break;
    }
    if (char === "\r" || char === "\n") {
      tokens.push("\r");
    } else if (char === "\t") {
      tokens.push("\t");
    } else if (char === "\u0003" || char === "\u001b" || char === "\u007f") {
      tokens.push(char);
    } else {
      tokens.push(char);
    }
    index += char.length;
  }
  return tokens;
}

function pasteToken(content: string): string {
  return `${PASTE_TOKEN_PREFIX}${content}`;
}

function pasteTokenContent(token: string): string | undefined {
  return token.startsWith(PASTE_TOKEN_PREFIX) ? token.slice(PASTE_TOKEN_PREFIX.length) : undefined;
}

function stripFrontmatter(body: string): string {
  return body.replace(/^---[\s\S]*?---\s*/, "");
}

function providerLabel(provider: ProviderChoice): string {
  switch (provider) {
    case "auto":
      return "Semantic Router";
    case "external":
      return "External provider";
    case "direct":
    default:
      return "vLLM";
  }
}

function webSearchProviderLabel(provider: WebSearchProviderChoice): string {
  switch (provider) {
    case "auto":
      return "Auto chain";
    case "off":
      return "Fallback";
    case "brave":
      return "Brave";
    case "jina":
      return "Jina";
    case "searxng":
      return "SearXNG";
    case "custom":
      return "Custom search";
    case "exa":
      return "Exa";
    case "perplexity":
      return "Perplexity";
    case "kimi":
      return "Kimi";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
  }
}

function setupProgress(step: number, total: number, label: string): string {
  const clamped = Math.max(1, Math.min(step, total));
  const railWidth = 18;
  const active = Math.max(1, Math.round((clamped / total) * railWidth));
  const rail = Array.from({ length: railWidth }, (_, index) => fg256(index < active ? 75 : 238, "━")).join("");
  return `${fg256(244, `setup ${clamped}/${total}`)}  ${fg256(252, label)}  ${rail}`;
}

function setupHint(text: string): string {
  return fg256(244, text);
}

function renderSetupOptionLine(label: string, description: string | undefined, active: boolean): string {
  const marker = active ? fg256(75, "›") : fg256(238, " ");
  const name = active ? fg256(252, label) : fg256(248, label);
  const detail = description ? `  ${fg256(244, description)}` : "";
  return `${marker} ${name}${detail}`;
}

function renderProviderSetupOptionLine(option: ExternalProviderSetupOption, active: boolean): string {
  const marker = active ? fg256(75, "›") : fg256(238, " ");
  const nameColor = active ? 252 : 248;
  const prefix = option.discovered
    ? `${fg256(48, "●")} ${fg256(nameColor, "[discovered]")}`
    : fg256(244, option.provider.auth_type === "none" ? "[open]" : "[key]");
  const name = fg256(nameColor, option.provider.label);
  const detail = option.description ? `  ${fg256(244, option.description)}` : "";
  return `${marker} ${prefix} ${name}${detail}`;
}

function commandScore(name: string, description: string, query: string): number {
  if (!query) {
    return 0;
  }
  const lowerName = name.toLowerCase();
  const lowerDescription = description.toLowerCase();
  if (lowerName.startsWith(query)) {
    return 0;
  }
  if (lowerName.includes(query)) {
    return 1;
  }
  if (lowerDescription.includes(query)) {
    return 2;
  }
  return 3;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function cacheEvidenceOverview(evidence: JsonObject[], events: readonly SessionEvent[] = []): string[] {
  let promptTurns = 0;
  let cacheTurns = 0;
  let cachePromptTokens = 0;
  let cachedPromptTokens = 0;

  for (const item of evidence) {
    if (cacheTurnKind(events, stringField(item.run_id)) === "warmup") {
      continue;
    }
    const usage = objectField(item.usage);
    const prompt = numericField(usage.prompt_tokens);
    const cached = numericField(usage.cached_prompt_tokens);
    if (prompt !== undefined) {
      promptTurns += 1;
    }
    if (prompt !== undefined && cached !== undefined) {
      cacheTurns += 1;
      cachePromptTokens += prompt;
      cachedPromptTokens += cached;
    }
  }

  const lines = [`${fg256(39, "turns")} ${evidence.length}`];
  if (cacheTurns > 0 && cachePromptTokens > 0) {
    const hit = Math.max(0, Math.min(1, cachedPromptTokens / cachePromptTokens));
    lines.push(
      `${fg256(39, "usage cache")} cached ${cachedPromptTokens}/${cachePromptTokens} · hit ${(hit * 100).toFixed(1)}% · ${cacheTurns}/${promptTurns} turns exposed`,
    );
  } else if (evidence.some((item) => cacheTurnKind(events, stringField(item.run_id)) === "warmup")) {
    lines.push(fg256(244, "usage cache is warming up; no steady-state turns yet"));
  } else if (promptTurns > 0) {
    lines.push(fg256(244, "usage cache fields were not exposed by recent responses"));
  } else {
    lines.push(fg256(244, "No usage token evidence yet."));
  }

  const metrics = cacheMetricLines(evidence);
  if (metrics.length) {
    lines.push("", fg256(39, "Endpoint prefix-cache metrics"), ...metrics);
  }
  return lines;
}

function isActivityEvent(event: SessionEvent): boolean {
  return (
    event.type.includes("evidence") ||
    event.type === "resource.created" ||
    event.type === "goal.completion_report" ||
    event.type === "run.completed" ||
    event.type === "run.stopped" ||
    event.type === "run.failed"
  );
}

function cacheMetricLines(evidence: JsonObject[]): string[] {
  const metrics = evidence
    .slice()
    .reverse()
    .map((item) => objectField(item.cache_metrics))
    .find((item) => Object.keys(item).length > 0);
  if (!metrics) {
    return [];
  }
  const entries = Object.entries(metrics)
    .map(([key, value]) => [key, numericField(value)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== undefined && /prefix_cache|prompt_tokens_cached|cached_prompt|cache_hit|local_cache/i.test(entry[0]));
  if (!entries.length) {
    return [];
  }
  const queryTotal = sumMatchingMetrics(entries, /prefix_cache_queries/i);
  const hitTotal = sumMatchingMetrics(entries, /prefix_cache_hits/i);
  const lines: string[] = [];
  if (queryTotal && hitTotal !== undefined) {
    lines.push(`  prefix cache hit ${hitTotal}/${queryTotal} · ${((hitTotal / queryTotal) * 100).toFixed(1)}%`);
  }
  lines.push(
    ...entries
      .filter(([key]) => !/prefix_cache_queries|prefix_cache_hits/i.test(key))
      .slice(0, 6)
      .map(([key, value]) => `  ${truncateToWidth(key, Math.max(24, terminalWidth() - 20))} ${formatMetricNumber(value)}`),
  );
  return lines.length ? lines : entries.slice(0, 6).map(([key, value]) => `  ${truncateToWidth(key, Math.max(24, terminalWidth() - 20))} ${formatMetricNumber(value)}`);
}

function sumMatchingMetrics(entries: readonly (readonly [string, number])[], pattern: RegExp): number | undefined {
  let total = 0;
  let matched = false;
  for (const [key, value] of entries) {
    if (pattern.test(key)) {
      total += value;
      matched = true;
    }
  }
  return matched ? total : undefined;
}

function formatMetricNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function isContextCompressionEvent(event: SessionEvent): boolean {
  return event.type === "context.compacted" || event.type === "evidence.context_compression" || event.type.includes("compaction");
}

function formatTokenPressure(estimatedTokens: number, thresholdTokens: number): string {
  if (thresholdTokens <= 0) {
    return `${estimatedTokens} tokens`;
  }
  const pct = Math.round((estimatedTokens / thresholdTokens) * 100);
  return `${estimatedTokens}/${thresholdTokens} tokens · ${pct}%`;
}

function formatCompressionStartActivity(event: Extract<RuntimeStatusEvent, { type: "compression_start" }>): string {
  return [
    "Compressing context",
    compressionReasonLabel(event.reason),
    formatTokenPressure(event.estimated_tokens, event.threshold_tokens),
  ].filter(Boolean).join(" · ");
}

function formatCompressionActivityLine(event: Extract<RuntimeStatusEvent, { type: "compression_end" }>): string {
  const detail = [
    compressionReasonLabel(event.reason),
    `${event.archived_events} archived`,
    `${event.protected_tail_events} prompts kept`,
    formatTokenPressure(event.estimated_tokens, event.threshold_tokens),
  ].filter(Boolean).join(" · ");
  return renderActivityRecordLine({
    marker: "•",
    markerColor: 75,
    action: "Compacted context",
    actionColor: 75,
    detail,
    detailColor: 250,
    width: terminalWidth(),
  });
}

function compressionReasonLabel(reason: string): string {
  const normalized = reason.replace(/^post-run:/, "");
  switch (normalized) {
    case "threshold":
      return "token-threshold";
    case "forced-by-config":
      return "forced";
    default:
      return normalized;
  }
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine ? `daemon:${truncateToWidth(firstLine, 48)}` : "daemon task";
}

function safeTerminalWidth(): number {
  return Math.max(20, terminalWidth() - 1);
}

function safeTerminalHeight(): number {
  return Math.max(12, terminalHeight());
}

function isCancellableJob(job: SupervisorJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "detached" || job.status === "cancel_requested";
}

function formatToolActivityLine(toolName: string, ok: boolean, summary: string, durationMs: number): string {
  const duration = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  const action = toolActivityAction(toolName, ok);
  return renderActivityRecordLine({
    marker: ok ? "•" : "×",
    markerColor: ok ? 48 : 203,
    action,
    actionColor: ok ? 75 : 203,
    detail: compactToolSummary(summary),
    detailColor: ok ? 250 : 203,
    suffix: duration,
    width: terminalWidth(),
  });
}

function codeIntelligenceActivityLabel(status: ContextEngineStatus): string {
  if (status.state === "ready") {
    return "Context ready";
  }
  if (status.state === "degraded") {
    return `Context degraded${status.error ? ` · ${status.error}` : ""}`;
  }
  if (status.state === "syncing") {
    return `Syncing context ${codeIntelligenceProgress(status)}`;
  }
  if (status.state === "off") {
    return "Context off";
  }
  return `Indexing context ${codeIntelligenceProgress(status)}`;
}

function codeIntelligenceProgress(status: ContextEngineStatus): string {
  const phase = status.phase ? `${status.phase} ` : "";
  if (status.current !== undefined && status.total !== undefined && status.total > 0) {
    return `${phase}${status.current}/${status.total}`;
  }
  if (status.files !== undefined) {
    return `${phase}${status.files} files`;
  }
  return `${phase || status.state}`.trim();
}

function toolActivityAction(name: string, ok = true): string {
  const failed = ok ? "" : " failed";
  switch (name) {
    case "run_command":
      return `Ran command${failed}`;
    case "file_search":
      return `Searched workspace${failed}`;
    case "glob":
      return `Scanned files${failed}`;
    case "list_dir":
      return `Listed directory${failed}`;
    case "read_file":
    case "read_resource":
      return `Read file${failed}`;
    case "codegraph_explore":
      return `Explored context${failed}`;
    case "codegraph_search":
      return `Searched semantic index${failed}`;
    case "codegraph_node":
      return `Read indexed symbol${failed}`;
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
      return `Traced semantic index${failed}`;
    case "codegraph_files":
    case "codegraph_status":
      return `Checked context engine${failed}`;
    case "write_file":
      return `Wrote file${failed}`;
    case "edit_file":
    case "ast_edit":
      return `Edited file${failed}`;
    case "apply_patch":
      return `Applied patch${failed}`;
    case "git_status":
      return `Checked git status${failed}`;
    case "git_diff":
    case "git_show":
      return `Read git data${failed}`;
    case "todo_write":
      return `Updated todo${failed}`;
    case "goal":
      return `Updated goal${failed}`;
    case "plan":
      return `Updated plan${failed}`;
    case "complete_step":
      return `Recorded evidence${failed}`;
    case "web_search":
      return `Searched web${failed}`;
    case "web_fetch":
      return `Fetched URL${failed}`;
    case "web_open":
      return `Opened URL${failed}`;
    default:
      if (name.includes("skill")) {
        return `Updated skills${failed}`;
      }
      if (name.includes("image") || name.includes("video") || name.includes("vision") || name.includes("audio")) {
        return `Used Omni${failed}`;
      }
      return `Used tool${failed}`;
  }
}

function compactToolSummary(summary: string): string {
  return summary
    .replace(/^Command exited\s+0$/i, "exited 0")
    .replace(/^Command exited\s+(\d+)$/i, "exited $1")
    .replace(/\s+/g, " ")
    .trim();
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) {
    return "now";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function checkbox(ok: boolean): string {
  return ok ? `${fg256(48, "✓")} ` : `${fg256(203, "□")} `;
}

function permissionColor(permission: string): number {
  switch (permission) {
    case "read":
      return 75;
    case "write":
      return 220;
    case "shell":
      return 171;
    case "network":
      return 45;
    case "destructive":
      return 203;
    default:
      return 248;
  }
}

function displayToolName(name: string): string {
  switch (name) {
    case "codegraph_explore":
      return "context_explore";
    case "codegraph_search":
      return "context_search";
    case "codegraph_node":
      return "context_symbol";
    case "codegraph_callers":
      return "context_callers";
    case "codegraph_callees":
      return "context_callees";
    case "codegraph_impact":
      return "context_impact";
    case "codegraph_files":
      return "context_files";
    case "codegraph_status":
      return "context_status";
    default:
      return name;
  }
}

function isAccessStatusRequest(args: string): boolean {
  const value = args.trim().toLowerCase();
  return value === "status" || value === "show";
}

function parseAccessMode(args: string): PermissionMode | undefined {
  const value = args.trim().toLowerCase().replaceAll("-", "_");
  switch (value) {
    case "full":
    case "full_access":
      return "full_access";
    case "auto":
    case "auto_approve":
      return "auto_approve";
    case "ask":
    case "approval":
    case "request":
    case "request_approval":
      return "ask";
    case "custom":
      return "custom";
    default:
      return undefined;
  }
}

function accessStatusLines(config: VllmAgentConfig, workspace: WorkspaceIdentity, target?: string): string[] {
  const policy = effectiveWorkspacePermission(config, workspace);
  const lines = [
    `${fg256(39, "Mode")} ${accessModeLabel(policy.mode)}${fg256(244, ` · ${policy.source}`)}`,
    `${fg256(39, "Workspace")} ${compactWorkspacePath(workspace.root)}`,
    fg256(244, accessModeSummary(policy.mode)),
  ];
  if (target) {
    lines.push("", `${fg256(39, "Config")} ${target}`);
  }
  lines.push("", `${fg256(39, "/access full")} full access · ${fg256(39, "/access ask")} request approval · ${fg256(39, "/access status")} show current`);
  return lines;
}

function accessModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "full_access":
      return "Full access";
    case "auto_approve":
      return "Auto approve";
    case "ask":
      return "Request approval";
    case "custom":
      return "Custom";
  }
}

function accessModeSummary(mode: PermissionMode): string {
  switch (mode) {
    case "full_access":
      return "External files are readable/writable; tools run without approval prompts.";
    case "auto_approve":
      return "Normal tools run automatically; risky commands and external paths pause for approval.";
    case "ask":
      return "Reads stay open; writes, shell, network, and external paths request approval.";
    case "custom":
      return "Rules come from this workspace's custom config.";
  }
}

function setupDialogTitle(title: string): boolean {
  return /setup|provider|model|endpoint|omni|vault|review|web search/i.test(title);
}

function setupDialogFrameWidth(): number {
  return Math.max(52, safeTerminalWidth());
}

function setupDialogContentWidth(): number {
  return Math.max(20, setupDialogFrameWidth() - 3);
}

export function commandDeckFrame(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(52, width);
  const inner = safeWidth - 1;
  const rail = fg256(75, "▌");
  const row = (line = "") => `${rail}${bg256(236, padRight(`  ${line}`, inner))}`;
  return [
    row(`${fg256(75, "Inferoa")} ${fg256(238, "/")} ${fg256(252, title)}`),
    row(),
    ...body.map((line) => row(line)),
    row(),
  ];
}

function compactWorkspacePath(root: string): string {
  const home = process.env.HOME;
  if (home && (root === home || root.startsWith(`${home}${path.sep}`))) {
    return `~${root.slice(home.length)}`;
  }
  return root;
}

function moveCursorVertical(delta: number): void {
  if (delta > 0) {
    stdout.write(`\x1b[${delta}B`);
  } else if (delta < 0) {
    stdout.write(`\x1b[${Math.abs(delta)}A`);
  }
}
