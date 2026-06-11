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
import { attachDaemonJob, cancelDaemonJob, daemonStatus, detachDaemonJob, queueDaemonRun, queueDaemonRunInWorktree, startDaemon } from "../daemon/supervisor.js";
import type { RuntimeRunOptions, RuntimeRunResult, RuntimeStatusEvent } from "../runtime.js";
import {
  attachGoalPlanSnapshot,
  cloneGoalState,
  completionBudgetReport,
  createGoalState,
  incompleteGoalPlanningMessage,
  goalCompletionCandidateBlockMessage,
  goalCompletionReflectionBlockMessage,
  goalPlanningProgressSummary,
  goalApproachName,
  goalStrategyModeFromPublicName,
  readGoalState,
  recordGoalCompletionReport,
  setGoalOwner,
  setGoalReviewOwner,
  writeGoalState,
  type GoalHorizonSnapshot,
  type GoalReflectionSnapshot,
  type GoalReflectionDecision,
  type GoalRecord,
  type GoalKind,
  type GoalHilPolicy,
  type GoalReviewDecision,
  type GoalStrategyInput,
  type GoalState,
} from "../goals/state.js";
import { runGoalSupervisor } from "../goals/supervisor.js";
import { buildGoalWorkPrompt } from "../goals/supervisor-prompts.js";
import { buildGoalVerificationPrompt, parseGoalVerifierArgs } from "../goals/verifier.js";
import { readGoalLoopView } from "../loop/projection.js";
import type { GoalLoopAttempt } from "../loop/types.js";
import { readLoopHealth } from "../loop/health.js";
import { readLoopDashboard } from "../loop/dashboard.js";
import { readLoopMetrics } from "../loop/metrics.js";
import { readLoopEvidence } from "../loop/evidence.js";
import { readLoopTrace } from "../loop/trace.js";
import { readLoopRoadmap } from "../loop/roadmap.js";
import { readLoopWorkers } from "../loop/workers.js";
import { readLoopConnectors } from "../loop/connectors.js";
import { readLoopTasks } from "../loop/tasks.js";
import { parseConnectorActionPreflightInput, recordConnectorActionPreflight } from "../loop/action-preflight.js";
import { parseConnectorActionRunInput, runConnectorAction } from "../loop/actions.js";
import { readLoopActions } from "../loop/action-log.js";
import { queueGoalVerificationSuite, runGoalVerificationSuite } from "../loop/verifier-suite.js";
import { runConnectorVerifier } from "../loop/connector-verifiers.js";
import {
  createLoopAutomationSchedule,
  enqueueDueAutomationSchedules,
  parseAutomationInterval,
  pauseLoopAutomationSchedule,
  removeLoopAutomationSchedule,
  resumeLoopAutomationSchedule,
  type AutomationIsolation,
  type AutomationReviewPolicy,
} from "../loop/automation.js";
import {
  createGitChangesDiscoverySchedule,
  createGitHubAssignedIssuesDiscoverySchedule,
  createGitHubAssignedPullRequestsDiscoverySchedule,
  createGitHubActionsDiscoverySchedule,
  createGitHubDeploymentsDiscoverySchedule,
  createGitHubDraftReleasesDiscoverySchedule,
  createGitHubIssuesDiscoverySchedule,
  createGitHubNotificationsDiscoverySchedule,
  createGitHubPullRequestsDiscoverySchedule,
  createGitHubReviewRequestsDiscoverySchedule,
  createHttpHealthDiscoverySchedule,
  createLoopDiscoverySchedule,
  createNpmPackageDiscoverySchedule,
  pauseLoopDiscoverySchedule,
  removeLoopDiscoverySchedule,
  resumeLoopDiscoverySchedule,
  runDueDiscoverySchedules,
} from "../loop/discovery.js";
import {
  parseLoopInboxSnoozeUntil,
  promoteLoopInboxItem,
  readLoopInbox,
  readLoopInboxRouting,
  updateLoopInboxAssignment,
  updateLoopInboxItemState,
  updateLoopInboxMute,
  updateLoopInboxRouting,
  type LoopInboxAction,
  type LoopInboxItem,
  type LoopInboxItemKind,
  type LoopInboxPriority,
  type LoopInboxPromotionIsolation,
} from "../loop/inbox.js";
import { readLoopPolicy, resolveLoopBackgroundIsolation } from "../loop/policy.js";
import { adoptLoopWorktree, cleanupLoopWorktrees, createLoopWorktree, listLoopWorktrees, readLoopWorktreeHealth, removeLoopWorktree } from "../loop/worktree.js";
import { optLiteAdopt, optLitePropose, optLiteReport, optLiteRun, optLiteStatus } from "../opt/opt-lite.js";
import type { GoalLoopVerification } from "../loop/types.js";
import { readAutoresearchState, researchCompletionBlockMessage, setAutoresearchMode } from "../autoresearch/state.js";
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
import type { AutomationSchedule, DiscoveryCandidate, DiscoverySchedule, ManagedWorktree, SupervisorJob } from "../session/store.js";
import { randomId } from "../util/hash.js";
import { isAbortError } from "../util/abort.js";
import type { loadApp } from "../app.js";
import { ansi, bgLine, bg256, center, centerBlock, fg256, frame, padRight, terminalHeight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { parseSlashCommand, slashCommandWithSubcommands, slashSubcommands, suggestedSlashCommands, type SlashCommandName } from "./slash.js";
import { inferoaActivityLabel, renderActivityLine, renderActivityRecordLine } from "./activity.js";
import { cacheTurnKind, formatDuration, renderCacheFooter, renderCacheReportTurn } from "./cache-footer.js";
import { renderCompactEventLine, renderSessionActivityLines } from "./event-view.js";
import { renderModeMetadataRight } from "./mode-footer.js";
import { renderPlanDocumentSurface } from "./plan-view.js";
import { renderRtkSessionLines } from "./rtk-view.js";
import { renderTokenmaxxingRows, renderTokenmaxxingScreen, tokenmaxxingScreenPageCount, type TokenmaxxingScreenRow } from "./tokenmaxxing-view.js";
import { composerEraseRowsForResize } from "./resize.js";
import { RESUME_SESSION_PAGE_SIZE, resumeSessionPage } from "./session-picker.js";
import { filterProviderPickerOptions, providerPickerPage } from "./provider-picker.js";
import { renderSessionTranscript } from "./session-transcript.js";
import { renderUnknownSlashCommandNotice } from "./slash-notice.js";
import { effectiveWorkspacePermission, setWorkspacePermissionMode } from "../tools/permissions.js";
import { terminalBlockPatchSequence } from "./redraw.js";
import { renderToolCards } from "./tool-renderer.js";
import { withConversationGap } from "./transcript-spacing.js";
import { MarkdownStreamRenderer } from "./markdown.js";
import { renderHomeFrame } from "./home.js";
import { applyTextInputToken, createTextInputState, renderTextInputDisplay } from "./text-input.js";
import { isPathListInput } from "../util/path-input.js";
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
  moveComposerSuggestionPage,
  type ComposerRenderResult,
  type ComposerPanel,
  type ComposerCompactRange,
  compactModelLabel,
  COMPOSER_SUGGESTION_PAGE_SIZE,
  WELCOME_COMPOSER_SUGGESTION_PAGE_SIZE,
  normalizeComposerPastedInput,
  renderComposerActivityLine,
  renderComposerSurface,
  renderWelcomeComposerSurface,
  resolveComposerSubmission,
} from "./composer.js";
import {
  createPromptQueueState,
  enqueuePromptForSubmission,
  promptQueuePreviewLines,
  shiftPromptForSubmission,
  type PromptQueueState,
} from "./prompt-queue.js";
import { applyClarifyInputToken, createClarifyInputState, renderClarifyComposerPanel } from "./clarify.js";
import {
  applyLoopReviewInputToken,
  createLoopReviewInputState,
  renderLoopReviewPromptLines,
  type LoopReviewInputResponse,
} from "./loop-review.js";
import {
  createComposerInputHistory,
  navigateComposerInputHistory,
  recordComposerInputHistoryEntry,
  type ComposerInputHistoryNavigation,
} from "./input-history.js";
import type { ContextEngineStatus } from "../code-intelligence/codegraph-engine.js";

type LoadedApp = Awaited<ReturnType<typeof loadApp>>;
type ProviderChoice = "direct" | "auto" | "external";
type WebSearchProviderChoice = VllmAgentConfig["web_search"]["provider"];
type SkillAction = "list" | "manage";
type SessionAction = "resume" | "new" | "rename" | "archive" | "all";
type DaemonAction = "status" | "queue" | "attach" | "detach" | "cancel";
type WorktreeAction = "status" | "list" | "health" | "create" | "run" | "adopt" | "cleanup" | "remove";
type DoctorAction = "status" | "run" | "tools";
type ToolTraceMode = "compact" | "expanded";
type GoalKindChoice = "task" | "research";
type GoalApproachChoice = "auto" | "focus" | "explore" | "timebox";
type GoalCampaignHoursChoice = "auto" | "30m" | "2h" | "4h" | "custom";
type GoalReviewPolicyChoice = "auto" | "review";
type GoalReviewChoice = GoalReviewDecision;
type GoalSetupWizardStep = "Type" | "Approach" | "Human in the Loop" | "Review";

const GOAL_SETUP_WIZARD_STEPS: readonly GoalSetupWizardStep[] = ["Type", "Approach", "Human in the Loop", "Review"];
const GOAL_SETUP_PANEL_BODY_ROWS = 10;

interface GoalStartOptions {
  kind?: GoalKind;
  strategy?: GoalStrategyInput;
  hil_policy?: GoalHilPolicy;
  owner?: string;
  review_owner?: string;
}

interface ParsedGoalModeOptions extends GoalStartOptions {
  objective: string;
}

export interface GoalSetupWizardSelections {
  type?: string;
  approach?: string;
  hil?: string;
}

interface ComposerMetadataRightCache {
  sessionId: string;
  latestEventId: number;
  activeRunStartedAtMs?: number;
  activeRunElapsedSecond: number;
  checkedAtMs: number;
  value?: string;
}

interface EndpointProbeResult {
  models: string[];
  errors: string[];
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

interface SelectOptionWindow<T> {
  items: readonly T[];
  startIndex: number;
  pageIndex: number;
  totalPages: number;
  totalItems: number;
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

interface GoalSupervisorRecordDetail {
  label: string;
  text: string;
  color?: number;
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

interface SubmitPromptOptions {
  renderPrompt?: boolean;
  requestClass?: RuntimeRunOptions["request_class"];
  visibility?: RuntimeRunOptions["visibility"];
  runId?: string;
  activityLabel?: string;
  suppressTranscript?: boolean;
}

interface ReadComposerOptions {
  placeholder?: string;
  initialBuffer?: string;
  suggestions?: boolean;
  cancelOnInterrupt?: boolean;
}

const FOREGROUND_GOAL_MAX_ITERATIONS = 10_000;

const CLEAR_TO_END = "\x1b[J";
const CLEAR_LINE = "\x1b[2K";
const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PASTE_TOKEN_PREFIX = "\u{e000}paste:";
const SETUP_TOTAL_STEPS = 7;
const SELECT_OPTION_PAGE_SIZE = 12;
const COMPOSER_METADATA_CACHE_TTL_MS = 250;

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
  #inlineRenderedContent: string[] | undefined;
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
  #goalSupervisorActive = false;
  #activeAbort: AbortController | undefined;
  #activeRunStartedAtMs: number | undefined;
  #lastGoalMetadataRedrawAtMs = 0;
  #composerMetadataRightCache: ComposerMetadataRightCache | undefined;
  #inputHistory = createComposerInputHistory();
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
      if (isPathListInput(text)) {
        this.recordInputHistory(text);
        this.enqueuePrompt(text);
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
      this.recordInputHistory(text);
      this.enqueuePrompt(text);
    }
  }

  private recordInputHistory(text: string): void {
    this.#inputHistory = recordComposerInputHistoryEntry(this.#inputHistory, text);
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
      await this.drainForegroundGoalSupervisor();
    }
    this.clearQueueFooter();
  }

  private async drainForegroundGoalSupervisor(): Promise<void> {
    if (this.#goalSupervisorActive) {
      return;
    }
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      return;
    }
    this.#goalSupervisorActive = true;
    try {
      const session = this.optionalSession();
      if (!session) {
        return;
      }
      await runGoalSupervisor({
        store: this.app.store,
        sessionId: session.session_id,
        supervisor: "foreground",
        maxIterations: FOREGROUND_GOAL_MAX_ITERATIONS,
        workRequestClass: "interactive",
        shouldContinue: () => this.#running && !this.#promptQueue.length,
        runTurn: async (request) =>
          await this.submitPrompt(request.prompt, {
            renderPrompt: false,
            requestClass: request.requestClass,
            visibility: request.visibility,
            runId: request.runId,
            activityLabel: request.activityLabel,
            suppressTranscript: request.suppressTranscript,
          }),
        onReflectionExpanded: (state) => {
          this.renderGoalSupervisorRecord("Loop decision", reflectionDetail("expanded loop task", state.goal.last_reflection_summary, state.goal.horizon_generation), 75);
        },
        onCompleted: (state) => {
          this.renderGoalSupervisorRecord("Loop complete", goalCompletionRecordDetails(state.goal), 48);
        },
        onPaused: (_state, _runId, reason) => {
          this.renderGoalSupervisorRecord("Loop paused", reason, 220);
        },
        onWaiting: (reason) => {
          this.renderGoalSupervisorRecord("Loop waiting", reason);
        },
      });
      await this.promptPendingGoalReviewIfNeeded(session);
    } finally {
      this.#goalSupervisorActive = false;
    }
  }

  private async promptPendingGoalReviewIfNeeded(session: SessionRecord): Promise<void> {
    if (!this.#running || this.#promptQueue.length) {
      return;
    }
    const state = readGoalState(this.app.store, session.session_id);
    if (!state?.goal.pending_review_decision) {
      return;
    }
    this.renderGoalSupervisorRecord("Loop review", goalReviewPendingDetail(state.goal.pending_review_decision), 220);
    if (!stdin.isTTY) {
      this.renderLoopReviewPanel(state);
      return;
    }
    try {
      const response = await this.askLoopReviewDecision(state);
      await this.applyGoalReviewDecision(session, state, response.decision, response.feedback);
    } catch (error) {
      if (error instanceof Error && /cancelled/i.test(error.message)) {
        this.renderGoalSupervisorRecord("Loop review pending", "no decision recorded", 220);
        return;
      }
      throw error;
    }
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

  private shouldRefreshGoalMetadata(nowMs: number): boolean {
    if (!this.#goalSupervisorActive || this.#activeRunStartedAtMs === undefined) {
      return false;
    }
    if (nowMs - this.#lastGoalMetadataRedrawAtMs < 1000) {
      return false;
    }
    this.#lastGoalMetadataRedrawAtMs = nowMs;
    return true;
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
    let historyNavigation: ComposerInputHistoryNavigation | undefined;
    let renderedLines = 0;
    let renderedCursorLine = 0;
    let renderedCursorColumn = 0;
    let renderedWidth = 0;
    let renderedBlockLines: string[] = [];
    let renderedActivityLine: number | undefined;
    let renderedCodeIntelligenceLine: number | undefined;
    let renderedCodeIntelligenceColumn: number | undefined;
    let renderedCodeIntelligenceWidth: number | undefined;
    let submissionNotice: string | undefined;
    let forceFullRedraw = false;
    let eraseAfterResize = false;
    const pasteState: TerminalPasteState = {};
    this.#rl?.pause();
    stdout.write(`${BRACKETED_PASTE_ENABLE}${ansi.showCursor}`);

    return await new Promise((resolve, reject) => {
      const resetRenderedState = () => {
        renderedLines = 0;
        renderedCursorLine = 0;
        renderedCursorColumn = 0;
        renderedWidth = 0;
        renderedBlockLines = [];
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
      const cancel = () => {
        cleanup();
        stdout.write(ansi.reset);
        reject(new Error("Input cancelled"));
      };
      const render = () => {
        const items = composerItems();
        if (selected >= items.length) {
          selected = 0;
        }
        const width = safeTerminalWidth();
        const height = safeTerminalHeight();
        const welcome = this.shouldRenderWelcomeComposer();
        const block = welcome
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
              notice: submissionNotice,
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
              notice: submissionNotice,
              metadataLeft: this.composerMetadataLeft(),
              metadataRight: this.composerMetadataRight(),
              placeholder: options.placeholder,
            });
        const canPatch =
          renderedBlockLines.length > 0 &&
          renderedWidth === width &&
          !eraseAfterResize &&
          !(forceFullRedraw && welcome);
        if (forceFullRedraw && welcome) {
          stdout.write(ansi.clear);
          resetRenderedState();
        } else if (canPatch) {
          stdout.write(
            terminalBlockPatchSequence(
              {
                lines: renderedBlockLines,
                cursorLine: renderedCursorLine,
                cursorColumn: renderedCursorColumn,
                width: renderedWidth,
              },
              block,
            ),
          );
          updateRenderedBlockState(block, width);
          forceFullRedraw = false;
          eraseAfterResize = false;
          return;
        } else {
          erase({ resized: eraseAfterResize });
        }
        forceFullRedraw = false;
        eraseAfterResize = false;
        stdout.write(block.lines.join("\n"));
        updateRenderedBlockState(block, width);
        positionCursorForRenderedBlock(block);
      };
      const updateRenderedBlockState = (block: ComposerRenderResult, width: number) => {
        renderedLines = block.lines.length;
        renderedCursorLine = block.cursorLine;
        renderedCursorColumn = block.cursorColumn;
        renderedWidth = width;
        renderedBlockLines = block.lines.slice();
        renderedActivityLine = block.activityLine;
        renderedCodeIntelligenceLine = block.codeIntelligenceLine;
        renderedCodeIntelligenceColumn = block.codeIntelligenceColumn;
        renderedCodeIntelligenceWidth = block.codeIntelligenceWidth;
      };
      const positionCursorForRenderedBlock = (block: ComposerRenderResult) => {
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
        historyNavigation = undefined;
        submissionNotice = undefined;
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
        historyNavigation = undefined;
        submissionNotice = undefined;
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
        historyNavigation = undefined;
        submissionNotice = undefined;
        render();
      };
      const deleteRange = (start: number, end: number) => {
        buffer = `${buffer.slice(0, start)}${buffer.slice(end)}`;
        cursor = start;
        compactRanges = adjustComposerCompactRanges(compactRanges, start, end, 0);
        selected = 0;
        selectionTouched = false;
        historyNavigation = undefined;
        submissionNotice = undefined;
        render();
      };
      const navigateHistory = (direction: "previous" | "next") => {
        if (options.suggestions === false) {
          return false;
        }
        const next = navigateComposerInputHistory(this.#inputHistory, historyNavigation, direction, buffer);
        historyNavigation = next.navigation;
        if (!next.changed) {
          return false;
        }
        buffer = next.buffer;
        cursor = next.cursor;
        compactRanges = [];
        selected = 0;
        selectionTouched = false;
        submissionNotice = undefined;
        render();
        return true;
      };
      const pageSuggestions = (delta: number): boolean => {
        const items = composerItems();
        const pageSize = this.shouldRenderWelcomeComposer() ? WELCOME_COMPOSER_SUGGESTION_PAGE_SIZE : COMPOSER_SUGGESTION_PAGE_SIZE;
        if (items.length <= pageSize || (!buffer.startsWith("/") && !buffer.startsWith("$"))) {
          return false;
        }
        selected = moveComposerSuggestionPage(selected, items.length, pageSize, delta);
        selectionTouched = true;
        submissionNotice = undefined;
        render();
        return true;
      };
      const submit = () => {
        const decision = resolveComposerSubmission({
          buffer,
          compactRanges,
          items: composerItems(),
          selected,
          selectionTouched,
          validateSlashCommands: options.suggestions !== false,
        });
        if (decision.action === "stay") {
          submissionNotice = decision.notice;
          render();
          return;
        }
        finish(decision.text);
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
            if (options.cancelOnInterrupt) {
              cancel();
            } else {
              finish("/exit");
            }
            done = true;
          } else if (key === "\u001b") {
            if (options.cancelOnInterrupt) {
              cancel();
              done = true;
            } else if (buffer) {
              buffer = "";
              cursor = 0;
              compactRanges = [];
              selected = 0;
              selectionTouched = false;
              historyNavigation = undefined;
              submissionNotice = undefined;
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
              submissionNotice = undefined;
              render();
            } else {
              navigateHistory("previous");
            }
          } else if (key === "\u001b[B") {
            const count = composerItems().length;
            if (count) {
              selected = (selected + 1) % count;
              selectionTouched = true;
              submissionNotice = undefined;
              render();
            } else {
              navigateHistory("next");
            }
          } else if (key === "\u001b[C") {
            if (!pageSuggestions(1)) {
              cursor = moveComposerCursorRight(buffer, cursor);
              render();
            }
          } else if (key === "\u001b[D") {
            if (!pageSuggestions(-1)) {
              cursor = moveComposerCursorLeft(buffer, cursor);
              render();
            }
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
              historyNavigation = undefined;
              submissionNotice = undefined;
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
              historyNavigation = undefined;
              submissionNotice = undefined;
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
      const subcommandMatch = lower.match(/^\/([a-z-]+)\s+(.*)$/);
      if (subcommandMatch) {
        const commandName = subcommandMatch[1] as SlashCommandName;
        const query = subcommandMatch[2]?.trim().toLowerCase() ?? "";
        return slashSubcommands(commandName)
          .filter((item) => !query || `${item.value} ${item.description}`.toLowerCase().includes(query))
          .sort((a, b) => commandScore(a.name, a.description, query) - commandScore(b.name, b.description, query))
          .map((item) => ({
            value: item.value,
            label: item.value,
            description: item.description,
            kind: "command" as const,
          }));
      }
      const query = buffer.slice(1).trim().toLowerCase();
      return suggestedSlashCommands()
        .filter((command) => !query || `${command.name} ${command.description}`.toLowerCase().includes(query))
        .sort((a, b) => commandScore(a.name, a.description, query) - commandScore(b.name, b.description, query))
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
        `  ${fg256(244, "enter submit · esc/ctrl+c cancel")}`,
      ],
    };
    try {
      return await this.readComposer({
        placeholder: label,
        initialBuffer: defaultValue,
        suggestions: false,
        cancelOnInterrupt: true,
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
      this.#composerMetadataRightCache = undefined;
      return undefined;
    }
    const nowMs = Date.now();
    const activeRunElapsedSecond = this.activeRunElapsedSecond(nowMs);
    const cached = this.#composerMetadataRightCache;
    if (
      cached &&
      cached.sessionId === session.session_id &&
      cached.activeRunStartedAtMs === this.#activeRunStartedAtMs &&
      cached.activeRunElapsedSecond === activeRunElapsedSecond &&
      nowMs - cached.checkedAtMs < COMPOSER_METADATA_CACHE_TTL_MS
    ) {
      return cached.value;
    }
    const latestEventId = this.app.store.latestEventId(session.session_id);
    if (
      cached &&
      cached.sessionId === session.session_id &&
      cached.latestEventId === latestEventId &&
      cached.activeRunStartedAtMs === this.#activeRunStartedAtMs &&
      cached.activeRunElapsedSecond === activeRunElapsedSecond
    ) {
      return cached.value;
    }
    const plan = readPlanState(this.app.store, session.session_id);
    const autoresearch = readAutoresearchState(this.app.store, session.session_id);
    const goal = readGoalState(this.app.store, session.session_id);
    const value = renderModeMetadataRight({ plan, autoresearch, goal }, { nowMs, activeRunStartedAtMs: this.#activeRunStartedAtMs });
    this.#composerMetadataRightCache = {
      sessionId: session.session_id,
      latestEventId,
      activeRunStartedAtMs: this.#activeRunStartedAtMs,
      activeRunElapsedSecond,
      checkedAtMs: nowMs,
      value,
    };
    return value;
  }

  private activeRunElapsedSecond(nowMs: number): number {
    if (this.#activeRunStartedAtMs === undefined) {
      return -1;
    }
    return Math.floor(Math.max(0, nowMs - this.#activeRunStartedAtMs) / 1000);
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
    this.#inlinePanelStartRow = undefined;
    this.#inlineRenderedContent = undefined;
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
        case "loop":
          await this.renderLoopView(args);
          return;
        case "inbox":
          await this.renderInboxView(args);
          return;
        case "self-improve":
          await this.renderSelfImproveView(args);
          return;
        case "plan":
          await this.renderPlanView(args);
          return;
        case "tokenmaxxing":
          await this.renderTokenmaxxingView(args);
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
        case "daemon":
          await this.renderDaemonView(args);
          return;
        case "automation":
          await this.renderAutomationView(args);
          return;
        case "discovery":
          await this.renderDiscoveryView(args);
          return;
        case "worktree":
          await this.renderWorktreeView(args);
          return;
        case "doctor":
          await this.renderDoctorView(args);
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
        this.clearCenteredPrompt();
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
    const commands = suggestedSlashCommands()
      .filter((command) => !normalized || `${command.name} ${command.description}`.toLowerCase().includes(normalized));
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
      fg256(244, "Direct URLs are opened by web_open even when keyword search uses fallback."),
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
        this.clearCenteredPrompt();
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
    let input = createTextInputState();
    this.#rl?.pause();
    stdout.write(ansi.hideCursor);
    return await new Promise((resolve, reject) => {
      const render = () => {
        const panelInputWidth = Math.min(76, Math.max(48, terminalWidth() - 14));
        const display = renderTextInputDisplay(input, panelInputWidth - 5, { secret: options.secret });
        const cursor = fg256(75, "▌");
        const defaultHint = defaultValue && !options.secret ? `enter accept · default ${defaultValue}` : "enter accept";
        this.renderCenteredPanel(label, [
          `${fg256(75, "›")} ${display.beforeCursor}${cursor}${display.afterCursor}${input.value ? "" : ` ${fg256(238, "type to override")}`}`,
          "",
          setupHint(`${defaultHint} · esc cancel`),
        ], true);
      };
      const cleanup = () => {
        this.clearCenteredPrompt();
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
        resolve(input.value.trim() || defaultValue || "");
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
          } else {
            input = applyTextInputToken(input, key);
            render();
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
      const page = selectOptionWindow(options, selected, SELECT_OPTION_PAGE_SIZE);
      const lines = page.items.map((option, offset) => {
        const index = page.startIndex + offset;
        const active = index === selected;
        return renderSetupOptionLine(option.label, option.description, active);
      });
      const hint =
        page.totalPages > 1
          ? `${page.pageIndex + 1}/${page.totalPages} · ${page.totalItems} options · ←/→ page · ↑/↓ move · space/enter select · esc cancel`
          : "↑/↓ move · space/enter select · esc cancel";
      this.renderCenteredPanel(title, [...lines, "", setupHint(hint), ...footer], true);
    };
    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.clearCenteredPrompt();
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
        if (key.includes("\u001b[D") || key === "p") {
          selected = moveSelectOptionPage(selected, options.length, SELECT_OPTION_PAGE_SIZE, -1);
          render();
          return;
        }
        if (key.includes("\u001b[C") || key === "n") {
          selected = moveSelectOptionPage(selected, options.length, SELECT_OPTION_PAGE_SIZE, 1);
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

  private async renderTokenmaxxingView(args = ""): Promise<void> {
    const session = this.optionalSession();
    if (!session) {
      this.renderPanel("Tokenmaxxing", ["No active session yet. Run a prompt first."]);
      return;
    }
    const action = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if (action && action !== "signals" && action !== "signal") {
      this.renderPanel("Tokenmaxxing", [`Unknown tokenmaxxing view '${action}'.`, fg256(244, "Use /tokenmaxxing or /tokenmaxxing signals.")]);
      return;
    }
    await this.renderTokenmaxxingFullscreen(session, { signals: action === "signals" || action === "signal" });
  }

  private async renderTokenmaxxingFullscreen(session: SessionRecord, options: { signals?: boolean } = {}): Promise<void> {
    this.#rl?.pause();
    let pageIndex = 0;
    let latestBody: TokenmaxxingScreenRow[] = [];
    let renderedLines: string[] = [];
    let renderedWidth = 0;
    let renderedCursorLine = 0;
    const clampPage = () => {
      const pageCount = tokenmaxxingScreenPageCount(latestBody, terminalHeight());
      pageIndex = Math.max(0, Math.min(pageIndex, pageCount - 1));
    };
    const render = () => {
      const width = safeTerminalWidth();
      const height = terminalHeight();
      const events = this.app.store.listEvents(session.session_id);
      const evidence = this.app.store.listEndpointEvidence(session.session_id);
      latestBody = renderTokenmaxxingRows(events, evidence, width, {
        detailLimit: Number.POSITIVE_INFINITY,
        activityOnly: options.signals === true,
        includeActivity: options.signals === true,
      });
      clampPage();
      const screen = renderTokenmaxxingScreen(latestBody, width, height, pageIndex);
      const sameFrame = renderedWidth === width && renderedLines.length === screen.length && renderedLines.every((line, index) => line === screen[index]);
      if (sameFrame) {
        return;
      }
      const canPatch = renderedLines.length > 0 && renderedWidth === width && renderedLines.length === screen.length;
      if (canPatch) {
        stdout.write(
          terminalBlockPatchSequence(
            { lines: renderedLines, cursorLine: renderedCursorLine, cursorColumn: 0, width: renderedWidth },
            { lines: screen, cursorLine: screen.length - 1, cursorColumn: 0 },
          ),
        );
      } else {
        stdout.write(`${ansi.clear}${ansi.hideCursor}${screen.join("\n")}`);
      }
      renderedLines = screen;
      renderedWidth = width;
      renderedCursorLine = screen.length - 1;
    };

    render();
    const interval = setInterval(render, 1000);
    (interval as { unref?: () => void }).unref?.();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(interval);
        stdin.off("data", onData);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdout.write(ansi.showCursor);
        this.resumeReadline();
        this.redrawVisibleSessionSurface();
        resolve();
      };
      const page = (delta: number) => {
        pageIndex += delta;
        clampPage();
        render();
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          if (key === "\u0003" || key === "\u001b") {
            done();
            return;
          }
          if (key === "\u001b[D") {
            page(-1);
          } else if (key === "\u001b[C") {
            page(1);
          }
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
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
          `${fg256(39, "protected")} ${numberField(latestCompacted.data.protected_tail_events) ?? "unknown"}`,
          numberField(latestCompacted.data.preserved_tail_events) === undefined
            ? undefined
            : `${fg256(39, "preserved")} ${numberField(latestCompacted.data.preserved_tail_events)} replay events`,
          `${fg256(39, "before")} ${numberField(latestCompacted.data.estimated_tokens_before) ?? "unknown"} estimated tokens`,
          ...(latestEvidence
            ? [
                `${fg256(39, "threshold")} ${numberField(latestEvidence.data.threshold_tokens) ?? "unknown"} tokens`,
                `${fg256(39, "record")} persisted`,
              ]
            : []),
          ...(summaryLines.length ? ["", fg256(39, "Summary"), ...summaryLines.map((line) => `  ${truncateToWidth(line, Math.max(20, terminalWidth() - 8))}`)] : []),
        ].filter((line): line is string => line !== undefined)
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

  private async renderLoopControlView(args: string): Promise<void> {
    const parsed = parseModeAction(args, new Set(["status", "mode", "owner", "review-owner", "review", "verify", "verify-github-pr", "verify-github-pr-status", "verify-github-review-request", "verify-github-issue-status", "verify-github-notification", "verify-github-run", "verify-github-workflow", "verify-github-deployment", "verify-github-release", "verify-npm-package", "verify-git-clean", "verify-http", "pause", "resume", "budget", "complete", "drop"]));
    const existingSession = this.optionalSession();
    if (!existingSession && parsed.action === "status") {
      this.renderLoopTranscriptPanel("Loop", ["No active session yet. Use /loop <objective> to start one."]);
      return;
    }
    const session = existingSession ?? this.createModeSession(titleFromPromptForMode(parsed.rest || "Loop"));
    const current = readGoalState(this.app.store, session.session_id);

    if (!parsed.action && !parsed.rest) {
      if (current) {
        this.renderGoalPanel(current);
        return;
      }
      const objective = (await this.askModeObjective("Loop objective")).trim();
      if (!objective) {
        this.renderNotice("No loop objective entered.");
        return;
      }
      const setup = await this.chooseGoalSetup(objective);
      await this.startGoal(session, objective, setup);
      return;
    }

    if (parsed.action === "budget") {
      this.renderNotice("Loop token budgets are no longer a slash command. Start a bounded loop through the model/tool flow when needed.");
      return;
    }

    if (parsed.action === "mode") {
      const start = parseGoalModeArgs(parsed.rest);
      const setup = start ?? (await this.chooseGoalSetup());
      const objective = start?.objective || (await this.askModeObjective("Loop objective", current?.goal.objective)).trim();
      if (!objective) {
        this.renderNotice("No loop objective entered.");
        return;
      }
      const targetHours = setup.strategy?.mode === "campaign" && setup.strategy.target_hours === undefined ? await this.chooseCampaignHours() : setup.strategy?.target_hours;
      await this.startGoal(session, objective, {
        kind: setup.kind,
        strategy: setup.strategy?.mode === "campaign" ? { ...setup.strategy, target_hours: targetHours } : setup.strategy,
        hil_policy: setup.hil_policy,
        owner: setup.owner,
        review_owner: setup.review_owner,
      });
      return;
    }

    if (!parsed.action) {
      if (parsed.rest.trim().toLowerCase() === "show") {
        this.renderNotice("Use /loop status.");
        return;
      }
      const legacy = legacyGoalModeShortcut(parsed.rest);
      if (legacy) {
        this.renderNotice(`Use /loop mode ${legacy} <objective>. Loop modes now live under /loop mode.`);
        return;
      }
      const start = parseGoalStartArgs(parsed.rest);
      const objective = start.objective || (await this.askModeObjective("Loop objective", current?.goal.objective)).trim();
      if (!objective) {
        this.renderNotice("No loop objective entered.");
        return;
      }
      const setup = await this.chooseGoalSetup(objective);
      const options: GoalStartOptions = { ...setup };
      if (start.owner ?? setup.owner) {
        options.owner = start.owner ?? setup.owner;
      }
      if (start.review_owner ?? setup.review_owner) {
        options.review_owner = start.review_owner ?? setup.review_owner;
      }
      await this.startGoal(session, objective, options);
      return;
    }

    if (parsed.action === "status") {
      this.renderGoalPanel(current);
      return;
    }

    if (parsed.action === "owner") {
      await this.updateGoalOwner(session, current, parsed.rest);
      return;
    }

    if (parsed.action === "review-owner") {
      await this.updateGoalReviewOwner(session, current, parsed.rest);
      return;
    }

    if (parsed.action === "review") {
      await this.reviewGoalDecision(session, current, parsed.rest);
      return;
    }

    if (parsed.action === "verify") {
      await this.verifyGoal(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-pr") {
      await this.verifyGoalGitHubPullRequest(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-pr-status") {
      await this.verifyGoalGitHubPullRequestStatus(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-review-request") {
      await this.verifyGoalGitHubReviewRequest(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-issue-status") {
      await this.verifyGoalGitHubIssueStatus(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-notification") {
      await this.verifyGoalGitHubNotification(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-run") {
      await this.verifyGoalGitHubRun(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-workflow") {
      await this.verifyGoalGitHubWorkflow(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-deployment") {
      await this.verifyGoalGitHubDeployment(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-github-release") {
      await this.verifyGoalGitHubRelease(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-npm-package") {
      await this.verifyGoalNpmPackage(session, current, parsed.rest);
      return;
    }
    if (parsed.action === "verify-git-clean") {
      await this.verifyGoalGitClean(session, current);
      return;
    }
    if (parsed.action === "verify-http") {
      await this.verifyGoalHttp(session, current, parsed.rest);
      return;
    }

    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
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
        this.renderNotice(`Cannot resume a ${next.goal.status} loop.`);
        return;
      }
      if (next.goal.pending_review_decision) {
        this.renderNotice("Resolve the pending loop review decision before resuming.");
        this.renderGoalPanel(current);
        return;
      }
      next.enabled = true;
      next.goal.status = "active";
      next.goal.updated_at = new Date().toISOString();
      const saved = writeGoalState(this.app.store, session.session_id, next);
      this.renderGoalPanel(saved);
      await this.enqueueGoalContinuation(saved);
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
      if (parsed.action === "complete") {
        const reflectionMessage = goalCompletionReflectionBlockMessage(current.goal);
        if (reflectionMessage) {
          this.renderNotice(reflectionMessage);
          this.renderGoalPanel(current);
          return;
        }
        const candidateMessage = goalCompletionCandidateBlockMessage(current.goal);
        if (candidateMessage) {
          this.renderNotice(candidateMessage);
          this.renderGoalPanel(current);
          return;
        }
        if (current.goal.kind === "research") {
          const researchMessage = researchCompletionBlockMessage(readAutoresearchState(this.app.store, session.session_id));
          if (researchMessage) {
            this.renderNotice(researchMessage);
            this.renderGoalPanel(current);
            return;
          }
        }
      }
      if (summary) {
        next.goal.summary = summary;
      }
      next.enabled = false;
      next.goal.status = parsed.action === "complete" ? "complete" : "dropped";
      next.goal.updated_at = new Date().toISOString();
      const runId = parsed.action === "complete" ? randomId("goal") : undefined;
      const saved = writeGoalState(this.app.store, session.session_id, next, runId);
      if (saved.goal.kind === "research") {
        setAutoresearchMode(this.app.store, session.session_id, { mode: "off", goal: saved.goal.objective }, runId);
      }
      if (parsed.action === "complete" && runId) {
        recordGoalCompletionReport(this.app.store, session.session_id, runId);
      }
      this.renderGoalPanel(saved);
    }
  }

  private async reviewGoalDecision(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    if (!current.goal.pending_review_decision) {
      this.renderNotice("No pending loop review decision.");
      this.renderGoalPanel(current);
      return;
    }
    const parsed = parseGoalReviewArgs(args);
    if (!parsed.decision) {
      if (!stdin.isTTY) {
        this.renderLoopReviewPanel(current);
        return;
      }
      const response = await this.askLoopReviewDecision(current);
      await this.applyGoalReviewDecision(session, current, response.decision, response.feedback);
      return;
    }
    const decision = parsed.decision;
    let feedback = parsed.feedback;
    if (!feedback && decision !== "approve") {
      feedback = (await this.ask(decision === "block" ? "Block reason" : "Review feedback", current.goal.pending_review_decision.summary)).trim();
    }
    await this.applyGoalReviewDecision(session, current, decision, feedback);
  }

  private async applyGoalReviewDecision(session: SessionRecord, current: GoalState, decision: GoalReviewDecision, feedback?: string): Promise<void> {
    const registry = new ToolRegistry(this.app.config, this.app.workspace, this.app.store);
    const result = await registry.call(
      {
        id: randomId("goal_review"),
        name: "goal",
        arguments: {
          op: "review_decision",
          review_decision: decision,
          ...(feedback ? { feedback } : {}),
        },
      },
      { session_id: session.session_id, run_id: randomId("goal_review"), request_class: "interactive", visibility: "normal", control_plane: true },
    );
    const saved = readGoalState(this.app.store, session.session_id);
    if (!result.ok) {
      this.renderNotice(result.error?.message ?? result.summary);
      this.renderGoalPanel(saved ?? current);
      return;
    }
    this.renderGoalPanel(saved);
    if (saved?.enabled && saved.goal.status === "active" && !saved.goal.pending_review_decision) {
      await this.enqueueGoalContinuation(saved);
    }
  }

  private async askLoopReviewDecision(current: GoalState): Promise<LoopReviewInputResponse> {
    if (!stdin.isTTY) {
      throw new Error("Loop review requires an interactive terminal.");
    }
    let state = createLoopReviewInputState();
    const previousInputModalActive = this.#inputModalActive;
    this.#inputModalActive = true;
    this.#rl?.pause();
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdout.write(ansi.showCursor);
    return await new Promise((resolve, reject) => {
      const render = () => {
        this.renderInlinePanel("Loop Review", renderLoopReviewPromptLines(current.goal, state, safeTerminalWidth()));
      };
      const cleanup = () => {
        this.eraseInlinePanel();
        this.#inputModalActive = previousInputModalActive;
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdout.write(ansi.hideCursor);
        this.resumeReadline();
      };
      const finish = (response: LoopReviewInputResponse) => {
        cleanup();
        resolve(response);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Loop review cancelled"));
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          const result = applyLoopReviewInputToken(state, key);
          state = result.state;
          if (result.cancelled) {
            cancel();
            return;
          }
          if (result.response) {
            finish(result.response);
            return;
          }
        }
        render();
      };
      const onResize = () => {
        render();
      };
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private renderLoopReviewPanel(state: GoalState): void {
    this.renderLoopTranscriptPanel("Loop Review", loopReviewPanelLines(state.goal, safeTerminalWidth()));
  }

  private renderLoopVerificationPanel(lines: string[]): void {
    this.renderLoopTranscriptPanel("Loop Verification", lines);
  }

  private renderLoopTranscriptPanel(title: string, lines: string[]): void {
    this.writeTranscript(withConversationGap(renderTranscriptBand(title, lines, safeTerminalWidth()).join("\n")));
  }

  private async updateGoalOwner(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    if (current.goal.status === "complete" || current.goal.status === "dropped") {
      this.renderNotice(`Cannot update owner for a ${current.goal.status} loop.`);
      this.renderGoalPanel(current);
      return;
    }
    const raw = args.trim();
    const owner = raw || (await this.ask("Loop owner", current.goal.owner)).trim();
    const next = setGoalOwner(current, owner === "clear" || owner === "none" || owner === "-" ? undefined : owner);
    this.renderGoalPanel(writeGoalState(this.app.store, session.session_id, next, randomId("goal_owner")));
  }

  private async updateGoalReviewOwner(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    if (current.goal.status === "complete" || current.goal.status === "dropped") {
      this.renderNotice(`Cannot update review owner for a ${current.goal.status} loop.`);
      this.renderGoalPanel(current);
      return;
    }
    const raw = args.trim();
    const owner = raw || (await this.ask("Loop review owner", current.goal.review_owner)).trim();
    const next = setGoalReviewOwner(current, owner === "clear" || owner === "none" || owner === "-" ? undefined : owner);
    this.renderGoalPanel(writeGoalState(this.app.store, session.session_id, next, randomId("goal_review_owner")));
  }

  private async verifyGoal(session: SessionRecord, current: GoalState | undefined, rubric: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGoalVerifierArgs>;
    try {
      parsed = parseGoalVerifierArgs(rubric.trim() ? rubric.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    if (parsed.background) {
      try {
        const queued = await queueGoalVerificationSuite({
          store: this.app.store,
          workspace: this.app.workspace,
          session_id: session.session_id,
          goal_state: current,
          roles: parsed.roles,
          rubric: parsed.rubric,
          source: "tui",
          isolation: parsed.isolation,
          config_path: this.app.configFiles[0],
        });
        this.renderLoopVerificationPanel([
          `${fg256(48, "•")} queued isolated verifier suite ${queued.suite_id.slice(0, 12)}`,
          `  roles ${queued.roles.join(", ")}`,
          `  isolation ${queued.isolation}`,
          ...queued.jobs.map((job) => `  ${job.role} · job ${job.job_id.slice(0, 12)} · session ${job.session_id.slice(0, 12)}${job.worktree_id ? ` · wt ${job.worktree_id.slice(0, 12)}` : ""}`),
        ]);
      } catch (error) {
        this.renderNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (parsed.roles.length > 1) {
      this.renderLoopVerificationPanel([
        `${fg256(75, "•")} running verification suite`,
        `  roles ${parsed.roles.join(", ")}`,
        fg256(244, "Each role records independent checker evidence and does not mutate the loop plan."),
      ]);
      try {
        const suite = await runGoalVerificationSuite({
          store: this.app.store,
          runtime: this.app.runtime,
          session_id: session.session_id,
          goal: current.goal,
          roles: parsed.roles,
          rubric: parsed.rubric,
          source: "tui",
        });
        this.renderLoopVerificationPanel([
          `${fg256(48, "•")} suite ${suite.suite_id.slice(0, 12)} · ${suite.results.length} roles`,
          ...suite.results.map((result) => {
            const verification = result.verification;
            const verdict = verification ? `${verification.verdict} · ${verification.confidence}` : "no record";
            return `  ${result.role} · ${result.run_id.slice(0, 12)} · ${verdict} · ${result.tool_calls} tool calls`;
          }),
        ]);
      } catch (error) {
        this.renderNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const runId = randomId("verify");
    this.app.store.appendEvent({
      session_id: session.session_id,
      run_id: runId,
      type: "goal.verification.requested",
      data: {
        goal_id: current.goal.id,
        horizon_generation: current.goal.horizon_generation,
        role: parsed.role,
        source: "tui",
      },
    });
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} running ${parsed.role} verification`,
      fg256(244, "This records evidence but does not complete or mutate the loop plan."),
    ]);
    const result = await this.app.runtime.run({
      prompt: buildGoalVerificationPrompt(current.goal, parsed),
      session_id: session.session_id,
      run_id: runId,
      client_id: randomId("verify"),
      request_class: "verification",
      visibility: "internal",
    });
    const view = readGoalLoopView(this.app.store, session.session_id);
    const latest = view.verifications.at(-1);
    this.renderLoopVerificationPanel([
      `${fg256(48, "•")} run ${result.run_id.slice(0, 12)} · ${parsed.role} · ${result.tool_calls} tool calls`,
      latest ? `  ${latest.provider} ${latest.verdict} · ${latest.confidence}${latest.verifier_role ? ` · ${latest.verifier_role}` : ""}` : "  no verification record",
      latest?.summary ? `  ${truncateToWidth(oneLine(latest.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
      latest?.failure_reason ? `  ${truncateToWidth(oneLine(latest.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
    ].filter((line): line is string => Boolean(line)));
  }

  private async verifyGoalGitHubPullRequest(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubPrVerifierArgs>;
    try {
      parsed = parseGitHubPrVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub PR checks`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-pr-checks", {
        session_id: session.session_id,
        params: { pr: parsed.pr, repo: parsed.repo },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub PR ${parsed.pr} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubPullRequestStatus(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubPrVerifierArgs>;
    try {
      parsed = parseGitHubPrVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub PR status`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-pr-status", {
        session_id: session.session_id,
        params: { pr: parsed.pr, repo: parsed.repo },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub PR status ${parsed.pr} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubReviewRequest(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubReviewRequestVerifierArgs>;
    try {
      parsed = parseGitHubReviewRequestVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub review request status`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-review-request", {
        session_id: session.session_id,
        params: { pr: parsed.pr, repo: parsed.repo, reviewer: parsed.reviewer },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub review request ${parsed.pr} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubIssueStatus(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubIssueVerifierArgs>;
    try {
      parsed = parseGitHubIssueVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub issue status`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-issue-status", {
        session_id: session.session_id,
        params: { issue: parsed.issue, repo: parsed.repo },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub issue status ${parsed.issue} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubNotification(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubNotificationVerifierArgs>;
    try {
      parsed = parseGitHubNotificationVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub notification thread`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-notification-status", {
        session_id: session.session_id,
        params: { thread: parsed.thread },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub notification ${parsed.thread} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubRun(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubRunVerifierArgs>;
    try {
      parsed = parseGitHubRunVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub Actions run`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-actions-run", {
        session_id: session.session_id,
        params: { run: parsed.run, repo: parsed.repo, attempt: parsed.attempt },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub run ${parsed.run} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubWorkflow(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubWorkflowVerifierArgs>;
    try {
      parsed = parseGitHubWorkflowVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading latest GitHub workflow run`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-workflow-run-status", {
        session_id: session.session_id,
        params: {
          workflow: parsed.workflow,
          repo: parsed.repo,
          branch: parsed.branch,
          event: parsed.event,
          commit: parsed.commit,
        },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub workflow ${parsed.workflow} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubDeployment(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubDeploymentVerifierArgs>;
    try {
      parsed = parseGitHubDeploymentVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub deployment status`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-deployment-status", {
        session_id: session.session_id,
        params: {
          repo: parsed.repo,
          deployment_id: parsed.deployment_id,
          environment: parsed.environment,
          ref: parsed.ref,
          expect: parsed.expect,
        },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub deployment ${parsed.deployment_id ?? parsed.environment ?? "target"} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitHubRelease(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseGitHubReleaseVerifierArgs>;
    try {
      parsed = parseGitHubReleaseVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading GitHub release`,
      fg256(244, "This records connector evidence but does not mutate GitHub or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "github-release-status", {
        session_id: session.session_id,
        params: { tag: parsed.tag, repo: parsed.repo, expect: parsed.expect },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} GitHub release ${parsed.tag} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalNpmPackage(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseNpmPackageVerifierArgs>;
    try {
      parsed = parseNpmPackageVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading npm package metadata`,
      fg256(244, "This records connector evidence but does not publish or mutate npm."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "npm-package-status", {
        session_id: session.session_id,
        params: {
          package_name: parsed.package_name,
          version: parsed.version,
          tag: parsed.tag,
          timeout_ms: parsed.timeout_ms,
        },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} npm ${parsed.package_name}@${parsed.version} · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalGitClean(session: SessionRecord, current: GoalState | undefined): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading local git status`,
      fg256(244, "This records connector evidence but does not mutate git or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "git-clean", {
        session_id: session.session_id,
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} Git clean · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async verifyGoalHttp(session: SessionRecord, current: GoalState | undefined, args: string): Promise<void> {
    if (!current) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set. Use /loop <objective> or /loop mode auto <objective> to start one."]);
      return;
    }
    let parsed: ReturnType<typeof parseHttpVerifierArgs>;
    try {
      parsed = parseHttpVerifierArgs(args.trim() ? args.trim().split(/\s+/) : []);
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderLoopVerificationPanel([
      `${fg256(75, "•")} reading HTTP health endpoint`,
      fg256(244, "This records connector evidence but does not mutate the endpoint or complete the loop."),
    ]);
    try {
      const verification = await runConnectorVerifier(this.app.store, this.app.workspace, "http-health", {
        session_id: session.session_id,
        params: { url: parsed.url, expected_status: parsed.status, timeout_ms: parsed.timeout_ms },
      });
      this.renderLoopVerificationPanel([
        `${fg256(48, "•")} HTTP health · ${verification.verdict} · ${verification.confidence}`,
        verification.summary ? `  ${truncateToWidth(oneLine(verification.summary), Math.max(24, terminalWidth() - 6))}` : undefined,
        verification.failure_reason ? `  ${truncateToWidth(oneLine(verification.failure_reason), Math.max(24, terminalWidth() - 6))}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async startGoal(session: SessionRecord, objective: string, options: GoalStartOptions = {}): Promise<void> {
    const state = writeGoalState(
      this.app.store,
      session.session_id,
      createGoalState({ objective, kind: options.kind, strategy: options.strategy, hil_policy: options.hil_policy, owner: options.owner, review_owner: options.review_owner }),
    );
    if (state.goal.kind === "research") {
      setAutoresearchMode(this.app.store, session.session_id, { mode: "on", goal: state.goal.objective });
    }
    this.renderGoalPanel(state);
    await this.enqueueGoalContinuation(state);
  }

  private async chooseGoalSetup(objective?: string): Promise<GoalStartOptions> {
    const kind = await this.chooseGoalSetupOption<GoalKindChoice>(
      "Loop Type",
      [
        { value: "task", label: "Task", description: "Implementation, investigation, or operational work." },
        { value: "research", label: "Research", description: "Metric-driven experiment with tracked evidence." },
      ],
      0,
      [],
      {
        objective,
        currentStep: "Type",
      },
    );
    const typeLabel = goalKindSetupLabel(kind);
    const approach = await this.chooseGoalSetupOption<GoalApproachChoice>(
      "Loop Approach",
      [
        { value: "auto", label: "Auto", description: "Orient first, then choose the right loop strategy." },
        { value: "focus", label: "Focus", description: "Finish this objective only." },
        { value: "explore", label: "Explore", description: "Explore related high-value directions." },
        { value: "timebox", label: "Timebox", description: "Work until a checkpoint, then review progress." },
      ],
      0,
      [],
      {
        objective,
        currentStep: "Approach",
        selections: { type: typeLabel },
      },
    );
    const targetHours = approach === "timebox"
      ? await this.chooseCampaignHours({
          objective,
          currentStep: "Approach",
          selections: { type: typeLabel, approach: goalApproachSetupLabel(approach) },
        })
      : undefined;
    const approachLabel = goalApproachSetupLabel(approach, targetHours);
    const reviewPolicy = await this.chooseGoalSetupOption<GoalReviewPolicyChoice>(
      "Human in the Loop",
      [
        { value: "auto", label: "Auto", description: "Continue after internal reflection." },
        { value: "review", label: "Review", description: "Pause before applying major loop decisions." },
      ],
      0,
      [],
      {
        objective,
        currentStep: "Human in the Loop",
        selections: { type: typeLabel, approach: approachLabel },
      },
    );
    const hilLabel = goalHilSetupLabel(reviewPolicy);
    await this.chooseGoalSetupOption<"start">(
      "Start Loop",
      [
        { value: "start", label: "Start", description: "Create the loop with this setup." },
      ],
      0,
      [],
      {
        objective,
        currentStep: "Review",
        selections: { type: typeLabel, approach: approachLabel, hil: hilLabel },
        hint: "enter start · esc cancels",
      },
    );
    return {
      kind,
      strategy: goalStrategyInputForApproach(approach, targetHours),
      hil_policy: reviewPolicy,
    };
  }

  private async chooseCampaignHours(wizard?: GoalSetupWizardContext): Promise<number | undefined> {
    const choice = await this.chooseGoalSetupOption<GoalCampaignHoursChoice>(
      "Timebox",
      [
        { value: "auto", label: "Auto", description: "Inferoa picks the checkpoint time." },
        { value: "30m", label: "30m", description: "0.5h quick run." },
        { value: "2h", label: "2h", description: "2h focused run." },
        { value: "4h", label: "4h", description: "4h long run." },
        { value: "custom", label: "Custom", description: "Enter a time like 1h or 90m." },
      ],
      0,
      [],
      wizard,
    );
    if (choice === "auto") {
      return undefined;
    }
    if (choice === "30m") {
      return 0.5;
    }
    if (choice === "2h") {
      return 2;
    }
    if (choice === "4h") {
      return 4;
    }
    let error: string | undefined;
    for (;;) {
      const raw = (await this.askGoalSetupValue("Custom Timebox", "4h", ["Use a positive time like 2h or 90m."], error)).trim();
      const value = parseGoalCampaignHours(raw);
      if (value !== undefined) {
        return value;
      }
      error = "Use a positive time like 2h or 90m.";
    }
  }

  private async chooseGoalSetupOption<T extends string>(
    title: string,
    options: SelectOption<T>[],
    defaultIndex = 0,
    footer: string[] = [],
    wizard?: GoalSetupWizardContext,
  ): Promise<T> {
    if (!options.length) {
      throw new Error(`${title} has no options`);
    }
    let state: GoalSetupChoiceState = {
      selectedIndex: Math.max(0, Math.min(defaultIndex, options.length - 1)),
    };
    const previousInputModalActive = this.#inputModalActive;
    this.#inputModalActive = true;
    this.#rl?.pause();
    const render = () => {
      this.renderGoalSetupChoicePrompt(renderGoalSetupChoicePanel(title, options, state.selectedIndex, footer, setupDialogContentWidth(), wizard));
      stdout.write(ansi.hideCursor);
    };
    render();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.clearCenteredPrompt();
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdout.write(ansi.showCursor);
        this.#inputModalActive = previousInputModalActive;
        this.resumeReadline();
      };
      const finish = (value: T) => {
        cleanup();
        resolve(value);
      };
      const cancel = () => {
        cleanup();
        reject(new Error(`${title} selection cancelled`));
      };
      const onData = (chunk: Buffer) => {
        for (const key of terminalInputTokens(chunk.toString("utf8"))) {
          const result = applyGoalSetupChoiceToken(state, options, key);
          state = result.state;
          if (result.cancelled) {
            cancel();
            return;
          }
          if (result.value !== undefined) {
            finish(result.value);
            return;
          }
        }
        render();
      };
      const onResize = () => {
        render();
      };
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  private renderGoalSetupChoicePrompt(body: string[]): void {
    if (this.#inlineMode) {
      this.renderInlinePanel("Goal Setup", body);
      return;
    }
    this.renderCenteredPanel("Goal Setup", body, true);
  }

  private async askGoalSetupValue(title: string, defaultValue: string, detail: string[], error?: string): Promise<string> {
    const previousPanel = this.#composerPanel;
    this.#composerPanel = {
      lines: renderGoalSetupValuePanel(title, detail, error, safeTerminalWidth()),
    };
    try {
      return await this.readComposer({
        placeholder: title,
        initialBuffer: defaultValue,
        suggestions: false,
        cancelOnInterrupt: true,
      });
    } finally {
      this.#composerPanel = previousPanel;
    }
  }

  private async enqueueGoalContinuation(stateOrObjective: GoalState | string): Promise<void> {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Loop is saved. Configure a model with /setup before triggering model work.");
      return;
    }
    const session = this.optionalSession();
    if (!session) {
      return;
    }
    const goal = typeof stateOrObjective === "string" ? stateOrObjective : stateOrObjective.goal;
    this.enqueuePrompt(buildGoalWorkPrompt(goal), { renderPrompt: false });
  }

  private enqueueGoalPlanningContinuation(objective: string): void {
    if (!this.app.config.model_setup.base_url || !this.app.config.model_setup.model) {
      this.renderNotice("Loop is saved. Configure a model with /setup before triggering model planning.");
      return;
    }
    this.enqueuePrompt(
      [
        `Goal objective: ${objective}`,
        "Review the current loop state. Decompose or update the internal loop plan with the goal tool, including active step, blockers, and verification steps.",
      ].join("\n"),
      { renderPrompt: false },
    );
  }

  private renderGoalPanel(state: GoalState | undefined): void {
    if (!state) {
      this.renderLoopTranscriptPanel("Loop", ["No loop set."]);
      return;
    }
    const goal = state.goal;
    const width = goalPanelContentWidth();
    const status = goalPanelStatusLabel(state);
    const session = this.optionalSession();
    const loopView = session ? readGoalLoopView(this.app.store, session.session_id) : undefined;
    const reflections = loopView?.reflections ?? [];
    const attempts = loopView?.attempts ?? [];
    const lines = renderGoalPanelStatus(status, goal.objective, width);
    const usage = goalPanelUsage(goal);
    appendGoalPanelField(lines, "type", goal.kind, width, 244);
    if (goal.owner) {
      appendGoalPanelField(lines, "owner", goal.owner, width, 244);
    }
    if (goal.review_owner) {
      appendGoalPanelField(lines, "review owner", goal.review_owner, width, 244);
    }
    if (usage) {
      lines.push(fg256(244, usage));
    }
    if (attempts.length) {
      appendGoalPanelField(lines, "attempts", goalPanelAttemptsSummary(attempts), width, 244);
    }
    appendGoalPanelField(lines, "approach", goalPanelStrategy(goal), width, 244);
    appendGoalPanelField(lines, "review", goalPanelReviewSummary(goal), width, goal.pending_review_decision ? 250 : 244, goal.pending_review_decision ? 203 : 39);
    appendGoalPanelField(lines, "candidates", goalPanelCandidates(goal), width, 244);
    if (goal.summary) {
      appendGoalPanelField(lines, "summary", goal.summary, width);
    }
    const verification = loopView?.verifications.at(-1);
    if (verification) {
      appendGoalPanelField(lines, "verification", goalPanelVerificationSummary(verification), width, 244);
    }
    const skillSnapshot = loopView?.skill_snapshots.at(-1);
    if (skillSnapshot) {
      appendGoalPanelField(lines, "skills", goalPanelSkillSnapshotSummary(skillSnapshot), width, 244);
    }
    if (reflections.length) {
      appendGoalPanelField(lines, "decisions", goalPanelReflectionsSummary(reflections), width, 244);
    } else if (goal.last_reflection_decision) {
      appendGoalPanelField(
        lines,
        "decision",
        `${goal.last_reflection_decision}${goal.last_reflection_summary ? ` · ${goal.last_reflection_summary}` : ""}`,
        width,
      );
    }
    if (goal.blocker) {
      appendGoalPanelField(lines, "blocker", goal.blocker, width, 203, 203);
    }
    if (goal.pending_review_decision?.steps?.length) {
      appendGoalPanelField(lines, "proposed", goalPanelProposedStepsSummary(goal), width, 250, 203);
    }
    if (goal.pending_review_decision) {
      appendGoalPanelField(lines, "next", "review prompt · Approve · Adjust · Continue · Block", width, 244, 203);
    }
    if (goal.planning) {
      lines.push(`${fg256(39, "task plan")} ${goalPlanningProgressSummary(goal.planning)}`);
      const active = goal.planning.active_step_id ? goal.planning.steps.find((step) => step.id === goal.planning?.active_step_id) : undefined;
      if (active) {
        appendGoalPanelField(lines, "active step", `${goalStepPlainStatusMarker(active.status)} ${active.id} ${active.title}`, width);
      }
      const horizons = loopView?.horizons ?? [];
      if (horizons.length) {
        lines.push("", ...renderGoalPanelHorizons(horizons, width, reflections));
      }
    } else {
      lines.push(fg256(244, "No loop task plan yet."));
    }
    this.renderLoopTranscriptPanel("Loop", lines);
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

  private redrawVisibleSessionSurface(): void {
    this.#inlineRenderedLines = 0;
    this.#inlinePanelStartRow = undefined;
    this.#inlineRenderedContent = undefined;
    stdout.write(ansi.clear);
    const session = this.optionalSession();
    if (!session) {
      this.#hasTranscript = false;
      this.writeHomeFrame();
      return;
    }
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
    this.#inlineRenderedContent = undefined;
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

  private async renderInboxView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const parsed = parseInboxViewArgs(tokens);
    const command = (parsed.args[0] ?? "show").toLowerCase();
    if (command === "resolve" || command === "dismiss" || command === "reopen") {
      await this.applyInboxAction(command as LoopInboxAction, parsed.args.slice(1));
      return;
    }
    if (command === "snooze") {
      await this.applyInboxAction("snooze", parsed.args.slice(1));
      return;
    }
    if (command === "promote") {
      await this.promoteInboxItem(parsed.args.slice(1));
      return;
    }
    if (command === "assign" || command === "unassign") {
      await this.assignInboxItem(command, parsed.args.slice(1));
      return;
    }
    if (command === "routes" || command === "route") {
      await this.routeInboxItems(command, parsed.args.slice(1));
      return;
    }
    if (command === "mute" || command === "unmute") {
      await this.muteInboxItem(command, parsed.args.slice(1));
      return;
    }
    const inbox = await readLoopInbox(this.app.store, this.app.workspace, {
      includeDone: parsed.includeDone,
      includeSnoozed: parsed.includeDone,
      includeMuted: parsed.includeMuted,
      assignee: parsed.assignee,
      onlyUnassigned: parsed.onlyUnassigned,
    });
    const counts = Object.entries(inbox.summary.by_kind)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${kind}:${count}`)
      .join("  ");
    this.renderLoopTranscriptPanel("Loop Inbox", [
      `${fg256(39, "Open")} ${inbox.summary.open}  ${fg256(203, "High")} ${inbox.summary.high}  ${fg256(75, "Assigned")} ${inbox.summary.assigned}  ${fg256(244, "Muted")} ${inbox.summary.muted}  ${fg256(244, "Total")} ${inbox.summary.total}`,
      inboxFilterLabel(parsed) ?? (counts ? fg256(244, counts) : fg256(244, "No loop inbox items.")),
      "",
      ...(inbox.items.length ? inbox.items.slice(0, 40).flatMap((item, index) => renderInboxItemLines(item, index + 1)) : ["  no items"]),
      ...(inbox.items.length > 40 ? [fg256(244, `  ... ${inbox.items.length - 40} more`)] : []),
    ]);
  }

  private async applyInboxAction(action: LoopInboxAction, args: string[]): Promise<void> {
    const itemId = args[0];
    if (!itemId) {
      this.renderNotice(`Usage: /inbox ${action} <item_id>${action === "snooze" ? " <30m|2h|1d|iso>" : ""}`);
      return;
    }
    try {
      const result = await updateLoopInboxItemState(this.app.store, this.app.workspace, {
        action,
        item_id: itemId,
        snoozed_until: action === "snooze" ? parseLoopInboxSnoozeUntil(args[1] ?? "") : undefined,
        note: args.slice(action === "snooze" ? 2 : 1).join(" "),
      });
      this.renderLoopTranscriptPanel("Loop Inbox", [
        `${fg256(48, "•")} ${action} ${result.item.id}`,
        result.state?.disposition ? `  disposition ${result.state.disposition}` : "  reopened",
        result.state?.snoozed_until ? `  until ${result.state.snoozed_until}` : undefined,
        result.state?.note ? `  note ${result.state.note}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async promoteInboxItem(args: string[]): Promise<void> {
    const parsed = parseInboxPromoteFlags(args);
    const itemId = parsed.item_id;
    if (!itemId) {
      this.renderNotice("Usage: /inbox promote [--worktree] <item_id>");
      return;
    }
    try {
      const result = await promoteLoopInboxItem(this.app.store, this.app.workspace, itemId, {
        config_path: this.app.configFiles[0],
        isolation: resolveLoopBackgroundIsolation(parsed.isolation, this.app.config),
      });
      this.renderLoopTranscriptPanel("Loop Inbox", [
        `${fg256(48, "•")} promoted ${result.item.id}`,
        `  job ${result.job.job_id.slice(0, 12)} · ${result.job.kind} · ${result.job.status}`,
        result.worktree ? `  worktree ${result.worktree.worktree_id.slice(0, 12)} · ${result.worktree.branch}` : undefined,
        `  ${truncateToWidth(oneLine(result.job.prompt), Math.max(24, terminalWidth() - 6))}`,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async assignInboxItem(command: string, args: string[]): Promise<void> {
    const itemId = args[0];
    if (!itemId || (command === "assign" && !args[1])) {
      this.renderNotice(`Usage: /inbox ${command === "assign" ? "assign <item_id> <owner> [note]" : "unassign <item_id>"}`);
      return;
    }
    try {
      const result = await updateLoopInboxAssignment(this.app.store, this.app.workspace, {
        item_id: itemId,
        assignee: command === "assign" ? args[1] : undefined,
        note: command === "assign" ? args.slice(2).join(" ") : undefined,
      });
      this.renderLoopTranscriptPanel("Loop Inbox", [
        `${fg256(48, "•")} ${result.action} ${result.item.id}`,
        result.state?.assignee ? `  owner ${result.state.assignee}` : "  owner cleared",
        result.state?.assignment_note ? `  note ${result.state.assignment_note}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async routeInboxItems(command: string, args: string[]): Promise<void> {
    const subcommand = command === "routes" ? "list" : (args[0] ?? "list").toLowerCase();
    try {
      if (subcommand === "list" || subcommand === "show") {
        const routes = await readLoopInboxRouting(this.app.workspace);
        this.renderLoopTranscriptPanel("Loop Inbox Routes", routes.length
          ? routes.map((route) => `  ${route.route_id} -> ${route.assignee}${routeSelectorLabel(route)}${route.note ? ` · ${route.note}` : ""}`)
          : ["  no routes"]);
        return;
      }
      if (subcommand === "add") {
        const route = parseInboxRouteAddFlags(args.slice(1));
        const result = await updateLoopInboxRouting(this.app.workspace, { action: "add", ...route });
        this.renderLoopTranscriptPanel("Loop Inbox Routes", [
          `${fg256(48, "•")} route ${result.route?.route_id ?? "added"}`,
          result.route ? `  owner ${result.route.assignee}${routeSelectorLabel(result.route)}` : undefined,
          result.route?.note ? `  note ${result.route.note}` : undefined,
        ].filter((line): line is string => Boolean(line)));
        return;
      }
      if (subcommand === "remove" || subcommand === "delete") {
        const routeId = args[1];
        if (!routeId) {
          this.renderNotice("Usage: /inbox route remove <route_id>");
          return;
        }
        const result = await updateLoopInboxRouting(this.app.workspace, { action: "remove", route_id: routeId });
        this.renderLoopTranscriptPanel("Loop Inbox Routes", [
          `${fg256(48, "•")} removed ${result.route?.route_id ?? routeId}`,
          `  remaining ${result.routes.length}`,
        ]);
        return;
      }
      this.renderNotice("Usage: /inbox routes | /inbox route add <owner> --kind <kind>|--source <source>|--priority <priority> [--id route_id] [note] | /inbox route remove <route_id>");
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async muteInboxItem(command: string, args: string[]): Promise<void> {
    const itemId = args[0];
    if (!itemId) {
      this.renderNotice(`Usage: /inbox ${command === "mute" ? "mute <item_id> [note]" : "unmute <item_id|mute_key>"}`);
      return;
    }
    try {
      const result = await updateLoopInboxMute(this.app.store, this.app.workspace, {
        action: command === "mute" ? "mute" : "unmute",
        item_id: itemId,
        note: command === "mute" ? args.slice(1).join(" ") : undefined,
      });
      this.renderLoopTranscriptPanel("Loop Inbox", [
        `${fg256(48, "•")} ${result.action} ${result.mute_key}`,
        result.state?.muted_until ? `  until ${result.state.muted_until}` : undefined,
        result.state?.note ? `  note ${result.state.note}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async renderSelfImproveView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "status").toLowerCase();
    try {
      if (action === "help") {
        this.renderLoopTranscriptPanel("Self-Improve", selfImproveHelpLines());
        return;
      }
      if (action === "status" || action === "show") {
        const status = await optLiteStatus(this.app.store, this.app.workspace);
        this.renderLoopTranscriptPanel("Self-Improve", selfImproveStatusLines(status));
        return;
      }
      if (action === "propose") {
        const proposal = await optLitePropose(this.app.store, this.app.workspace);
        this.renderLoopTranscriptPanel("Self-Improve Proposal", [
          `${fg256(48, "•")} staged ${proposal.id}`,
          `  skill ${proposal.skill_id}`,
          `  evidence sessions ${proposal.evidence.goal_sessions} · verifications ${proposal.evidence.verification_records} · signals ${proposal.evidence.learning_signal_records}`,
          `  ${proposal.staged_skill_path}`,
          "",
          `${fg256(39, "Next")} /self-improve run --replay ${proposal.id}`,
        ]);
        return;
      }
      if (action === "replay") {
        const run = await optLiteRun(this.app.store, this.app.workspace, { replay: true, proposal_id: tokens[1] });
        this.renderOptReplayPanel(run.replay);
        return;
      }
      if (action === "run") {
        const options = parseOptRunFlags(tokens.slice(1));
        if (!options.replay) {
          this.renderLoopTranscriptPanel("Self-Improve", [
            fg256(203, "Usage: /self-improve run --replay [proposal_id]"),
            "",
            ...selfImproveCommandLines(),
          ]);
          return;
        }
        const run = await optLiteRun(this.app.store, this.app.workspace, options);
        this.renderOptReplayPanel(run.replay);
        return;
      }
      if (action === "report") {
        const report = await optLiteReport(this.app.workspace, tokens[1]);
        this.renderOptReplayPanel(report);
        return;
      }
      if (action === "adopt") {
        const proposal = await optLiteAdopt(this.app.store, this.app.workspace, this.app.config, tokens[1]);
        this.renderLoopTranscriptPanel("Self-Improve Adopted", [
          `${fg256(48, "•")} adopted ${proposal.id}`,
          `  skill ${proposal.skill_id}`,
          proposal.skill_path ? `  ${proposal.skill_path}` : undefined,
          "",
          `${fg256(39, "Next")} future loop sessions can use ${proposal.skill_id}`,
        ].filter((line): line is string => Boolean(line)));
        return;
      }
      this.renderLoopTranscriptPanel("Self-Improve", [
        fg256(203, `Unknown self-improve command: ${action}`),
        "",
        ...selfImproveCommandLines(),
      ]);
    } catch (error) {
      this.renderLoopTranscriptPanel("Self-Improve", [
        fg256(203, error instanceof Error ? error.message : String(error)),
        "",
        ...selfImproveCommandLines(),
      ]);
    }
  }

  private renderOptReplayPanel(report: Awaited<ReturnType<typeof optLiteReport>>): void {
    this.renderLoopTranscriptPanel("Self-Improve Replay", [
      `${fg256(39, "Report")} ${report.id} · ${report.status} · proposal ${report.proposal_id}`,
      `${fg256(39, "Samples")} total ${report.sample_count} · train ${report.splits.train.length} · validation ${report.splits.validation.length} · heldout ${report.splits.heldout.length}`,
      `${fg256(39, "Scores")} baseline ${formatOptScore(report.baseline_score)} · candidate ${formatOptScore(report.candidate_score)}`,
      `${fg256(39, "Gate")} validation ${report.gate.validation_improved ? "improved" : "not improved"} · heldout ${report.gate.heldout_not_regressed ? "not regressed" : "regressed"} · hard failures ${report.gate.hard_failures}`,
      `${fg256(39, "Path")} ${report.report_path}`,
      "",
      report.status === "accepted"
        ? `${fg256(39, "Next")} /self-improve adopt ${report.proposal_id}`
        : `${fg256(39, "Next")} inspect this report, collect stronger verified loop evidence, then /self-improve propose`,
    ]);
  }

  private async renderLoopView(args = ""): Promise<void> {
    const first = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
    const internalActions = new Set([
      "health",
      "dashboard",
      "overview",
      "trace",
      "evidence",
      "metrics",
      "tasks",
      "task",
      "workers",
      "worker",
      "connectors",
      "connector",
      "policy",
      "action-preflight",
      "action",
      "action-run",
      "action-execute",
      "actions",
      "action-log",
      "roadmap",
      "coverage",
    ]);
    if (internalActions.has(first)) {
      await this.renderLoopInternalView(args);
      return;
    }
    await this.renderLoopControlView(args);
  }

  private async renderLoopInternalView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "health").toLowerCase();
    if (action === "health") {
      await this.renderLoopHealthView();
      return;
    }
    if (action === "dashboard" || action === "overview") {
      await this.renderLoopDashboardView();
      return;
    }
    if (action === "trace") {
      this.renderLoopTraceView(tokens.slice(1));
      return;
    }
    if (action === "evidence") {
      this.renderLoopEvidenceView(tokens.slice(1));
      return;
    }
    if (action === "metrics") {
      this.renderLoopMetricsView();
      return;
    }
    if (action === "tasks" || action === "task") {
      this.renderLoopTasksView();
      return;
    }
    if (action === "workers" || action === "worker") {
      this.renderLoopWorkersView();
      return;
    }
    if (action === "connectors" || action === "connector") {
      this.renderLoopConnectorsView();
      return;
    }
    if (action === "policy") {
      await this.renderLoopPolicyView();
      return;
    }
    if (action === "action-preflight" || action === "action") {
      this.renderLoopActionPreflightView(tokens.slice(1));
      return;
    }
    if (action === "action-run" || action === "action-execute") {
      await this.renderLoopActionRunView(tokens.slice(1));
      return;
    }
    if (action === "actions" || action === "action-log") {
      this.renderLoopActionsView();
      return;
    }
    if (action === "roadmap" || action === "coverage") {
      this.renderLoopRoadmapView();
      return;
    }
    this.renderNotice(`Unknown loop action ${args}. Use /loop health.`);
  }

  private async renderLoopDashboardView(): Promise<void> {
    const dashboard = await readLoopDashboard(this.app.store, this.app.workspace);
    const topGoal = dashboard.top.goal;
    const topSource = dashboard.top.source;
    const topConnector = dashboard.top.connector;
    this.renderPanel("Loop Internal Dashboard", [
      `${fg256(39, "Severity")} ${dashboard.status.severity}${dashboard.status.reasons.length ? ` · ${dashboard.status.reasons.join(", ")}` : ""}`,
      `${fg256(39, "Inbox")} open ${dashboard.status.open_inbox_items} · high ${dashboard.status.high_inbox_items} · background ${dashboard.status.active_jobs} · reviews ${dashboard.status.pending_reviews}`,
      `${fg256(39, "Totals")} sessions ${dashboard.totals.sessions} · loops ${dashboard.totals.goals} · runs ${dashboard.totals.runs} · calls ${dashboard.totals.model_calls} · tok ${formatCompactNumber(dashboard.totals.total_tokens)}`,
      `${fg256(39, "Verification")} pass ${dashboard.verification.pass} · fail ${dashboard.verification.fail} · partial ${dashboard.verification.partial} · blocked ${dashboard.verification.blocked} · rate ${formatOptionalPercent(dashboard.verification.pass_rate)}`,
      `${fg256(39, "Ops")} automation due ${dashboard.operations.automation_due} · discovery due ${dashboard.operations.discovery_due} · discovery errors ${dashboard.operations.discovery_errors} · worktrees ${dashboard.operations.worktrees_active}`,
      `${fg256(39, "Top loop")} ${topGoal ? `${truncateToWidth(oneLine(topGoal.label ?? topGoal.key), 48)} · ${formatCompactNumber(topGoal.tokens)} tok · verify ${topGoal.verifications}` : "none"}`,
      `${fg256(39, "Top source")} ${topSource ? `${topSource.key} · ${formatCompactNumber(topSource.tokens)} tok · verify ${topSource.verifications}` : "none"}`,
      `${fg256(39, "Top connector")} ${topConnector ? `${topConnector.key} · ${formatCompactNumber(topConnector.tokens)} tok · verify ${topConnector.verifications}` : "none"}`,
      "",
      fg256(39, "Attention"),
      ...(dashboard.attention.inbox_items.length
        ? dashboard.attention.inbox_items.slice(0, 5).map((item) => `  ${item.priority} · ${item.kind} · ${truncateToWidth(oneLine(item.title), 68)}`)
        : ["  none"]),
      "",
      fg256(39, "Roadmap edges"),
      ...(dashboard.attention.roadmap_edges.length
        ? dashboard.attention.roadmap_edges.slice(0, 5).map((item) => `  ${item.name} · ${item.status}`)
        : ["  none"]),
    ]);
  }

  private async renderLoopHealthView(): Promise<void> {
    const health = await readLoopHealth(this.app.store, this.app.workspace);
    this.renderLoopTranscriptPanel("Loop Health", [
      `${fg256(39, "Severity")} ${health.severity}`,
      health.reasons.length ? `${fg256(39, "Reasons")} ${health.reasons.join(", ")}` : `${fg256(39, "Reasons")} none`,
      "",
      `${fg256(39, "Inbox")} open ${health.inbox.open} · high ${health.inbox.high} · total ${health.inbox.total}`,
      `${fg256(39, "Background")} active ${health.jobs.active} · failed ${health.jobs.by_status.failed ?? 0} · blocked ${health.jobs.by_status.blocked ?? 0} · total ${health.jobs.total}`,
      `${fg256(39, "Loops")} active ${health.goals.by_status.active ?? 0} · paused ${health.goals.by_status.paused ?? 0} · review ${health.goals.pending_review} · total ${health.goals.total}`,
      `${fg256(39, "Automation")} enabled ${health.automation.by_status.enabled ?? 0} · due ${health.automation.due} · review ${health.automation.review_pending} · worktree ${health.automation.worktree_isolated} · total ${health.automation.total}`,
      `${fg256(39, "Discovery")} open ${health.discovery.candidates_open} · due ${health.discovery.due} · errors ${health.discovery.last_error} · total ${health.discovery.total}`,
      `${fg256(39, "Worktrees")} active ${health.worktrees.active} · attention ${health.worktrees.attention} · cleanup ${health.worktrees.cleanup_due} · total ${health.worktrees.total}`,
      `${fg256(39, "Verification")} pass ${health.verification.by_verdict.pass ?? 0} · fail ${health.verification.by_verdict.fail ?? 0} · hard pass ${health.verification.hard_pass} · total ${health.verification.total}`,
      `${fg256(39, "Learning")} positive ${health.learning_signals.by_polarity.positive ?? 0} · negative ${health.learning_signals.by_polarity.negative ?? 0} · constraints ${health.learning_signals.by_polarity.constraint ?? 0} · total ${health.learning_signals.total}`,
    ]);
  }

  private renderLoopTraceView(args: string[]): void {
    const session = args[0]
      ? this.app.store.getSession(args[0]) ?? this.app.store.findSessionByPrefix(this.app.workspace.id, args[0])
      : this.optionalSession();
    if (!session) {
      this.renderNotice("Usage: /loop trace [session]");
      return;
    }
    const trace = readLoopTrace(this.app.store, session, { limit: 8 });
    this.renderPanel("Run Trace", [
      `${fg256(39, "Session")} ${session.session_id.slice(0, 12)} · ${truncateToWidth(oneLine(session.title), 56)}`,
      `${fg256(39, "Summary")} runs ${trace.summary.runs} · steps ${trace.summary.steps} · tools ${trace.summary.tool_calls} · verifications ${trace.summary.verifications}`,
      "",
      ...(trace.runs.length
        ? trace.runs.map((run) => {
          const goal = run.goal_events.length ? ` · goal ${run.goal_events.length}` : "";
          const verify = run.verification_count ? ` · verify ${run.verification_count}` : "";
          const status = run.status.padEnd(9);
          return `  ${status} ${run.run_id.slice(0, 12)} · ${run.request_class ?? "unknown"} · steps ${run.steps.length} · tools ${run.tool_calls ?? run.tools.length}${verify}${goal}`;
        })
        : ["  no runs"]),
    ]);
  }

  private renderLoopEvidenceView(args: string[]): void {
    const session = args[0]
      ? this.app.store.getSession(args[0]) ?? this.app.store.findSessionByPrefix(this.app.workspace.id, args[0])
      : this.optionalSession();
    if (!session) {
      this.renderNotice("Usage: /loop evidence [session]");
      return;
    }
    const evidence = readLoopEvidence(this.app.store, session);
    const latestVerification = evidence.verification.latest;
    const latestSignal = evidence.learning_signals.latest[0];
    const latestSkills = evidence.skills.latest;
    this.renderPanel("Loop Evidence", [
      `${fg256(39, "Session")} ${session.session_id.slice(0, 12)} · ${truncateToWidth(oneLine(session.title), 56)}`,
      evidence.goal
        ? `${fg256(39, "Loop")} ${evidence.goal.kind} · ${evidence.goal.status} · loop task ${evidence.goal.horizon_generation} · HIL ${evidence.goal.hil_policy}`
        : `${fg256(39, "Loop")} none`,
      evidence.current_horizon
        ? `${fg256(39, "Loop task")} ${evidence.current_horizon.generation} · steps ${evidence.current_horizon.step_count} · done ${evidence.current_horizon.steps_by_status.completed} · blocked ${evidence.current_horizon.steps_by_status.blocked}`
        : `${fg256(39, "Loop task")} none`,
      `${fg256(39, "Attempts")} total ${evidence.summary.attempts} · completed ${evidence.summary.completed_attempts} · failed ${evidence.summary.failed_attempts}`,
      `${fg256(39, "Verification")} total ${evidence.summary.verifications} · hard pass ${evidence.summary.hard_pass_verifications} · fail ${evidence.summary.failed_verifications} · blocked ${evidence.summary.blocked_verifications}`,
      `${fg256(39, "Memory")} skills ${evidence.summary.skill_snapshots} · learning ${evidence.summary.learning_signals} · review ${evidence.summary.pending_review ? "pending" : "clear"}`,
      latestVerification ? `${fg256(39, "Latest verification")} ${latestVerification.provider}/${latestVerification.verdict}/${latestVerification.confidence}${latestVerification.summary ? ` · ${truncateToWidth(oneLine(latestVerification.summary), 64)}` : ""}` : `${fg256(39, "Latest verification")} none`,
      latestSignal ? `${fg256(39, "Latest signal")} ${latestSignal.category}/${latestSignal.polarity} · ${truncateToWidth(oneLine(latestSignal.summary), 64)}` : `${fg256(39, "Latest signal")} none`,
      latestSkills ? `${fg256(39, "Latest skills")} ${latestSkills.skill_count} · ${latestSkills.skill_ids.slice(0, 5).join(", ") || "none"}` : `${fg256(39, "Latest skills")} none`,
    ]);
  }

  private renderLoopMetricsView(): void {
    const metrics = readLoopMetrics(this.app.store, this.app.workspace);
    const topSource = metrics.by_source[0];
    const topWorktree = metrics.by_worktree[0];
    const topGoal = metrics.by_goal.find((item) => item.key !== "no_goal") ?? metrics.by_goal[0];
    this.renderPanel("Loop Internal Metrics", [
      `${fg256(39, "Totals")} sessions ${metrics.totals.sessions} · runs ${metrics.totals.runs} · loops ${metrics.totals.goals} · calls ${metrics.totals.model_calls}`,
      `${fg256(39, "Tokens")} total ${formatCompactNumber(metrics.tokens.total_tokens)} · prompt ${formatCompactNumber(metrics.tokens.prompt_tokens)} · completion ${formatCompactNumber(metrics.tokens.completion_tokens)} · cached ${formatCompactNumber(metrics.tokens.cached_prompt_tokens)}${metrics.tokens.cache_hit_rate !== undefined ? ` · cache ${formatPercent(metrics.tokens.cache_hit_rate)}` : ""}`,
      `${fg256(39, "Verification")} pass ${metrics.verification.summary.pass} · fail ${metrics.verification.summary.fail} · partial ${metrics.verification.summary.partial} · blocked ${metrics.verification.summary.blocked} · rate ${formatOptionalPercent(metrics.verification.summary.pass_rate)}`,
      `${fg256(39, "Checker")} total ${metrics.verification.checker_effectiveness.total} · pass ${metrics.verification.checker_effectiveness.pass} · fail ${metrics.verification.checker_effectiveness.fail} · rate ${formatOptionalPercent(metrics.verification.checker_effectiveness.pass_rate)}`,
      `${fg256(39, "Learning")} positive ${metrics.learning_signals.positive} · negative ${metrics.learning_signals.negative} · constraints ${metrics.learning_signals.constraint} · total ${metrics.learning_signals.total}`,
      `${fg256(39, "Top loop")} ${topGoal ? `${truncateToWidth(oneLine(topGoal.label ?? topGoal.key), 48)} · ${formatCompactNumber(topGoal.tokens.total_tokens)} tok · verify ${topGoal.verification.total}` : "none"}`,
      `${fg256(39, "Top source")} ${topSource ? `${topSource.key} · ${formatCompactNumber(topSource.tokens.total_tokens)} tok · verify ${topSource.verification.total}` : "none"}`,
      `${fg256(39, "Top worktree")} ${topWorktree ? `${topWorktree.key} · ${formatCompactNumber(topWorktree.tokens.total_tokens)} tok · verify ${topWorktree.verification.total}` : "none"}`,
      `${fg256(39, "Trend days")} ${metrics.trends.daily.length}`,
    ]);
  }

  private renderLoopTasksView(): void {
    const report = readLoopTasks(this.app.store, this.app.workspace);
    this.renderPanel("Loop Tasks", [
      `${fg256(39, "Summary")} total ${report.summary.total} · current ${report.summary.current} · task ${report.summary.by_kind.task} · research ${report.summary.by_kind.research}`,
      `${fg256(39, "Attention")} review ${report.summary.pending_review} · blocked ${report.summary.blocked} · failed ${report.summary.verification_failed} · ready ${report.summary.ready_for_verification} · verified ${report.summary.verified}`,
      "",
      ...(report.tasks.length
        ? report.tasks.slice(0, 14).map((task) => {
          const current = task.current ? "current" : `task ${task.horizon_generation}`;
          const verify = task.verification.latest ? ` · ${task.verification.latest.verdict}/${task.verification.latest.confidence}` : "";
          const attempts = task.attempts.total ? ` · attempts ${task.attempts.total}` : "";
          const owner = task.owner ? ` · ${task.owner}` : "";
          return `  ${task.state.padEnd(22)} ${task.goal_kind} · ${current} · steps ${task.steps.total} · verify ${task.verification.total}${verify}${attempts}${owner} · ${truncateToWidth(oneLine(task.goal_objective), 48)}`;
        })
        : ["  no loop tasks"]),
    ]);
  }

  private renderLoopWorkersView(): void {
    const report = readLoopWorkers(this.app.store, this.app.workspace);
    this.renderPanel("Loop Internal Jobs", [
      `${fg256(39, "Summary")} total ${report.summary.total} · active ${report.summary.active} · verifiers ${report.summary.verifiers} · sub-agents ${report.summary.subagents}`,
      `${fg256(39, "Status")} ${compactRecordCounts(report.summary.by_status)}`,
      `${fg256(39, "Roles")} ${compactRecordCounts(report.summary.by_role)}`,
      "",
      ...(report.workers.length
        ? report.workers.slice(0, 12).map((worker) => {
          const role = worker.role ? ` · ${worker.role}` : "";
          const parent = worker.parent_session_id ? ` · parent ${worker.parent_session_id.slice(0, 12)}` : "";
          const worktree = worker.worktree_id ? ` · wt ${worker.worktree_id.slice(0, 12)}` : "";
          const verify = worker.verification ? ` · ${worker.verification.verdict}/${worker.verification.confidence}` : "";
          return `  ${worker.status.padEnd(14)} ${worker.kind}${role} · job ${worker.job_id.slice(0, 12)} · session ${worker.session_id.slice(0, 12)}${parent}${worktree}${verify}`;
        })
        : ["  no internal jobs"]),
    ]);
  }

  private renderLoopConnectorsView(): void {
    const report = readLoopConnectors(this.app.store, this.app.workspace);
    this.renderPanel("Loop Internal Connectors", [
      `${fg256(39, "Summary")} connectors ${report.summary.connectors} · configured ${report.summary.configured_connectors} · sources ${report.summary.discovery_sources}`,
      `${fg256(39, "Discovery")} schedules ${report.summary.schedules} · enabled ${report.summary.enabled_schedules} · due ${report.summary.due_schedules} · open ${report.summary.open_candidates}`,
      `${fg256(39, "Verification")} verifiers ${report.summary.verifiers}`,
      `${fg256(39, "Action policy")} connector ${report.summary.action_policies} · runners ${report.summary.action_runners} · global ${report.summary.global_action_policies}`,
      "",
      ...(report.connectors.length
        ? report.connectors.map((connector) => {
          const configured = connector.status === "configured" ? "configured" : "available";
          const hot = connector.summary.high_open_candidates ? ` · high ${connector.summary.high_open_candidates}` : "";
          return `  ${connector.connector.padEnd(8)} ${configured} · sources ${connector.summary.discovery_sources} · schedules ${connector.summary.schedules} · open ${connector.summary.open_candidates}${hot} · verifiers ${connector.summary.verifiers} · policies ${connector.summary.action_policies} · runners ${connector.summary.action_runners}`;
        })
        : ["  no connectors"]),
      ...(report.global_action_policies.length
        ? ["", fg256(39, "Global policies"), ...report.global_action_policies.map((policy) => `  ${policy.id} · ${policy.kind}/${policy.decision} · ${policy.request_classes.join("/")}`)]
        : []),
    ]);
  }

  private async renderLoopPolicyView(): Promise<void> {
    const policy = await readLoopPolicy(this.app.config, this.app.workspace);
    this.renderPanel("Loop Internal Policy", [
      `${fg256(39, "Default background isolation")} ${policy.default_background_isolation}`,
      `${fg256(39, "Workspace permission")} ${policy.workspace_permission.mode} · ${policy.workspace_permission.source}`,
      `${fg256(39, "Completion gate")} background requires ${policy.unattended_completion.task_strong_pass_providers.join("/")} pass · reflection only ${policy.unattended_completion.reflection_only_sufficient ? "allowed" : "blocked"}`,
      `${fg256(39, "Tool gates")} ${policy.unattended_tool_gates.request_classes.join("/")} deny destructive shell and connector mutation · read-only connector inspection ${policy.unattended_tool_gates.read_only_connector_inspection}`,
      `${fg256(39, "Connector verifiers")} ${policy.connector_verifiers.map((item) => item.id).join(", ") || "none"}`,
      `${fg256(39, "Action policies")} ${policy.connector_action_policies.map((item) => item.id).join(", ") || "none"}`,
      `${fg256(39, "Action runners")} ${policy.connector_action_runners.map((item) => item.id).join(", ") || "none"}`,
      `${fg256(39, "Skills")} enabled ${policy.skill_policy.enabled_count}/${policy.skill_policy.configured_enabled.length} · discovered ${policy.skill_policy.discovered_count} · missing ${policy.skill_policy.missing_enabled.length}`,
      `${fg256(39, "Learned skill")} ${policy.skill_policy.learned_workspace_skill.enabled ? "enabled" : policy.skill_policy.learned_workspace_skill.discovered ? "available" : "not adopted"}`,
      `${fg256(39, "Skill bodies")} ${policy.skill_policy.prompt_contract.skill_body_access} · embedded ${policy.skill_policy.prompt_contract.skill_bodies_embedded ? "yes" : "no"}`,
      fg256(244, "Applies when automation, inbox promotion, or daemon queueing does not pass --worktree or --active-checkout."),
    ]);
  }

  private renderLoopActionPreflightView(args: string[]): void {
    let session: SessionRecord | undefined;
    let inputArgs = args;
    if (args[0]) {
      const explicit = this.app.store.getSession(args[0]) ?? this.app.store.findSessionByPrefix(this.app.workspace.id, args[0]);
      if (explicit) {
        session = explicit;
        inputArgs = args.slice(1);
      }
    }
    session ??= this.optionalSession();
    if (!session) {
      this.renderNotice("Usage: /loop action-preflight [session] <connector> <area> <operation> [--kind read|mutation] [--surface first_class|cli|tool] [--request-class background|verification|interactive]");
      return;
    }
    try {
      const result = recordConnectorActionPreflight(this.app.store, session, parseConnectorActionPreflightInput(inputArgs));
      this.renderPanel("Loop Action Preflight", [
        `${fg256(39, "Session")} ${session.session_id.slice(0, 12)} · ${truncateToWidth(oneLine(session.title), 56)}`,
        `${fg256(39, "Decision")} ${result.status}${result.needs_review ? " · needs review" : ""}${result.recorded ? " · recorded" : ""}`,
        `${fg256(39, "Request")} ${result.request_class} · ${result.action.surface} · ${result.action.connector}`,
        `${fg256(39, "Action")} ${result.action.kind} · ${result.action.area}.${result.action.operation}`,
        `${fg256(39, "Reason")} ${result.reason}`,
        result.review_surface ? `${fg256(39, "Review")} ${result.review_surface}` : undefined,
        result.event_id ? `${fg256(39, "Event")} ${result.event_id}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async renderLoopActionRunView(args: string[]): Promise<void> {
    let session: SessionRecord | undefined;
    let inputArgs = args;
    if (args[0]) {
      const explicit = this.app.store.getSession(args[0]) ?? this.app.store.findSessionByPrefix(this.app.workspace.id, args[0]);
      if (explicit) {
        session = explicit;
        inputArgs = args.slice(1);
      }
    }
    session ??= this.optionalSession();
    if (!session) {
      this.renderNotice("Usage: /loop action-run [session] github pull_request merge --repo owner/repo --number N [--execute] OR github pull_request review --repo owner/repo --number N --event approve|request-changes|comment [--body TEXT] [--execute] OR github pull_request comment --repo owner/repo --number N --body TEXT [--execute] OR github pull_request label --repo owner/repo --number N [--add-label LABEL ...] [--remove-label LABEL ...] [--execute] OR github issue close --repo owner/repo --number N [--execute] OR github issue comment --repo owner/repo --number N --body TEXT [--execute] OR github issue label --repo owner/repo --number N [--add-label LABEL ...] [--remove-label LABEL ...] [--execute] OR github notification mark-read --thread THREAD [--execute] OR github run rerun --repo owner/repo --run-id RUN_ID [--execute] OR github workflow dispatch --repo owner/repo --workflow deploy.yml [--ref main] [--field key=value ...] [--execute] OR github deployment create-status --repo owner/repo --deployment-id ID --state success|failure|inactive|in_progress|queued|pending|error [--execute] OR github release create-draft --repo owner/repo --tag TAG (--notes TEXT|--generate-notes) [--execute] OR github release publish-draft --repo owner/repo --tag TAG [--execute] OR npm package publish [--tag latest] [--access public|restricted] [--provenance] [--execute]");
      return;
    }
    try {
      const result = await runConnectorAction(this.app.store, session, parseConnectorActionRunInput(inputArgs), {
        cwd: this.app.workspace.root,
        env: process.env,
      });
      this.renderPanel("Loop Action Run", [
        `${fg256(39, "Session")} ${session.session_id.slice(0, 12)} · ${truncateToWidth(oneLine(session.title), 56)}`,
        `${fg256(39, "Status")} ${result.status}${result.recorded ? " · recorded" : ""}`,
        `${fg256(39, "Request")} ${result.action.request_class} · ${result.action.connector} · ${result.action.area}.${result.action.operation}`,
        `${fg256(39, "Target")} ${formatConnectorActionTarget(result.action)}${formatConnectorActionOptions(result.action)}`,
        `${fg256(39, "Command")} ${result.command.executable} ${result.command.args.join(" ")}`,
        `${fg256(39, "Preflight")} ${result.preflight.status}${result.preflight.needs_review ? " · needs review" : ""}`,
        result.exit_code !== undefined ? `${fg256(39, "Exit")} ${result.exit_code}` : undefined,
        result.reason ? `${fg256(39, "Reason")} ${truncateToWidth(oneLine(result.reason), 72)}` : undefined,
        result.event_id ? `${fg256(39, "Event")} ${result.event_id}` : undefined,
      ].filter((line): line is string => Boolean(line)));
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private renderLoopActionsView(): void {
    const report = readLoopActions(this.app.store, this.app.workspace, { limit: 14 });
    this.renderPanel("Connector Action Audit", [
      `${fg256(39, "Summary")} total ${report.summary.total} · dry-run ${report.summary.dry_run} · executed ${report.summary.executed} · failed ${report.summary.failed} · denied ${report.summary.denied}`,
      `${fg256(39, "Connectors")} ${compactRecordCounts(report.summary.by_connector)}`,
      "",
      ...(report.actions.length
        ? report.actions.map((action) => {
          const target = action.thread
            ? ` · thread ${action.thread}`
            : action.target_run_id
              ? ` · ${action.repo ?? "repo unknown"} run ${action.target_run_id}`
              : action.workflow
                ? ` · ${action.repo ?? "repo unknown"} workflow ${action.workflow}${action.ref ? ` @ ${action.ref}` : ""}`
                : action.tag
                  ? ` · ${action.repo ?? "repo unknown"} release ${action.tag}`
                : action.dist_tag
                  ? ` · tag ${action.dist_tag}`
                : action.repo && action.number !== undefined ? ` · ${action.repo}#${action.number}` : "";
          const method = action.review_event ? ` · ${action.review_event}` : action.method ? ` · ${action.method}` : "";
          const workflowOptions = action.area === "workflow" && action.fields?.length
            ? ` · fields ${action.fields.length}`
            : "";
          const labelOptions = action.add_labels?.length || action.remove_labels?.length
            ? ` · labels +${action.add_labels?.length ?? 0}/-${action.remove_labels?.length ?? 0}`
            : "";
          const npmOptions = action.area === "package"
            ? `${action.access ? ` · ${action.access}` : ""}${action.provenance ? " · provenance" : ""}`
            : "";
          const exit = action.exit_code !== undefined ? ` · exit ${action.exit_code}` : "";
          const source = action.source === "action_run" ? "" : ` · ${action.source}`;
          return `  ${action.status.padEnd(8)} ${action.connector}.${action.area}.${action.operation}${target}${method}${workflowOptions}${labelOptions}${npmOptions}${exit}${source} · ${truncateToWidth(oneLine(action.session_title), 42)}`;
        })
        : ["  no connector actions"]),
    ]);
  }

  private renderLoopRoadmapView(): void {
    const roadmap = readLoopRoadmap();
    const partial = roadmap.capabilities.filter((item) => item.status === "partially_implemented");
    this.renderPanel("Loop Internal Roadmap", [
      `${fg256(39, "Goal-native closure")} ${roadmap.closure_status}`,
      `${fg256(39, "Full product model")} ${roadmap.full_product_model_status}`,
      `${fg256(39, "Scope")} ${truncateToWidth(roadmap.scope_note, 88)}`,
      `${fg256(39, "Coverage")} implemented ${roadmap.summary.implemented} · partial ${roadmap.summary.partially_implemented} · future ${roadmap.summary.future_product_work}`,
      "",
      fg256(39, "Current closure"),
      ...roadmap.current_closure.map((item) => `  ${item}`),
      "",
      fg256(39, "Partial/future edges"),
      ...(partial.length ? partial.slice(0, 6).map((item) => `  ${item.name} · ${truncateToWidth(item.roadmap_position, 72)}`) : ["  none"]),
      ...(roadmap.future_product_extensions.length ? ["", fg256(39, "Future product extensions"), ...roadmap.future_product_extensions.slice(0, 4).map((item) => `  ${truncateToWidth(item, 84)}`)] : []),
    ]);
  }

  private async renderAutomationView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "list").toLowerCase();
    try {
      switch (action) {
        case "list":
        case "status":
          this.renderAutomationPanel();
          return;
        case "add":
          await this.addAutomationSchedule(tokens.slice(1));
          return;
        case "run-due": {
          const result = await enqueueDueAutomationSchedules(this.app.store);
          this.renderPanel("Automation", [
            `${fg256(39, "Enqueued")} ${result.enqueued.length}  ${fg256(244, "Skipped")} ${result.skipped.length}`,
            ...result.enqueued.map(({ schedule, job }) => `  ${schedule.schedule_id.slice(0, 12)} -> ${job.job_id.slice(0, 12)} · ${truncateToWidth(oneLine(schedule.prompt), 70)}`),
            ...result.skipped.map(({ schedule, reason }) => `  ${schedule.schedule_id.slice(0, 12)} skipped · ${reason}`),
          ]);
          return;
        }
        case "pause":
          this.renderAutomationMutation("Paused", pauseLoopAutomationSchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        case "resume":
          this.renderAutomationMutation("Resumed", resumeLoopAutomationSchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        case "remove":
          this.renderAutomationMutation("Removed", removeLoopAutomationSchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        default:
          this.renderNotice(`Unknown automation action ${args}. Use /automation list, add, run-due, pause, resume, or remove.`);
      }
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async addAutomationSchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const parsed = parseAutomationFlags(args.slice(1));
    const prompt = parsed.args.length ? parsed.args.join(" ") : await this.ask("Recurring task", "Review the loop inbox and summarize open work");
    const schedule = createLoopAutomationSchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      prompt,
      config_path: this.app.configFiles[0],
      isolation: resolveLoopBackgroundIsolation(parsed.isolation, this.app.config),
      review_policy: parsed.review_policy,
    });
    this.renderAutomationMutation("Schedule Added", schedule);
  }

  private renderAutomationPanel(): void {
    const schedules = this.app.store.listAutomationSchedules({ workspaceId: this.app.workspace.id });
    this.renderPanel("Automation", [
      `${fg256(39, "Schedules")} ${schedules.length}`,
      "",
      ...(schedules.length ? schedules.map((schedule) => `  ${this.automationScheduleLabel(schedule)}`) : ["  no schedules"]),
    ]);
  }

  private renderAutomationMutation(title: string, schedule: AutomationSchedule): void {
    this.renderPanel(title, [`  ${this.automationScheduleLabel(schedule)}`]);
  }

  private automationScheduleLabel(schedule: AutomationSchedule): string {
    const interval = formatAutomationInterval(schedule.interval_ms);
    const last = schedule.last_job_id ? ` · last ${schedule.last_job_id.slice(0, 12)}` : "";
    const policy = [
      schedule.metadata.review_policy === "review" ? "review" : undefined,
      schedule.metadata.isolation === "worktree" ? "worktree" : undefined,
    ].filter(Boolean).join(" ");
    const policyText = policy ? ` · ${policy}` : "";
    return `${schedule.status.padEnd(7)} ${schedule.schedule_id.slice(0, 12)} · every ${interval} · next ${schedule.next_run_at}${policyText}${last} · ${truncateToWidth(oneLine(schedule.prompt), Math.max(24, terminalWidth() - 72))}`;
  }

  private async renderDiscoveryView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] ?? "list").toLowerCase();
    try {
      switch (action) {
        case "list":
        case "status":
          this.renderDiscoveryPanel();
          return;
        case "add":
          await this.addDiscoverySchedule(tokens.slice(1));
          return;
        case "add-git":
          await this.addGitDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-issues":
          await this.addGitHubIssuesDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-assigned-issues":
          await this.addGitHubAssignedIssuesDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-prs":
          await this.addGitHubPullRequestsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-assigned-prs":
          await this.addGitHubAssignedPullRequestsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-review-requests":
          await this.addGitHubReviewRequestsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-notifications":
          await this.addGitHubNotificationsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-ci":
          await this.addGitHubActionsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-draft-releases":
          await this.addGitHubDraftReleasesDiscoverySchedule(tokens.slice(1));
          return;
        case "add-github-deployments":
          await this.addGitHubDeploymentsDiscoverySchedule(tokens.slice(1));
          return;
        case "add-http":
          await this.addHttpHealthDiscoverySchedule(tokens.slice(1));
          return;
        case "add-npm-package":
          await this.addNpmPackageDiscoverySchedule(tokens.slice(1));
          return;
        case "run-due": {
          const result = await runDueDiscoverySchedules(this.app.store);
          this.renderPanel("Discovery", [
            `${fg256(39, "Ran")} ${result.ran.length}  ${fg256(203, "Failed")} ${result.failed.length}`,
            ...result.ran.flatMap(({ schedule, candidates }) => [
              `  ${schedule.schedule_id.slice(0, 12)} · ${candidates.length} candidates`,
              ...candidates.slice(0, 5).map((candidate) => `    ${candidate.candidate_id.slice(0, 12)} · ${truncateToWidth(oneLine(candidate.title), 64)}`),
            ]),
            ...result.failed.map(({ schedule, error }) => `  ${schedule.schedule_id.slice(0, 12)} failed · ${truncateToWidth(oneLine(error), 72)}`),
          ]);
          return;
        }
        case "pause":
          this.renderDiscoveryMutation("Paused", pauseLoopDiscoverySchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        case "resume":
          this.renderDiscoveryMutation("Resumed", resumeLoopDiscoverySchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        case "remove":
          this.renderDiscoveryMutation("Removed", removeLoopDiscoverySchedule(this.app.store, requiredText(tokens[1], "schedule")));
          return;
        default:
          this.renderNotice(`Unknown discovery action ${args}. Use /discovery list, add, add-git, add-github-issues, add-github-assigned-issues, add-github-prs, add-github-assigned-prs, add-github-review-requests, add-github-notifications, add-github-ci, add-github-draft-releases, add-github-deployments, add-http, add-npm-package, run-due, pause, resume, or remove.`);
      }
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private async addDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const command = args.length > 1 ? args.slice(1).join(" ") : await this.ask("Discovery command", "node .inferoa/discovery.js");
    const schedule = createLoopDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      command,
    });
    this.renderDiscoveryMutation("Discovery Added", schedule);
  }

  private async addGitDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const schedule = createGitChangesDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
    });
    this.renderDiscoveryMutation("Git Discovery Added", schedule);
  }

  private async addGitHubIssuesDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryConnectorFlags(args.slice(1));
    const schedule = createGitHubIssuesDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      labels: flags.labels,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Issues Discovery Added", schedule);
  }

  private async addGitHubAssignedIssuesDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryAssignedConnectorFlags(args.slice(1));
    const schedule = createGitHubAssignedIssuesDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      assignee: flags.assignee,
      labels: flags.labels,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Assigned Issues Discovery Added", schedule);
  }

  private async addGitHubAssignedPullRequestsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryAssignedConnectorFlags(args.slice(1));
    const schedule = createGitHubAssignedPullRequestsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      assignee: flags.assignee,
      labels: flags.labels,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Assigned PR Discovery Added", schedule);
  }

  private async addGitHubPullRequestsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryConnectorFlags(args.slice(1));
    const schedule = createGitHubPullRequestsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      labels: flags.labels,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub PR Discovery Added", schedule);
  }

  private async addGitHubReviewRequestsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryConnectorFlags(args.slice(1));
    const schedule = createGitHubReviewRequestsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Review Requests Discovery Added", schedule);
  }

  private async addGitHubNotificationsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryNotificationFlags(args.slice(1));
    const schedule = createGitHubNotificationsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      participating: flags.participating,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Notifications Discovery Added", schedule);
  }

  private async addGitHubActionsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryConnectorFlags(args.slice(1));
    const schedule = createGitHubActionsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub CI Discovery Added", schedule);
  }

  private async addGitHubDraftReleasesDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryConnectorFlags(args.slice(1));
    const schedule = createGitHubDraftReleasesDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo: flags.repo,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Draft Release Discovery Added", schedule);
  }

  private async addGitHubDeploymentsDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryDeploymentFlags(args.slice(1));
    const repo = flags.repo ?? (await this.ask("GitHub repo", "owner/repo"));
    const schedule = createGitHubDeploymentsDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      repo,
      environment: flags.environment,
      ref: flags.ref,
      limit: flags.limit,
    });
    this.renderDiscoveryMutation("GitHub Deployment Discovery Added", schedule);
  }

  private async addHttpHealthDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryHttpFlags(args.slice(1));
    const url = flags.url ?? (await this.ask("HTTP URL", "http://127.0.0.1:3000/health"));
    const schedule = createHttpHealthDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      url,
      expected_status: flags.status,
      timeout_ms: flags.timeout_ms,
    });
    this.renderDiscoveryMutation("HTTP Health Discovery Added", schedule);
  }

  private async addNpmPackageDiscoverySchedule(args: string[]): Promise<void> {
    const intervalText = args[0] ?? (await this.ask("Interval", "1h"));
    const interval = parseAutomationInterval(intervalText);
    const flags = parseDiscoveryNpmPackageFlags(args.slice(1));
    const packageName = flags.package_name ?? (await this.ask("npm package", "inferoa"));
    const version = flags.version ?? (await this.ask("npm version", "0.0.0"));
    const schedule = createNpmPackageDiscoverySchedule(this.app.store, this.app.workspace, {
      interval_ms: interval,
      package_name: packageName,
      version,
      tag: flags.tag,
    });
    this.renderDiscoveryMutation("npm Package Discovery Added", schedule);
  }

  private renderDiscoveryPanel(): void {
    const schedules = this.app.store.listDiscoverySchedules({ workspaceId: this.app.workspace.id });
    const candidates = this.app.store.listDiscoveryCandidates({ workspaceId: this.app.workspace.id }).slice(0, 20);
    this.renderPanel("Discovery", [
      `${fg256(39, "Schedules")} ${schedules.length}  ${fg256(39, "Candidates")} ${candidates.length}`,
      "",
      fg256(39, "Schedules"),
      ...(schedules.length ? schedules.map((schedule) => `  ${this.discoveryScheduleLabel(schedule)}`) : ["  no schedules"]),
      "",
      fg256(39, "Candidates"),
      ...(candidates.length ? candidates.map((candidate) => `  ${this.discoveryCandidateLabel(candidate)}`) : ["  no candidates"]),
    ]);
  }

  private renderDiscoveryMutation(title: string, schedule: DiscoverySchedule): void {
    this.renderPanel(title, [`  ${this.discoveryScheduleLabel(schedule)}`]);
  }

  private discoveryScheduleLabel(schedule: DiscoverySchedule): string {
    const interval = formatAutomationInterval(schedule.interval_ms);
    const error = schedule.last_error ? ` · error ${truncateToWidth(oneLine(schedule.last_error), 32)}` : "";
    return `${schedule.status.padEnd(7)} ${schedule.schedule_id.slice(0, 12)} · every ${interval} · next ${schedule.next_run_at}${error} · ${truncateToWidth(oneLine(schedule.command), Math.max(24, terminalWidth() - 78))}`;
  }

  private discoveryCandidateLabel(candidate: DiscoveryCandidate): string {
    return `${candidate.status.padEnd(8)} ${candidate.priority.padEnd(6)} ${candidate.candidate_id.slice(0, 12)} · ${truncateToWidth(oneLine(candidate.title), Math.max(24, terminalWidth() - 42))}`;
  }

  private async renderWorktreeView(args = ""): Promise<void> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const requested = (tokens[0] ?? "list").toLowerCase() as WorktreeAction;
    const action = requested === "status" ? "list" : requested;
    if (!["list", "health", "create", "run", "adopt", "cleanup", "remove"].includes(action)) {
      this.renderNotice(`Unknown worktree action ${args}. Use /worktree list, health, create, run, adopt, cleanup, or remove.`);
      return;
    }
    try {
      switch (action) {
        case "list":
          this.renderWorktreePanel(tokens.slice(1));
          return;
        case "health":
          this.renderWorktreeHealthPanel();
          return;
        case "create":
          await this.createWorktreeFromTui(tokens.slice(1));
          return;
        case "run":
          await this.queueWorktreeRunFromTui(tokens.slice(1));
          return;
        case "adopt":
          await this.adoptWorktreeFromTui(tokens.slice(1));
          return;
        case "cleanup":
          await this.cleanupWorktreesFromTui(tokens.slice(1));
          return;
        case "remove":
          await this.removeWorktreeFromTui(tokens.slice(1));
          return;
      }
    } catch (error) {
      this.renderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  private renderWorktreePanel(args: string[] = []): void {
    const includeRemoved = args.includes("--all") || args.includes("all");
    const worktrees = listLoopWorktrees(this.app.store, this.app.workspace, { includeRemoved });
    this.renderPanel("Worktrees", [
      `${fg256(39, "Managed")} ${worktrees.length}`,
      "",
      ...(worktrees.length ? worktrees.map((worktree) => `  ${this.worktreeLabel(worktree)}`) : ["  no worktrees"]),
    ]);
  }

  private renderWorktreeHealthPanel(): void {
    const health = readLoopWorktreeHealth(this.app.store, this.app.workspace);
    const notable = health.items.filter((item) => item.severity !== "ok").slice(0, 10);
    this.renderPanel("Worktree Health", [
      `  active ${health.counts.active} · adopted ${health.counts.adopted} · failed ${health.counts.failed} · removed ${health.counts.removed}`,
      `  stale ${health.active_stale_count} · cleanup due ${health.cleanup_due_count} · attention ${health.attention_count}`,
      "",
      ...(notable.length
        ? notable.map((item) => `  ${item.severity.padEnd(9)} ${item.reasons.join(",")} · ${this.worktreeLabel(item.worktree)}`)
        : ["  no worktree health findings"]),
    ]);
  }

  private async createWorktreeFromTui(args: string[]): Promise<void> {
    const parsed = parseInlineWorktreeFlags(args);
    const worktree = await createLoopWorktree(this.app.store, this.app.workspace, {
      base_ref: parsed.baseRef,
      branch: parsed.branch,
      path: parsed.path,
    });
    this.renderPanel("Worktree Created", [`  ${this.worktreeLabel(worktree)}`]);
  }

  private async queueWorktreeRunFromTui(args: string[]): Promise<void> {
    const parsed = parseInlineWorktreeFlags(args);
    const prompt = parsed.args.length ? parsed.args.join(" ") : await this.ask("Isolated task", "Run repository validation and record evidence");
    const trimmed = prompt.trim();
    if (!trimmed) {
      this.renderNotice("No isolated task queued.");
      return;
    }
    const result = await queueDaemonRunInWorktree({
      stateDir: this.options.stateDir,
      workspaceRoot: this.app.workspace.root,
      sessionId: this.#sessionId,
      prompt: trimmed,
      title: titleFromPrompt(trimmed),
      configPath: this.app.configFiles[0],
      baseRef: parsed.baseRef,
      branch: parsed.branch,
      path: parsed.path,
    });
    const status = await startDaemon({ stateDir: this.options.stateDir });
    this.#sessionId = result.job.session_id;
    this.renderPanel("Worktree Job Queued", [
      `${fg256(48, "•")} ${this.worktreeLabel(result.worktree)}`,
      `${fg256(48, "•")} ${this.jobLabel(result.job)}`,
      `${fg256(39, "Daemon")} ${status.alive ? `alive pid ${status.pid}` : "start requested"}`,
    ]);
  }

  private async removeWorktreeFromTui(args: string[]): Promise<void> {
    const parsed = parseInlineWorktreeFlags(args);
    const worktree = await removeLoopWorktree(this.app.store, this.app.workspace, requiredText(parsed.args[0], "worktree"), { force: parsed.force });
    this.renderPanel("Worktree Removed", [`  ${this.worktreeLabel(worktree)}`]);
  }

  private async adoptWorktreeFromTui(args: string[]): Promise<void> {
    const parsed = parseInlineWorktreeFlags(args);
    const result = await adoptLoopWorktree(this.app.store, this.app.workspace, requiredText(parsed.args[0], "worktree"), {
      dry_run: parsed.dryRun,
      message: parsed.message,
    });
    this.renderPanel(parsed.dryRun ? "Worktree Adoption Check" : "Worktree Adopted", [
      `  ${result.status} · ${result.worktree.worktree_id.slice(0, 12)} · ${result.worktree.branch}`,
      `  base ${result.base_head.slice(0, 12)} · worktree ${result.worktree_head.slice(0, 12)}`,
      ...(result.output ? [`  ${truncateToWidth(oneLine(result.output), Math.max(24, terminalWidth() - 4))}`] : []),
    ]);
  }

  private async cleanupWorktreesFromTui(args: string[]): Promise<void> {
    const parsed = parseInlineWorktreeFlags(args);
    const result = await cleanupLoopWorktrees(this.app.store, this.app.workspace, {
      dry_run: parsed.dryRun,
      force: parsed.force,
      older_than_ms: parsed.all ? 0 : parsed.olderThanMs,
    });
    this.renderPanel(parsed.dryRun ? "Worktree Cleanup Check" : "Worktrees Cleaned", [
      `  candidates ${result.candidates.length} · removed ${result.removed.length} · failed ${result.failed.length}`,
      `  cutoff ${result.cutoff}`,
      ...result.candidates.slice(0, 8).map((worktree) => `  ${this.worktreeLabel(worktree)}`),
    ]);
  }

  private worktreeLabel(worktree: ManagedWorktree): string {
    const job = worktree.job_id ? ` · job ${worktree.job_id.slice(0, 12)}` : "";
    const session = worktree.session_id ? ` · session ${worktree.session_id.slice(0, 12)}` : "";
    return `${worktree.status.padEnd(8)} ${worktree.worktree_id.slice(0, 12)} · ${worktree.branch}${session}${job} · ${truncateToWidth(worktree.path, Math.max(24, terminalWidth() - 72))}`;
  }

  private async renderDaemonView(args = ""): Promise<void> {
    const requested = args.trim().toLowerCase() as DaemonAction | "";
    const action = requested
      ? requested
      : await this.selectOption<DaemonAction>(
      "Daemon",
      [
        { value: "status", label: "Status", description: "Show daemon and background run state." },
        { value: "queue", label: "Queue run", description: "Start a supervised background task." },
        { value: "attach", label: "Attach", description: "Inspect a job and recent session events." },
        { value: "detach", label: "Detach", description: "Leave a queued or running job supervised." },
        { value: "cancel", label: "Cancel", description: "Request cancellation for an active job." },
      ],
      0,
      [fg256(244, "Daemon runs use the same durable session event log as chat.")],
    );
    if (!["status", "queue", "attach", "detach", "cancel"].includes(action)) {
      this.renderNotice(`Unknown daemon action ${args}. Use /daemon status, queue, attach, detach, or cancel.`);
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
    this.renderPanel("Daemon", [
      `${fg256(39, "Daemon")} ${status.alive ? `alive pid ${status.pid}` : "not running"}`,
      "",
      fg256(39, "Schedules"),
      ...(status.schedules.length ? status.schedules.map((schedule) => `  ${this.automationScheduleLabel(schedule)}`) : ["  no schedules"]),
      "",
      fg256(39, "Discovery"),
      ...(status.discovery_schedules.length ? status.discovery_schedules.map((schedule) => `  ${this.discoveryScheduleLabel(schedule)}`) : ["  no discovery schedules"]),
      "",
      fg256(39, "Jobs"),
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
    const isolation = resolveLoopBackgroundIsolation(undefined, this.app.config);
    const queued = isolation === "worktree"
      ? await queueDaemonRunInWorktree({
        stateDir: this.options.stateDir,
        workspaceRoot: this.app.workspace.root,
        sessionId: this.#sessionId,
        prompt: trimmed,
        title: titleFromPrompt(trimmed),
        configPath: this.app.configFiles[0],
      })
      : { job: await queueDaemonRun({
        stateDir: this.options.stateDir,
        workspaceRoot: this.app.workspace.root,
        sessionId: this.#sessionId,
        prompt: trimmed,
        title: titleFromPrompt(trimmed),
        configPath: this.app.configFiles[0],
      }) };
    const status = await startDaemon({ stateDir: this.options.stateDir });
    this.#sessionId = queued.job.session_id;
    const worktree = "worktree" in queued ? queued.worktree : undefined;
    this.renderPanel("Job Queued", [
      worktree ? `${fg256(48, "•")} ${this.worktreeLabel(worktree)}` : undefined,
      `${fg256(48, "•")} ${this.jobLabel(queued.job)}`,
      `${fg256(39, "Daemon")} ${status.alive ? `alive pid ${status.pid}` : "start requested"}`,
    ].filter((line): line is string => Boolean(line)));
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
        description: `${job.session_id.slice(0, 12)} · ${truncateToWidth(oneLine(job.prompt), 70)}`,
      })),
    );
    return jobs.find((job) => job.job_id === selected);
  }

  private jobLabel(job: SupervisorJob): string {
    const session = this.app.store.getSession(job.session_id);
    const sessionLabel = session ? `${session.session_id.slice(0, 12)} · ${session.title}` : job.session_id.slice(0, 12);
    const kind = job.kind === "goal" ? "goal" : "run";
    const pauseReason = typeof job.metadata.pause_reason === "string" && job.metadata.pause_reason.trim() ? ` · ${job.metadata.pause_reason}` : "";
    const worktree = typeof job.metadata.worktree_id === "string" && job.metadata.worktree_id.trim() ? ` · wt ${job.metadata.worktree_id.slice(0, 12)}` : "";
    return `${job.status.padEnd(16)} ${kind.padEnd(4)} ${job.job_id.slice(0, 12)} · ${sessionLabel}${worktree}${pauseReason} · ${truncateToWidth(oneLine(job.prompt), Math.max(24, terminalWidth() - 60))}`;
  }

  private async renderDoctorView(args = ""): Promise<void> {
    const action = (args.trim().toLowerCase() || "status") as DoctorAction;
    if (action !== "status" && action !== "run" && action !== "tools") {
      this.renderNotice(`Unknown doctor action ${args}. Use /doctor status, /doctor run, or /doctor tools.`);
      return;
    }
    if (action === "tools") {
      this.renderLoopTranscriptPanel("Doctor Tools", [
        `${fg256(75, "•")} queued built-in tool regression in this session`,
        fg256(243, "The agent will exercise representative tools, then return a report and improvement suggestions."),
      ]);
      this.enqueuePrompt(buildDoctorToolsRegressionPrompt(), { renderPrompt: false });
      return;
    }
    if (action === "run") {
      this.renderPanel("Doctor", [
        `${fg256(75, "•")} checking configured endpoint and optional Omni routes`,
        fg256(243, "This does not run release acceptance and does not require Omni endpoints."),
      ]);
    }

    const setup = this.app.config.model_setup;
    const endpointConfigured = Boolean(setup.base_url && setup.model);
    let snapshot: EndpointSignalSnapshot | undefined;
    let matrix = staticOmniCapabilityMatrix(this.app.config);
    const errors: string[] = [];
    try {
      snapshot = await new EndpointSignals(this.app.config).snapshot();
      matrix = snapshot.omni_capabilities ?? matrix;
      errors.push(...(snapshot.errors ?? []));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const daemon = await daemonStatus(this.options.stateDir);
    const endpointOk = endpointConfigured && errors.length === 0;
    const models = snapshot ? modelsFromSnapshot(snapshot) : [];
    const modelText = setup.model ?? "no model";
    const runtimeText = !endpointConfigured
      ? "not configured"
      : errors.length
        ? "needs attention"
        : models.length
          ? `${models.length} model${models.length === 1 ? "" : "s"} visible`
          : "reachable";
    const lines = [
      `${checkbox(endpointOk)} coding endpoint · ${endpointConfigured ? "configured" : "unconfigured"} · ${modelText}`,
      `  ${fg256(244, "mode")} ${setup.mode} · ${fg256(244, "provider")} ${setup.provider_id ?? setup.provider ?? "vllm"} · ${fg256(244, "url")} ${setup.base_url ?? "none"}`,
      `  ${fg256(244, "runtime")} ${runtimeText}`,
      `${doctorMarker(daemon.alive)} daemon · ${daemon.alive ? `alive pid ${daemon.pid}` : "not running"} · jobs ${daemon.jobs.length}`,
      "",
      fg256(39, "Optional Omni"),
      ...matrix.map((capability) => `${doctorMarker(capability.runtime_passed === true)} Omni ${capability.label} · ${omniCapabilitySummary(capability)} · optional`),
      "",
      `${fg256(39, "/doctor run")} probes configured endpoint metadata and optional Omni routes.`,
      `${fg256(39, "/doctor tools")} asks the current agent to regress built-in tools in-session and report issues.`,
      fg256(243, "Strict release acceptance is intentionally separate from the user health check."),
      ...(errors.length
        ? [
            "",
            fg256(203, "Attention"),
            ...errors.slice(0, 8).map((error) => `  ${error}`),
            ...(errors.length > 8 ? [fg256(244, `  ... ${errors.length - 8} more`)] : []),
          ]
        : []),
    ];
    this.renderPanel("Doctor", lines);
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
      ...suggestedSlashCommands().map((command) => `  /${command.name.padEnd(11)} ${command.description}`),
      "",
      fg256(39, "Subcommands"),
      `  /skills    list · manage`,
      `  /loop      status · mode auto|research|focus|explore|timebox · health · review · verify · pause · resume · drop`,
      `  /inbox     show · all · resolve · dismiss · promote`,
      `  /self-improve help · status · propose · run --replay · report · adopt`,
      `  /plan      show · set · pause · resume · approve · drop`,
      `  /tools     expand · compact · last`,
      `  /worktree  list · health · adopt`,
      `  /sessions  resume · new · all`,
      `  /doctor    status · run · tools`,
    ]);
  }

  private async submitPrompt(prompt: string, options: SubmitPromptOptions = {}): Promise<RuntimeRunResult | undefined> {
    if (!(await this.waitForCodeIntelligenceBeforeChat())) {
      return undefined;
    }
    if (options.renderPrompt !== false) {
      this.renderSubmittedPrompt(prompt);
    }
    const startedAt = Date.now();
    this.#activeRunStartedAtMs = startedAt;
    this.#lastGoalMetadataRedrawAtMs = startedAt;
    const markdown = new MarkdownStreamRenderer({ width: Math.max(40, terminalWidth() - 4) });
    const renderState: { lastSegment: "none" | "assistant" | "tool" } = {
      lastSegment: "none",
    };
    const liveToolCallIds = new Set<string>();
    const prefillActivity = options.activityLabel ?? inferoaActivityLabel("Prefill");
    const decodeActivity = inferoaActivityLabel("Decode");
    const renderSuppressedToolTrace = options.suppressTranscript && options.requestClass === "reflection" && options.visibility === "internal";
    const activity = this.startActivityIndicator(prefillActivity);
    let sawModelDelta = false;
    const abort = new AbortController();
    this.#activeAbort = abort;
    try {
      const result = await this.app.runtime.run({
        prompt,
        session_id: this.#sessionId,
        client_id: randomId("tui"),
        request_class: options.requestClass,
        visibility: options.visibility,
        run_id: options.runId,
        signal: abort.signal,
        onDelta: (text) => {
          if (!sawModelDelta) {
            sawModelDelta = true;
            activity.status(decodeActivity);
          }
          if (options.suppressTranscript) {
            return;
          }
          const rendered = markdown.write(text);
          if (!rendered) {
            return;
          }
          if (renderState.lastSegment === "tool") {
            this.writeTranscript("\n");
          }
          this.writeTranscript(rendered);
          renderState.lastSegment = "assistant";
        },
        onStatus: (event) => {
          if (event.type === "model_start") {
            sawModelDelta = false;
            activity.status(prefillActivity);
          }
          if (event.type === "model_retry") {
            activity.status(`Retrying Inferoa in ${formatDuration(event.delay_ms)}`);
          }
          if (event.type === "compression_start") {
            activity.status(formatCompressionStartActivity(event));
          }
          if (event.type === "compression_end") {
            if (options.suppressTranscript) {
              activity.status("Compacted goal context");
            } else {
              activity.record(formatCompressionActivityLine(event));
            }
          }
          if (event.type === "tool_start") {
            activity.status(event.summary ?? toolActivityAction(event.tool_name));
          }
          if (event.type === "tool_end") {
            if (options.suppressTranscript && !renderSuppressedToolTrace) {
              activity.status(formatToolActivityLine(event.tool_name, event.ok, event.summary, event.duration_ms));
              return;
            }
            let output = "";
            const flushed = options.suppressTranscript ? "" : markdown.flush();
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
      if (!options.suppressTranscript) {
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
      }
      return result;
    } catch (error) {
      activity.stop({ redraw: false });
      const flushed = markdown.flush();
      const message = error instanceof Error ? error.message : String(error);
      const renderedError = isAbortError(error) ? fg256(244, `Interrupted current loop: ${message}`) : fg256(203, message);
      if (options.suppressTranscript) {
        this.renderGoalSupervisorRecord("Loop run failed", message, 203);
      } else {
        this.writeTranscript(`${flushed}${flushed ? "\n" : ""}${renderedError}\n\n`);
      }
      return undefined;
    } finally {
      if (this.#activeAbort === abort) {
        this.#activeAbort = undefined;
      }
      if (this.#activeRunStartedAtMs === startedAt) {
        this.#activeRunStartedAtMs = undefined;
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
      if (this.shouldRefreshGoalMetadata(now)) {
        this.#activeComposerRedraw?.();
        return;
      }
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
    if (!lines.length) {
      return undefined;
    }
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
    if (!lines.length) {
      return undefined;
    }
    return `${leadingGap ? "\n" : ""}${lines.join("\n")}\n`;
  }

  private renderGoalSupervisorRecord(action: string, detail?: string | GoalSupervisorRecordDetail[], color = 75): void {
    const width = safeTerminalWidth();
    const lines = [renderActivityRecordLine({
      marker: "•",
      markerColor: color,
      action,
      actionColor: color,
      detail: typeof detail === "string" && detail ? oneLine(detail) : undefined,
      detailColor: 250,
      width,
    })];
    if (Array.isArray(detail)) {
      for (const item of detail) {
        lines.push(...renderGoalSupervisorDetail(item, width));
      }
    }
    this.writeTranscript(withConversationGap(lines.join("\n")));
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

  private clearCenteredPrompt(): void {
    if (this.#inlineMode) {
      this.eraseInlinePanel();
      return;
    }
    stdout.write(ansi.clear);
  }

  private renderInlinePanel(title: string, body: string[]): void {
    const width = safeTerminalWidth();
    const line = (text = "") => bgLine(236, terminalLine(text), width);
    const lines = [
      line(`  ${title}`),
      line(),
      ...body.map((item) => line(`  ${item}`)),
      line(),
    ];
    if (this.patchInlinePanel(lines)) {
      return;
    }
    this.eraseInlinePanel();
    this.#inlineRenderedLines = lines.length;
    this.#inlinePanelStartRow = undefined;
    this.#inlineRenderedContent = lines;
    stdout.write(lines.join("\n"));
    stdout.write("\n");
  }

  private patchInlinePanel(lines: string[]): boolean {
    if (
      !this.#inlineRenderedLines ||
      this.#inlinePanelStartRow !== undefined ||
      !this.#inlineRenderedContent ||
      this.#inlineRenderedContent.length !== lines.length
    ) {
      return false;
    }
    stdout.write(ansi.hideCursor);
    stdout.write(`\x1b[${this.#inlineRenderedLines}A`);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (this.#inlineRenderedContent[index] !== line) {
        stdout.write(`\r${CLEAR_LINE}${line}`);
      }
      if (index < lines.length - 1) {
        stdout.write("\x1b[1B");
      }
    }
    stdout.write("\r\x1b[1B");
    stdout.write(ansi.showCursor);
    this.#inlineRenderedLines = lines.length;
    this.#inlineRenderedContent = lines;
    return true;
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
    this.#inlineRenderedContent = undefined;
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
    this.#inlineRenderedContent = undefined;
  }

  private resumeReadline(): void {
    try {
      this.#rl?.resume();
    } catch {
      // Ctrl+C can close readline before raw-mode cleanup runs.
    }
  }

  private renderNotice(message: string): void {
    this.renderLoopTranscriptPanel("Notice", [fg256(203, message)]);
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

function parseGoalStartArgs(args: string): { objective: string; hil_policy?: GoalHilPolicy; owner?: string; review_owner?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const parsed = extractGoalStartFlags(parts);
  return {
    objective: parsed.parts.join(" ").trim(),
    hil_policy: parsed.hil_policy,
    owner: parsed.owner,
    review_owner: parsed.review_owner,
  };
}

function extractGoalStartFlags(parts: string[]): { parts: string[]; hil_policy?: GoalHilPolicy; owner?: string; review_owner?: string } {
  let hilPolicy: GoalHilPolicy | undefined;
  let owner: string | undefined;
  let reviewOwner: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const normalized = part.toLowerCase();
    if (normalized === "--review") {
      hilPolicy = "review";
      continue;
    }
    if (normalized === "--auto-review" || normalized === "--no-review") {
      hilPolicy = "auto";
      continue;
    }
    if (normalized === "--owner") {
      owner = parts[index + 1];
      index += 1;
      continue;
    }
    if (normalized.startsWith("--owner=")) {
      owner = part.slice("--owner=".length);
      continue;
    }
    if (normalized === "--review-owner") {
      reviewOwner = parts[index + 1];
      index += 1;
      continue;
    }
    if (normalized.startsWith("--review-owner=")) {
      reviewOwner = part.slice("--review-owner=".length);
      continue;
    }
    rest.push(part);
  }
  return { parts: rest, hil_policy: hilPolicy, owner, review_owner: reviewOwner };
}

function parseGoalReviewArgs(args: string): { decision?: GoalReviewChoice; feedback?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const decision = parseGoalReviewChoice(parts[0]);
  if (!decision) {
    return { feedback: args.trim() || undefined };
  }
  return {
    decision,
    feedback: parts.slice(1).join(" ").trim() || undefined,
  };
}

function parseGoalReviewChoice(value: string | undefined): GoalReviewChoice | undefined {
  return value === "approve" || value === "reject" || value === "revise" || value === "block" ? value : undefined;
}

function goalReviewPendingDetail(pending: NonNullable<GoalRecord["pending_review_decision"]>): string {
  const summary = pending.summary ?? pending.blocker ?? "human review required";
  return `${pending.action} · loop task ${pending.source_horizon_generation} · ${oneLine(summary)}`;
}

function loopReviewPanelLines(goal: GoalRecord, width = terminalWidth()): string[] {
  const pending = goal.pending_review_decision;
  if (!pending) {
    return ["No pending loop review decision."];
  }
  const lines: string[] = [];
  appendGoalPanelField(lines, "objective", goal.objective, width, 250, 39);
  appendGoalPanelField(lines, "decision", `${pending.action} from loop task ${pending.source_horizon_generation}`, width, 250, loopReviewDecisionColor(pending.action));
  if (pending.summary) {
    appendGoalPanelField(lines, "summary", pending.summary, width, 250, 39);
  }
  if (pending.blocker) {
    appendGoalPanelField(lines, "blocker", pending.blocker, width, 203, 203);
  }
  if (pending.verification_evidence) {
    appendGoalPanelField(lines, "evidence", compactLoopReviewEvidence(pending.verification_evidence), width, 244, 39);
  }
  if (pending.source_run_id) {
    appendGoalPanelField(lines, "source", pending.source_run_id, width, 244, 39);
  }
  if (pending.active_step_id) {
    appendGoalPanelField(lines, "active", pending.active_step_id, width, 244, 39);
  }
  if (pending.steps?.length) {
    lines.push("");
    lines.push(fg256(39, "Proposed next steps"));
    for (const [index, step] of pending.steps.entries()) {
      const status = step.status ? ` · ${step.status}` : "";
      const id = step.id ? `${step.id} · ` : "";
      appendLoopReviewText(lines, `- ${id}${step.title}${status}`, width, 250);
      if (step.evidence) {
        appendLoopReviewText(lines, `  evidence ${compactLoopReviewEvidence(step.evidence)}`, width, 244);
      }
    }
  } else if (pending.action === "expand") {
    lines.push("");
    lines.push(fg256(203, "No proposed next steps were recorded for this expand decision."));
  }
  lines.push("");
  lines.push(fg256(39, "Decision"));
  lines.push(`${fg256(244, "The TUI opens an inline review prompt to Approve, Adjust, Continue, or Block this decision.")}`);
  lines.push(`${fg256(244, `Approve will ${loopReviewApproveDescription(pending.action)}.`)}`);
  return lines;
}

function appendLoopReviewText(lines: string[], text: string, width: number, color: number): void {
  for (const chunk of wrapPlainText(oneLine(text), Math.max(12, width - 4))) {
    lines.push(fg256(color, chunk));
  }
}

function renderTranscriptBand(title: string, body: string[], width = terminalWidth()): string[] {
  return [
    bgLine(236, "", width),
    bgLine(236, `  ${fg256(75, title)}`, width),
    bgLine(236, "", width),
    ...body.map((line) => bgLine(236, `  ${line}`, width)),
    bgLine(236, "", width),
  ];
}

export interface GoalSetupChoiceState {
  selectedIndex: number;
}

export interface GoalSetupChoiceTokenResult<T extends string> {
  state: GoalSetupChoiceState;
  value?: T;
  cancelled?: boolean;
}

export interface GoalSetupWizardContext {
  objective?: string;
  steps?: readonly string[];
  currentStep?: string;
  selections?: GoalSetupWizardSelections;
  hint?: string;
}

export function applyGoalSetupChoiceToken<T extends string>(
  state: GoalSetupChoiceState,
  options: SelectOption<T>[],
  key: string,
): GoalSetupChoiceTokenResult<T> {
  if (!options.length) {
    return { state: { selectedIndex: 0 } };
  }
  const selectedIndex = Math.max(0, Math.min(state.selectedIndex, options.length - 1));
  if (key === "\u0003" || key === "\u001b") {
    return { state: { selectedIndex }, cancelled: true };
  }
  if (key === "\u001b[A" || key === "k") {
    return { state: { selectedIndex: (selectedIndex - 1 + options.length) % options.length } };
  }
  if (key === "\u001b[B" || key === "j") {
    return { state: { selectedIndex: (selectedIndex + 1) % options.length } };
  }
  if (key === "\r" || key === "\n") {
    return { state: { selectedIndex }, value: options[selectedIndex]?.value };
  }
  return { state: { selectedIndex } };
}

export function renderGoalSetupChoicePanel<T extends string>(
  title: string,
  options: SelectOption<T>[],
  selectedIndex: number,
  footer: string[] = [],
  width = terminalWidth(),
  wizard?: GoalSetupWizardContext,
): string[] {
  const safeWidth = Math.max(24, width);
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, options.length - 1)));
  const lines = [
    ...(wizard ? [renderGoalSetupStepRail(wizard, safeWidth), ""] : []),
    `${fg256(75, title)} ${fg256(238, "·")} ${fg256(244, wizard?.hint ?? "↑/↓ choose · enter select · esc cancels")}`,
    ...renderGoalSetupSummaryLines(wizard, safeWidth),
    "",
  ];
  for (const [index, option] of options.entries()) {
    const active = index === selected;
    const marker = active ? fg256(75, "›") : fg256(238, " ");
    const label = active ? fg256(252, option.label) : fg256(248, option.label);
    const value = active ? fg256(48, option.value) : fg256(244, option.value);
    const suffix = [
      active ? fg256(244, "selected") : undefined,
      option.description ? fg256(244, option.description) : undefined,
    ].filter(Boolean).join(` ${fg256(238, "·")} `);
    const detail = suffix ? ` ${fg256(238, "·")} ${suffix}` : "";
    lines.push(padRight(`${marker} ${label} ${fg256(238, "·")} ${value}${detail}`, safeWidth));
  }
  for (const item of footer) {
    lines.push(fg256(244, item));
  }
  while (lines.length < GOAL_SETUP_PANEL_BODY_ROWS) {
    lines.push("");
  }
  return lines;
}

function renderGoalSetupStepRail(wizard: GoalSetupWizardContext, width: number): string {
  const steps = wizard.steps?.length ? wizard.steps : GOAL_SETUP_WIZARD_STEPS;
  const currentIndex = Math.max(0, steps.findIndex((step) => step === wizard.currentStep));
  const rendered = steps.map((step, index) => {
    if (index === currentIndex) {
      return fg256(75, step);
    }
    if (index < currentIndex) {
      return fg256(250, step);
    }
    return fg256(244, step);
  }).join(` ${fg256(238, "→")} `);
  return truncateToWidth(`${fg256(39, "Progress")} ${fg256(238, "·")} ${rendered}`, width);
}

function renderGoalSetupSummaryLines(wizard: GoalSetupWizardContext | undefined, width: number): string[] {
  if (!wizard) {
    return [];
  }
  const rows: Array<[string, string | undefined]> = [
    ["goal", wizard.objective],
    ["type", wizard.selections?.type],
    ["mode", wizard.selections?.approach],
    ["hil", wizard.selections?.hil],
  ];
  const lines = rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([label, value]) => {
      const safeValue = truncateToWidth(oneLine(value), Math.max(12, width - 9));
      return `${fg256(244, padRight(label, 5))} ${fg256(250, safeValue)}`;
    });
  return lines.length ? ["", ...lines] : [];
}

function renderGoalSetupValuePanel(title: string, detail: string[], error: string | undefined, width = terminalWidth()): string[] {
  const lines = [
    bgLine(236, "", width),
    bgLine(236, `  ${fg256(75, title)}`, width),
  ];
  for (const item of detail) {
    for (const chunk of wrapPlainText(oneLine(item), Math.max(12, width - 4))) {
      lines.push(bgLine(236, `  ${fg256(244, chunk)}`, width));
    }
  }
  if (error) {
    lines.push(bgLine(236, "", width));
    lines.push(bgLine(236, `  ${fg256(203, error)}`, width));
  }
  lines.push(bgLine(236, "", width));
  return lines;
}

function compactLoopReviewEvidence(value: JsonObject): string {
  const keys = Object.keys(value).sort();
  if (!keys.length) {
    return "recorded";
  }
  return keys
    .slice(0, 6)
    .map((key) => `${key}=${compactLoopReviewEvidenceValue(value[key])}`)
    .join(" · ");
}

function compactLoopReviewEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return truncateToWidth(oneLine(value), 60);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === "object") {
    return "{...}";
  }
  return String(value);
}

function loopReviewApproveDescription(action: GoalReflectionDecision): string {
  switch (action) {
    case "expand":
      return "apply the staged decision and start the proposed loop task";
    case "done":
      return "apply the staged decision and complete the loop";
    case "blocked":
      return "apply the staged decision and pause with the recorded blocker";
  }
}

function loopReviewDecisionColor(action: string): number {
  if (action === "blocked" || action === "block") {
    return 203;
  }
  if (action === "done") {
    return 48;
  }
  if (action === "expand") {
    return 75;
  }
  return 244;
}

function parseGoalModeArgs(args: string): ParsedGoalModeOptions | undefined {
  const parsedFlags = parseGoalStartArgs(args);
  const parts = parsedFlags.objective.split(/\s+/).filter(Boolean);
  let kind: GoalKind = "task";
  let approach: GoalApproachChoice = "auto";
  let targetHours: number | undefined;
  if (!parts.length) {
    if (parsedFlags.hil_policy || parsedFlags.owner || parsedFlags.review_owner) {
      return {
        kind,
        strategy: undefined,
        objective: "",
        hil_policy: parsedFlags.hil_policy,
        owner: parsedFlags.owner,
        review_owner: parsedFlags.review_owner,
      };
    }
    return undefined;
  }
  const first = parts[0]?.toLowerCase();
  if (first === "auto") {
    parts.shift();
    if (parts[0]?.toLowerCase() === "research") {
      kind = "research";
      parts.shift();
    }
  } else if (first === "research") {
    kind = "research";
    parts.shift();
    if (parts[0]?.toLowerCase() === "auto") {
      parts.shift();
    }
  } else if (first === "focus" || first === "explore" || first === "timebox") {
    approach = first;
    parts.shift();
  } else {
    return {
      kind,
      strategy: undefined,
      objective: parts.join(" ").trim(),
      hil_policy: parsedFlags.hil_policy,
      owner: parsedFlags.owner,
      review_owner: parsedFlags.review_owner,
    };
  }
  const maybeApproach = parts[0]?.toLowerCase();
  if (kind === "research" && (maybeApproach === "focus" || maybeApproach === "explore" || maybeApproach === "timebox")) {
    approach = maybeApproach;
    parts.shift();
  }
  if (approach === "timebox" && parts[0]) {
    const parsed = parseGoalCampaignHours(parts[0]);
    if (parsed !== undefined) {
      targetHours = parsed;
      parts.shift();
    }
  }
  return {
    kind,
    strategy: goalStrategyInputForApproach(approach, targetHours),
    objective: parts.join(" ").trim(),
    hil_policy: parsedFlags.hil_policy,
    owner: parsedFlags.owner,
    review_owner: parsedFlags.review_owner,
  };
}

function legacyGoalModeShortcut(args: string): string | undefined {
  const head = args.trim().split(/\s+/)[0]?.toLowerCase();
  return head === "auto" || head === "research" || head === "focus" || head === "explore" || head === "timebox" ? head : undefined;
}

function goalStrategyInputForApproach(approach: GoalApproachChoice, targetHours?: number): GoalStrategyInput | undefined {
  if (approach === "auto") {
    return undefined;
  }
  const mode = goalStrategyModeFromPublicName(approach);
  if (!mode) {
    return undefined;
  }
  return {
    mode,
    inferred: false,
    target_hours: mode === "campaign" ? targetHours : undefined,
    rationale: `User selected ${approach} approach.`,
  };
}

function goalKindSetupLabel(kind: GoalKindChoice): string {
  return kind === "research" ? "Research" : "Task";
}

function goalApproachSetupLabel(approach: GoalApproachChoice, targetHours?: number): string {
  switch (approach) {
    case "auto":
      return "Auto";
    case "focus":
      return "Focus";
    case "explore":
      return "Explore";
    case "timebox":
      return targetHours === undefined ? "Timebox" : `Timebox ${formatGoalSetupHours(targetHours)}`;
  }
}

function goalHilSetupLabel(policy: GoalReviewPolicyChoice): string {
  return policy === "review" ? "Review" : "Auto";
}

function formatGoalSetupHours(hours: number): string {
  if (hours === 0.5) {
    return "30m";
  }
  return Number.isInteger(hours) ? `${hours}h` : `${hours}h`;
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

function goalPanelStrategy(goal: GoalRecord): string {
  const strategy = goal.strategy;
  if (!strategy) {
    return "auto";
  }
  return [
    goalApproachName(strategy),
    strategy.target_hours !== undefined ? formatGoalCampaignHours(strategy.target_hours) : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function goalPanelReviewSummary(goal: GoalRecord): string {
  const pending = goal.pending_review_decision;
  if (!pending) {
    return goal.hil_policy === "review" ? "manual" : "auto";
  }
  return [
    `pending ${pending.action}`,
    `loop task ${pending.source_horizon_generation}`,
    pending.summary,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function goalPanelProposedStepsSummary(goal: GoalRecord): string {
  const steps = goal.pending_review_decision?.steps ?? [];
  const first = steps[0]?.title;
  return `${steps.length} step${steps.length === 1 ? "" : "s"}${first ? ` · ${first}` : ""}`;
}

function goalPanelVerificationSummary(verification: GoalLoopVerification): string {
  return [
    verification.provider,
    verification.verifier_role,
    verification.verdict,
    verification.confidence,
    verification.horizon_generation !== undefined ? `loop task ${verification.horizon_generation}` : undefined,
    goalPanelMetricSummary(verification.metrics),
    verification.failure_reason,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function goalPanelMetricSummary(metrics: JsonObject | undefined): string | undefined {
  if (!metrics) {
    return undefined;
  }
  const primary = typeof metrics.primary_metric === "string" ? metrics.primary_metric : undefined;
  const metric = typeof metrics.metric === "number" || typeof metrics.metric === "string" ? String(metrics.metric) : undefined;
  if (primary && metric) {
    return `${primary} ${metric}`;
  }
  return metric;
}

function goalPanelSkillSnapshotSummary(snapshot: { skill_count: number; skills: Array<{ id: string }> }): string {
  const ids = snapshot.skills.map((skill) => skill.id).slice(0, 4);
  return `${snapshot.skill_count} enabled${ids.length ? ` · ${ids.join(", ")}` : ""}${snapshot.skill_count > ids.length ? ", ..." : ""}`;
}

function goalPanelCandidates(goal: GoalRecord): string {
  const ledger = goal.ledger;
  if (!ledger) {
    return "0 open · 0 done · 0 dismissed";
  }
  return `${ledger.open.length} open · ${ledger.done.length} done · ${ledger.rejected.length} dismissed`;
}

function goalPanelStatusLabel(state: GoalState): string {
  const status = state.goal.status;
  if (status === "complete" || status === "dropped" || status === "paused") {
    return status;
  }
  return state.enabled ? status : `${status} (paused)`;
}

function goalPanelContentWidth(): number {
  return Math.max(24, safeTerminalWidth() - 3);
}

function renderGoalPanelStatus(status: string, objective: string, width: number): string[] {
  const prefixPlain = `${status} `;
  const prefix = `${fg256(39, status)} `;
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(objective), room);
  const continuation = " ".repeat(visibleWidth(prefixPlain));
  return chunks.map((chunk, index) => (index === 0 ? `${prefix}${chunk}` : `${continuation}${chunk}`));
}

function appendGoalPanelField(lines: string[], label: string, text: string, width: number, textColor = 250, labelColor = 39): void {
  const prefixPlain = `${label} `;
  const prefix = `${fg256(labelColor, label)} `;
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(text), room);
  const continuation = " ".repeat(visibleWidth(prefixPlain));
  for (const [index, chunk] of chunks.entries()) {
    lines.push(index === 0 ? `${prefix}${fg256(textColor, chunk)}` : `${continuation}${fg256(textColor, chunk)}`);
  }
}

function goalCompletionRecordDetails(goal: GoalRecord): GoalSupervisorRecordDetail[] {
  const summary = goal.last_reflection_summary || goal.summary || "reflection found no remaining horizon";
  return [
    { label: "summary", text: summary, color: 250 },
    { label: "stats", text: completionBudgetReport(goal) ?? goalPanelUsage(goal) ?? "no usage recorded", color: 244 },
  ];
}

function goalPanelReflectionsSummary(reflections: GoalReflectionSnapshot[]): string {
  const latest = reflections.at(-1);
  if (!latest) {
    return "none";
  }
  return `${reflections.length} recorded · latest ${latest.decision} · loop task ${latest.generation}`;
}

function goalPanelAttemptsSummary(attempts: GoalLoopAttempt[]): string {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    counts.set(attempt.status, (counts.get(attempt.status) ?? 0) + 1);
  }
  const parts = [
    `${attempts.length} total`,
    countWithLabel(counts.get("completed"), "completed"),
    countWithLabel(counts.get("running"), "running"),
    countWithLabel(counts.get("failed"), "failed"),
  ].filter((part): part is string => Boolean(part));
  const latest = attempts.at(-1);
  const latestClass = latest?.request_class ?? "run";
  const latestLabel = latest ? `latest ${latestClass}${latest.visibility === "internal" ? " internal" : ""}` : undefined;
  return [...parts, latestLabel].filter((part): part is string => Boolean(part)).join(" · ");
}

function countWithLabel(count: number | undefined, label: string): string | undefined {
  return count ? `${count} ${label}` : undefined;
}

function renderGoalPanelHorizons(horizons: GoalHorizonSnapshot[], width: number, reflections: GoalReflectionSnapshot[] = []): string[] {
  const reflectionsByGeneration = groupGoalReflectionsByGeneration(reflections);
  return horizons.flatMap((horizon, index) => {
    const lines = renderGoalHorizonHeading(horizon, width);
    appendGoalTreeText(lines, "│  ", goalHorizonProgressSummary(horizon), width, 244);
    if (horizon.summary && !isSameGoalHorizonTitle(horizon.summary, horizon.title)) {
      appendGoalTreeText(lines, "│  ", horizon.summary, width, 244);
    }
    if (horizon.steps.length) {
      for (const [stepIndex, step] of horizon.steps.entries()) {
        lines.push(...renderGoalPanelHorizonStep(step, stepIndex === horizon.steps.length - 1, width));
      }
    } else {
      lines.push(`${fg256(244, "└─")} ${fg256(244, "-")} ${fg256(244, "no steps")}`);
    }
    for (const reflection of reflectionsByGeneration.get(horizon.generation) ?? []) {
      lines.push(...renderGoalPanelHorizonReflection(reflection, width));
    }
    if (index < horizons.length - 1) {
      lines.push(fg256(244, "│"));
    }
    return lines;
  });
}

function renderGoalHorizonHeading(horizon: GoalHorizonSnapshot, width: number): string[] {
  const marker = horizon.current ? fg256(75, "◆") : fg256(244, "◇");
  const markerPlain = "◇ ";
  const title = horizon.title ? ` · ${horizon.title}` : "";
  const text = `Loop task ${horizon.generation}${horizon.current ? " current" : ""}${title}`;
  const room = Math.max(12, width - visibleWidth(markerPlain));
  const chunks = wrapPlainText(oneLine(text), room);
  const continuation = " ".repeat(visibleWidth(markerPlain));
  return chunks.map((chunk, index) => (index === 0 ? `${marker} ${fg256(252, chunk)}` : `${continuation}${fg256(252, chunk)}`));
}

function isSameGoalHorizonTitle(summary: string, title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  const normalizedSummary = summary.replace(/^(?:horizon|loop task)\s+\d+\s*(?:[·:.-])\s*/i, "").trim();
  return normalizedSummary === title;
}

function groupGoalReflectionsByGeneration(reflections: GoalReflectionSnapshot[]): Map<number, GoalReflectionSnapshot[]> {
  const byGeneration = new Map<number, GoalReflectionSnapshot[]>();
  for (const reflection of reflections) {
    const group = byGeneration.get(reflection.generation) ?? [];
    group.push(reflection);
    byGeneration.set(reflection.generation, group);
  }
  return byGeneration;
}

function appendGoalTreeText(lines: string[], prefixPlain: string, text: string, width: number, color: number): void {
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(text), room);
  const prefix = fg256(244, prefixPlain);
  for (const chunk of chunks) {
    lines.push(`${prefix}${fg256(color, chunk)}`);
  }
}

function renderGoalPanelHorizonReflection(reflection: GoalReflectionSnapshot, width: number): string[] {
  const text = reflection.decision === "done" ? "" : reflection.summary ?? reflection.blocker ?? "";
  const prefixPlain = `│  decision ${reflection.decision}${text ? " · " : ""}`;
  const prefix = `${fg256(244, "│  ")}${fg256(39, "decision")} ${goalReflectionDecisionLabel(reflection.decision)}${text ? fg256(244, " · ") : ""}`;
  if (!text) {
    return [prefix.trimEnd()];
  }
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(text), room);
  const continuation = `${fg256(244, "│  ")}${" ".repeat(visibleWidth(`decision ${reflection.decision} · `))}`;
  return chunks.map((chunk, index) => (index === 0 ? `${prefix}${fg256(250, chunk)}` : `${continuation}${fg256(250, chunk)}`));
}

function goalReflectionDecisionLabel(decision: GoalReflectionSnapshot["decision"]): string {
  switch (decision) {
    case "expand":
      return fg256(75, decision);
    case "done":
      return fg256(48, decision);
    case "blocked":
      return fg256(203, decision);
  }
}

function renderGoalPanelHorizonStep(step: GoalHorizonSnapshot["steps"][number], isLast: boolean, width: number): string[] {
  const branch = isLast ? "└─" : "├─";
  const continuationBranch = isLast ? "   " : "│  ";
  const markerPlain = goalStepPlainStatusMarker(step.status);
  const prefixPlain = `${branch} ${markerPlain} ${step.id} `;
  const prefix = `${fg256(244, branch)} ${goalStepStatusMarker(step.status)} ${fg256(250, step.id)} `;
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(step.title), room);
  const continuation = `${fg256(244, continuationBranch)}${" ".repeat(visibleWidth(`${markerPlain} ${step.id} `))}`;
  return chunks.map((chunk, index) => (index === 0 ? `${prefix}${chunk}` : `${continuation}${chunk}`));
}

function goalHorizonProgressSummary(horizon: GoalHorizonSnapshot): string {
  if (!horizon.steps.length) {
    return "0 steps";
  }
  const order = ["completed", "in_progress", "blocked", "pending", "skipped"];
  const labels: Record<string, string> = {
    completed: "completed",
    in_progress: "in progress",
    blocked: "blocked",
    pending: "pending",
    skipped: "skipped",
  };
  const counts = new Map<string, number>();
  for (const step of horizon.steps) {
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  }
  return order
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? `${count} ${labels[status]}` : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function renderGoalSupervisorDetail(detail: GoalSupervisorRecordDetail, width: number): string[] {
  const label = detail.label.trim() || "detail";
  const color = detail.color ?? 250;
  const prefixPlain = `  ${label} `;
  const prefix = `  ${fg256(39, label)} `;
  const room = Math.max(12, width - visibleWidth(prefixPlain));
  const chunks = wrapPlainText(oneLine(detail.text), room);
  const continuation = " ".repeat(visibleWidth(prefixPlain));
  return chunks.map((chunk, index) => (index === 0 ? `${prefix}${fg256(color, chunk)}` : `${continuation}${fg256(color, chunk)}`));
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

function goalStepPlainStatusMarker(status: string): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "*";
    case "blocked":
      return "!";
    case "skipped":
      return "-";
    default:
      return " ";
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
    "\u001b[3~",
    "\u001b[4~",
    "\u001b[5~",
    "\u001b[6~",
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

export function selectOptionWindow<T>(options: readonly T[], selected: number, pageSize = SELECT_OPTION_PAGE_SIZE): SelectOptionWindow<T> {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalItems = options.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const clampedSelected = totalItems ? Math.max(0, Math.min(selected, totalItems - 1)) : 0;
  const pageIndex = Math.max(0, Math.min(Math.floor(clampedSelected / safePageSize), totalPages - 1));
  const startIndex = pageIndex * safePageSize;
  return {
    items: options.slice(startIndex, startIndex + safePageSize),
    startIndex,
    pageIndex,
    totalPages,
    totalItems,
  };
}

export function moveSelectOptionPage(selected: number, totalItems: number, pageSize = SELECT_OPTION_PAGE_SIZE, delta: number): number {
  if (totalItems <= 0) {
    return 0;
  }
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const clampedSelected = Math.max(0, Math.min(selected, totalItems - 1));
  const pageIndex = Math.floor(clampedSelected / safePageSize);
  const itemOffset = clampedSelected % safePageSize;
  const nextPageIndex = ((pageIndex + delta) % totalPages + totalPages) % totalPages;
  return Math.min(totalItems - 1, nextPageIndex * safePageSize + itemOffset);
}

function renderSetupOptionLine(label: string, description: string | undefined, active: boolean): string {
  const marker = active ? fg256(75, "›") : fg256(238, " ");
  const name = active ? fg256(252, label) : fg256(248, label);
  const detail = description ? `  ${fg256(244, description)}` : "";
  return `${marker} ${name}${detail}`;
}

function parseGoalCampaignHours(input: string): number | undefined {
  const normalized = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = match[2];
  if (!unit || unit.startsWith("h")) {
    return value;
  }
  return value / 60;
}

function formatGoalCampaignHours(hours: number): string {
  const precision = hours < 1 ? 3 : 2;
  const formatted = hours.toFixed(precision).replace(/\.?0+$/, "");
  return `${formatted}h`;
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
    event.type === "goal.reflection.started" ||
    event.type === "goal.reflection.completed" ||
    event.type === "goal.horizon.expanded" ||
    event.type.startsWith("goal.supervisor.") ||
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
    `${event.protected_tail_events} protected`,
    event.preserved_tail_events === undefined ? undefined : `${event.preserved_tail_events} replayed`,
    event.preserved_rounds === undefined ? undefined : `${event.preserved_rounds} rounds`,
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

function requiredText(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseAutomationFlags(args: string[]): { isolation?: AutomationIsolation; review_policy?: AutomationReviewPolicy; args: string[] } {
  let isolation: AutomationIsolation | undefined;
  let reviewPolicy: AutomationReviewPolicy | undefined;
  const output: string[] = [];
  for (const arg of args) {
    if (arg === "--worktree") {
      isolation = "worktree";
    } else if (arg === "--active-checkout") {
      isolation = "active_checkout";
    } else if (arg === "--review") {
      reviewPolicy = "review";
    } else if (arg === "--auto") {
      reviewPolicy = "auto";
    } else {
      output.push(arg);
    }
  }
  return { isolation, review_policy: reviewPolicy, args: output };
}

function parseInboxPromoteFlags(args: string[]): { isolation?: LoopInboxPromotionIsolation; item_id?: string } {
  let isolation: LoopInboxPromotionIsolation | undefined;
  const output: string[] = [];
  for (const arg of args) {
    if (arg === "--worktree") {
      isolation = "worktree";
    } else if (arg === "--active-checkout") {
      isolation = "active_checkout";
    } else {
      output.push(arg);
    }
  }
  return { isolation, item_id: output[0] };
}

function parseInboxRouteAddFlags(args: string[]): {
  route_id?: string;
  assignee: string;
  note?: string;
  kind?: LoopInboxItemKind;
  source?: string;
  priority?: LoopInboxPriority;
} {
  const owner = args[0]?.trim();
  if (!owner) {
    throw new Error("Usage: /inbox route add <owner> --kind <kind>|--source <source>|--priority <priority> [--id route_id] [note]");
  }
  let rest = args.slice(1);
  const id = consumeInlineFlagValue(rest, "--id");
  rest = id.rest;
  const kind = consumeInlineFlagValue(rest, "--kind");
  rest = kind.rest;
  const source = consumeInlineFlagValue(rest, "--source");
  rest = source.rest;
  const priority = consumeInlineFlagValue(rest, "--priority");
  rest = priority.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown inbox route option: ${unknown}`);
  }
  return {
    route_id: id.value,
    assignee: owner,
    note: rest.join(" "),
    kind: parseInboxKindFlag(kind.value),
    source: source.value,
    priority: parseInboxPriorityFlag(priority.value),
  };
}

function parseOptRunFlags(args: string[]): { replay: boolean; proposal_id?: string } {
  let replay = false;
  let proposalId: string | undefined;
  for (const arg of args) {
    if (arg === "--replay") {
      replay = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown self-improve run option: ${arg}`);
    }
    if (proposalId) {
      throw new Error(`Unexpected self-improve run argument: ${arg}`);
    }
    proposalId = arg;
  }
  return { replay, proposal_id: proposalId };
}

function parseInboxKindFlag(value: string | undefined): LoopInboxItemKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "goal_review"
    || value === "goal_blocker"
    || value === "goal_paused"
    || value === "verification_failure"
    || value === "stale_work"
    || value === "automation_review"
    || value === "action_review"
    || value === "discovery_candidate"
    || value === "daemon_job"
    || value === "skill_proposal"
    || value === "self_improve_replay"
  ) {
    return value;
  }
  throw new Error(`Unknown inbox item kind: ${value}`);
}

function parseInboxPriorityFlag(value: string | undefined): LoopInboxPriority | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new Error(`Unknown inbox priority: ${value}`);
}

function parseInboxViewArgs(args: string[]): { args: string[]; includeDone: boolean; includeMuted: boolean; assignee?: string; onlyUnassigned?: boolean } {
  const output: string[] = [];
  let includeDone = false;
  let includeMuted = false;
  let assignee: string | undefined;
  let onlyUnassigned = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all" || arg === "all") {
      includeDone = true;
      includeMuted = true;
      continue;
    }
    if (arg === "--muted" || arg === "muted") {
      includeMuted = true;
      continue;
    }
    if (arg === "--unassigned") {
      onlyUnassigned = true;
      continue;
    }
    if (arg === "--assignee") {
      assignee = args[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--assignee=")) {
      assignee = arg.slice("--assignee=".length);
      continue;
    }
    if (arg) {
      output.push(arg);
    }
  }
  if (assignee) {
    onlyUnassigned = false;
  }
  return { args: output, includeDone, includeMuted, assignee, onlyUnassigned };
}

function routeSelectorLabel(route: { kind?: string; source?: string; priority?: string }): string {
  const selectors = [
    route.kind ? `kind:${route.kind}` : undefined,
    route.source ? `source:${route.source}` : undefined,
    route.priority ? `priority:${route.priority}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return selectors.length ? ` · ${selectors.join(" ")}` : "";
}

function inboxFilterLabel(parsed: { assignee?: string; onlyUnassigned?: boolean; includeMuted?: boolean }): string | undefined {
  if (parsed.assignee) {
    return fg256(244, `owner:${parsed.assignee}`);
  }
  if (parsed.onlyUnassigned) {
    return fg256(244, "unassigned");
  }
  if (parsed.includeMuted) {
    return fg256(244, "including muted");
  }
  return undefined;
}

function parseDiscoveryConnectorFlags(args: string[]): { repo?: string; labels?: string[]; limit?: number } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const labels = consumeRepeatedFlagValues(rest, "--label");
  rest = labels.rest;
  const limit = consumeInlineFlagValue(rest, "--limit");
  rest = limit.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  let parsedLimit: number | undefined;
  if (limit.value !== undefined) {
    const value = Number.parseInt(limit.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--limit requires a positive integer");
    }
    parsedLimit = value;
  }
  return {
    repo: repo.value,
    labels: dedupeDiscoveryLabels(labels.values.map(parseDiscoveryGitHubLabel)),
    limit: parsedLimit,
  };
}

function parseDiscoveryAssignedConnectorFlags(args: string[]): { repo?: string; assignee?: string; labels?: string[]; limit?: number } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const assignee = consumeInlineFlagValue(rest, "--assignee");
  rest = assignee.rest;
  const labels = consumeRepeatedFlagValues(rest, "--label");
  rest = labels.rest;
  const limit = consumeInlineFlagValue(rest, "--limit");
  rest = limit.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  let parsedLimit: number | undefined;
  if (limit.value !== undefined) {
    const value = Number.parseInt(limit.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--limit requires a positive integer");
    }
    parsedLimit = value;
  }
  return {
    repo: repo.value,
    assignee: assignee.value,
    labels: dedupeDiscoveryLabels(labels.values.map(parseDiscoveryGitHubLabel)),
    limit: parsedLimit,
  };
}

function parseDiscoveryDeploymentFlags(args: string[]): { repo?: string; environment?: string; ref?: string; limit?: number } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const environment = consumeInlineFlagValue(rest, "--environment");
  rest = environment.rest;
  const ref = consumeInlineFlagValue(rest, "--ref");
  rest = ref.rest;
  const limit = consumeInlineFlagValue(rest, "--limit");
  rest = limit.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  let parsedLimit: number | undefined;
  if (limit.value !== undefined) {
    const value = Number.parseInt(limit.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--limit requires a positive integer");
    }
    parsedLimit = value;
  }
  return {
    repo: repo.value,
    environment: environment.value,
    ref: ref.value,
    limit: parsedLimit,
  };
}

function parseDiscoveryNotificationFlags(args: string[]): { repo?: string; participating?: boolean; limit?: number } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const limit = consumeInlineFlagValue(rest, "--limit");
  rest = limit.rest;
  const participating = rest.includes("--participating");
  rest = rest.filter((arg) => arg !== "--participating");
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  let parsedLimit: number | undefined;
  if (limit.value !== undefined) {
    const value = Number.parseInt(limit.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--limit requires a positive integer");
    }
    parsedLimit = value;
  }
  return {
    repo: repo.value,
    participating,
    limit: parsedLimit,
  };
}

function parseDiscoveryHttpFlags(args: string[]): { url?: string; status?: number; timeout_ms?: number } {
  let rest = [...args];
  const status = consumeInlineFlagValue(rest, "--status");
  rest = status.rest;
  const timeout = consumeInlineFlagValue(rest, "--timeout-ms");
  rest = timeout.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  if (rest.length > 1) {
    throw new Error(`Unexpected discovery argument: ${rest[1]}`);
  }
  let parsedStatus: number | undefined;
  if (status.value !== undefined) {
    const value = Number.parseInt(status.value, 10);
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new Error("--status requires an integer from 100 to 599");
    }
    parsedStatus = value;
  }
  let parsedTimeout: number | undefined;
  if (timeout.value !== undefined) {
    const value = Number.parseInt(timeout.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--timeout-ms requires a positive integer");
    }
    parsedTimeout = value;
  }
  return {
    url: rest[0],
    status: parsedStatus,
    timeout_ms: parsedTimeout,
  };
}

function parseDiscoveryNpmPackageFlags(args: string[]): { package_name?: string; version?: string; tag?: string } {
  let rest = [...args];
  const version = consumeInlineFlagValue(rest, "--version");
  rest = version.rest;
  const tag = consumeInlineFlagValue(rest, "--tag");
  rest = tag.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown discovery option: ${unknown}`);
  }
  if (rest.length > 1) {
    throw new Error(`Unexpected discovery argument: ${rest[1]}`);
  }
  return {
    package_name: rest[0],
    version: version.value,
    tag: tag.value,
  };
}

function parseGitHubPrVerifierArgs(args: string[]): { pr: string; repo?: string } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub verifier option: ${unknown}`);
  }
  const pr = rest[0]?.trim();
  if (!pr) {
    throw new Error("Usage: /loop verify-github-pr <pr> [--repo owner/name]");
  }
  return { pr, repo: repo.value };
}

function parseGitHubReviewRequestVerifierArgs(args: string[]): { pr: string; repo?: string; reviewer?: string } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const reviewer = consumeInlineFlagValue(rest, "--reviewer");
  rest = reviewer.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub verifier option: ${unknown}`);
  }
  const pr = rest[0]?.trim();
  if (!pr) {
    throw new Error("Usage: /loop verify-github-review-request <pr> [--repo owner/name] [--reviewer login]");
  }
  return { pr, repo: repo.value, reviewer: reviewer.value };
}

function parseGitHubIssueVerifierArgs(args: string[]): { issue: string; repo?: string } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub verifier option: ${unknown}`);
  }
  const issue = rest[0]?.trim();
  if (!issue) {
    throw new Error("Usage: /loop verify-github-issue-status <issue> [--repo owner/name]");
  }
  return { issue, repo: repo.value };
}

function parseGitHubNotificationVerifierArgs(args: string[]): { thread: string } {
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub notification verifier option: ${unknown}`);
  }
  const thread = args[0]?.trim();
  if (!thread) {
    throw new Error("Usage: /loop verify-github-notification <thread_id>");
  }
  return { thread };
}

function parseGitHubRunVerifierArgs(args: string[]): { run: string; repo?: string; attempt?: number } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const attempt = consumeInlineFlagValue(rest, "--attempt");
  rest = attempt.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub verifier option: ${unknown}`);
  }
  const run = rest[0]?.trim();
  if (!run) {
    throw new Error("Usage: /loop verify-github-run <run_id> [--repo owner/name] [--attempt N]");
  }
  let parsedAttempt: number | undefined;
  if (attempt.value !== undefined) {
    const value = Number.parseInt(attempt.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--attempt requires a positive integer");
    }
    parsedAttempt = value;
  }
  return { run, repo: repo.value, attempt: parsedAttempt };
}

function parseGitHubWorkflowVerifierArgs(args: string[]): { workflow: string; repo?: string; branch?: string; event?: string; commit?: string } {
  let rest = [...args];
  const workflow = consumeInlineFlagValue(rest, "--workflow");
  rest = workflow.rest;
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const branch = consumeInlineFlagValue(rest, "--branch");
  rest = branch.rest;
  const event = consumeInlineFlagValue(rest, "--event");
  rest = event.rest;
  const commit = consumeInlineFlagValue(rest, "--commit");
  rest = commit.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub workflow verifier option: ${unknown}`);
  }
  const targetWorkflow = workflow.value ?? rest[0]?.trim();
  if (!targetWorkflow) {
    throw new Error("Usage: /loop verify-github-workflow --workflow WORKFLOW [--repo owner/name] [--branch BRANCH] [--event EVENT] [--commit SHA]");
  }
  return {
    workflow: targetWorkflow,
    repo: repo.value,
    branch: branch.value,
    event: event.value,
    commit: commit.value,
  };
}

function parseGitHubDeploymentVerifierArgs(args: string[]): { repo: string; deployment_id?: string; environment?: string; ref?: string; expect?: string } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const deploymentId = consumeInlineFlagValue(rest, "--deployment-id");
  rest = deploymentId.rest;
  const environment = consumeInlineFlagValue(rest, "--environment");
  rest = environment.rest;
  const ref = consumeInlineFlagValue(rest, "--ref");
  rest = ref.rest;
  const expect = consumeInlineFlagValue(rest, "--expect");
  rest = expect.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub deployment verifier option: ${unknown}`);
  }
  if (rest.length) {
    throw new Error(`Unexpected GitHub deployment verifier argument: ${rest[0]}`);
  }
  if (!repo.value || (!deploymentId.value && !environment.value)) {
    throw new Error("Usage: /loop verify-github-deployment --repo owner/name (--deployment-id ID|--environment ENV) [--ref REF] [--expect success|inactive|failure|any]");
  }
  return {
    repo: repo.value,
    deployment_id: deploymentId.value,
    environment: environment.value,
    ref: ref.value,
    expect: parseGitHubDeploymentExpectedArg(expect.value),
  };
}

function parseGitHubReleaseVerifierArgs(args: string[]): { tag: string; repo?: string; expect?: string } {
  let rest = [...args];
  const repo = consumeInlineFlagValue(rest, "--repo");
  rest = repo.rest;
  const expect = consumeInlineFlagValue(rest, "--expect");
  rest = expect.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub release verifier option: ${unknown}`);
  }
  const tag = rest[0]?.trim();
  if (!tag) {
    throw new Error("Usage: /loop verify-github-release <tag> [--repo owner/name] [--expect published|draft|any]");
  }
  return { tag, repo: repo.value, expect: parseGitHubReleaseExpectedArg(expect.value) };
}

function parseGitHubReleaseExpectedArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "published" || normalized === "draft" || normalized === "any") {
    return normalized;
  }
  throw new Error("--expect must be published, draft, or any");
}

function parseGitHubDeploymentExpectedArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "success" || normalized === "inactive" || normalized === "failure" || normalized === "any") {
    return normalized;
  }
  throw new Error("--expect must be success, inactive, failure, or any");
}

function parseNpmPackageVerifierArgs(args: string[]): { package_name: string; version: string; tag?: string; timeout_ms?: number } {
  let rest = [...args];
  const version = consumeInlineFlagValue(rest, "--version");
  rest = version.rest;
  const tag = consumeInlineFlagValue(rest, "--tag");
  rest = tag.rest;
  const timeout = consumeInlineFlagValue(rest, "--timeout-ms");
  rest = timeout.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown npm verifier option: ${unknown}`);
  }
  const packageName = rest[0]?.trim();
  if (!packageName || !version.value?.trim()) {
    throw new Error("Usage: /loop verify-npm-package <package> --version X [--tag latest] [--timeout-ms N]");
  }
  let parsedTimeout: number | undefined;
  if (timeout.value !== undefined) {
    const value = Number.parseInt(timeout.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--timeout-ms requires a positive integer");
    }
    parsedTimeout = value;
  }
  return {
    package_name: packageName,
    version: version.value,
    tag: tag.value,
    timeout_ms: parsedTimeout,
  };
}

function parseHttpVerifierArgs(args: string[]): { url: string; status?: number; timeout_ms?: number } {
  let rest = [...args];
  const status = consumeInlineFlagValue(rest, "--status");
  rest = status.rest;
  const timeout = consumeInlineFlagValue(rest, "--timeout-ms");
  rest = timeout.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown HTTP verifier option: ${unknown}`);
  }
  const url = rest[0]?.trim();
  if (!url) {
    throw new Error("Usage: /loop verify-http <url> [--status N] [--timeout-ms N]");
  }
  let parsedStatus: number | undefined;
  if (status.value !== undefined) {
    const value = Number.parseInt(status.value, 10);
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new Error("--status requires an integer from 100 to 599");
    }
    parsedStatus = value;
  }
  let parsedTimeout: number | undefined;
  if (timeout.value !== undefined) {
    const value = Number.parseInt(timeout.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("--timeout-ms requires a positive integer");
    }
    parsedTimeout = value;
  }
  return { url, status: parsedStatus, timeout_ms: parsedTimeout };
}

function parseInlineWorktreeFlags(args: string[]): {
  args: string[];
  baseRef?: string;
  branch?: string;
  path?: string;
  force?: boolean;
  dryRun?: boolean;
  message?: string;
  olderThanMs?: number;
  all?: boolean;
} {
  let rest = [...args];
  const base = consumeInlineFlagValue(rest, "--base");
  rest = base.rest;
  const branch = consumeInlineFlagValue(rest, "--branch");
  rest = branch.rest;
  const worktreePath = consumeInlineFlagValue(rest, "--path");
  rest = worktreePath.rest;
  const message = consumeInlineFlagValue(rest, "--message");
  rest = message.rest;
  const olderThan = consumeInlineFlagValue(rest, "--older-than");
  rest = olderThan.rest;
  const force = rest.includes("--force");
  const dryRun = rest.includes("--dry-run");
  const all = rest.includes("--all") || rest.includes("all");
  rest = rest.filter((arg) => arg !== "--force" && arg !== "--dry-run" && arg !== "--all" && arg !== "all");
  return {
    args: rest,
    baseRef: base.value,
    branch: branch.value,
    path: worktreePath.value,
    force,
    dryRun,
    message: message.value,
    olderThanMs: olderThan.value ? parseAutomationInterval(olderThan.value) : undefined,
    all,
  };
}

function consumeInlineFlagValue(args: string[], flag: string): { value?: string; rest: string[] } {
  const index = args.indexOf(flag);
  if (index < 0) {
    return { rest: args };
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function consumeRepeatedFlagValues(args: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      values.push(value);
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return { values, rest };
}

function parseDiscoveryGitHubLabel(value: string): string {
  const label = value.trim();
  if (!label || /[\r\n]/.test(label)) {
    throw new Error("--label requires a non-empty single-line label");
  }
  return label;
}

function dedupeDiscoveryLabels(labels: string[]): string[] | undefined {
  if (!labels.length) {
    return undefined;
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(label);
    }
  }
  return output;
}

function formatAutomationInterval(intervalMs: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  if (intervalMs % day === 0) {
    return `${intervalMs / day}d`;
  }
  if (intervalMs % hour === 0) {
    return `${intervalMs / hour}h`;
  }
  if (intervalMs % minute === 0) {
    return `${intervalMs / minute}m`;
  }
  return formatDuration(intervalMs);
}

function renderInboxItemLines(item: LoopInboxItem, index: number): string[] {
  const markerColor = item.priority === "high" ? 203 : item.priority === "medium" ? 214 : 244;
  const heading = [
    `${String(index).padStart(2)}.`,
    fg256(markerColor, item.priority.padEnd(6)),
    item.status.padEnd(7),
    item.kind,
    truncateToWidth(oneLine(item.title), Math.max(20, terminalWidth() - 34)),
  ].join(" ");
  const details = [
    item.session_id ? `session ${item.session_id.slice(0, 12)}` : undefined,
    item.job_id ? `job ${item.job_id.slice(0, 12)}` : undefined,
    item.run_id ? `run ${item.run_id.slice(0, 12)}` : undefined,
    item.source ? `source ${item.source_label ?? item.source}` : undefined,
    item.assignee ? `owner ${item.assignee}` : undefined,
    item.routed_by ? `route ${item.routed_by}` : undefined,
    item.muted ? `muted ${item.mute_key ?? "item"}` : undefined,
    item.disposition ? item.disposition : undefined,
    item.snoozed_until ? `until ${item.snoozed_until}` : undefined,
    item.muted_until ? `until ${item.muted_until}` : undefined,
    item.stale ? `stale ${item.stale_reason ?? "work"}${item.stale_age_ms !== undefined ? ` ${formatDuration(item.stale_age_ms)}` : ""}` : undefined,
    item.detail ? truncateToWidth(oneLine(item.detail), Math.max(24, terminalWidth() - 8)) : undefined,
    item.assignment_note ? truncateToWidth(oneLine(item.assignment_note), Math.max(24, terminalWidth() - 8)) : undefined,
    item.routing_note && item.routing_note !== item.assignment_note ? truncateToWidth(oneLine(item.routing_note), Math.max(24, terminalWidth() - 8)) : undefined,
    item.mute_note ? truncateToWidth(oneLine(item.mute_note), Math.max(24, terminalWidth() - 8)) : undefined,
    item.disposition_note ? truncateToWidth(oneLine(item.disposition_note), Math.max(24, terminalWidth() - 8)) : undefined,
  ].filter((part): part is string => Boolean(part));
  return [
    `  ${heading}`,
    ...(details.length ? [`    ${fg256(244, details.join(" · "))}`] : []),
    ...(item.action ? [`    ${fg256(39, item.action)}`] : []),
  ];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function terminalLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function reflectionDetail(action: string, summary: string | undefined, horizonGeneration: number): string {
  const parts = [`${action} ${horizonGeneration}`];
  if (summary) {
    parts.push(summary);
  }
  return parts.join(" · ");
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
      return `Updated loop${failed}`;
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
    .replace(/^Goal horizon expanded/i, "Loop task expanded")
    .replace(/^Goal reflection recorded/i, "Loop decision recorded")
    .replace(/^Goal complete/i, "Loop complete")
    .replace(/^Goal /i, "Loop ")
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

function doctorMarker(ok: boolean): string {
  return ok ? `${fg256(48, "✓")} ` : `${fg256(244, "·")} `;
}

function buildDoctorToolsRegressionPrompt(): string {
  return [
    "Run a built-in tools regression in this current session and then report findings.",
    "",
    "Scope:",
    "- Exercise representative built-in tools through real tool calls, not by reading code only.",
    "- Cover read/search, file write/edit/patch, code intelligence, process management, git read-only tools, resources/session notes, skills, and any configured network or Omni tools that are safe and already configured.",
    "- Treat unconfigured, gated, or externally unavailable capabilities as skipped, not failed.",
    "- Subagent is optional: use it only if it is useful to verify child-session behavior without creating extra work.",
    "",
    "Safety and loop boundaries:",
    "- Do not create, resume, complete, drop, or review a loop. If a loop is active, only inspect/update evidence when directly relevant.",
    "- Do not run destructive shell commands or mutate user project files outside a temporary regression sandbox.",
    "- If you need files, create them under .inferoa/tool-regression/ and remove temporary files before the final report when practical.",
    "- Keep commands bounded with timeouts and avoid long-running package installs.",
    "",
    "Required final report:",
    "- Passed checks, failed checks, skipped checks.",
    "- Bugs or UX issues with concrete tool names and evidence.",
    "- Improvement suggestions prioritized by impact.",
    "- Any cleanup left behind.",
  ].join("\n");
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

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.trunc(value));
}

function compactRecordCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries.length ? entries.map(([key, count]) => `${key} ${count}`).join(" · ") : "none";
}

function formatConnectorActionOptions(action: { area: string; method?: string; review_event?: string; add_labels?: string[]; remove_labels?: string[]; delete_branch?: boolean; generate_notes?: boolean; draft?: boolean; verify_tag?: boolean; ref?: string; fields?: Array<{ key: string; value: string }>; dist_tag?: string; access?: string; provenance?: boolean }): string {
  if (action.area === "pull_request") {
    const method = action.review_event ? ` · ${action.review_event}` : action.method ? ` · ${action.method}` : "";
    const labels = action.add_labels?.length || action.remove_labels?.length
      ? ` · labels +${action.add_labels?.length ?? 0}/-${action.remove_labels?.length ?? 0}`
      : "";
    return `${method}${labels}${action.delete_branch ? " · delete branch" : ""}`;
  }
  if (action.area === "issue") {
    return action.add_labels?.length || action.remove_labels?.length
      ? ` · labels +${action.add_labels?.length ?? 0}/-${action.remove_labels?.length ?? 0}`
      : "";
  }
  if (action.area === "workflow") {
    return `${action.ref ? ` · ref ${action.ref}` : ""}${action.fields?.length ? ` · fields ${action.fields.length}` : ""}`;
  }
  if (action.area === "release") {
    const draft = action.draft === true ? " · draft" : action.draft === false ? " · publish" : "";
    return `${draft}${action.verify_tag ? " · verify tag" : ""}${action.generate_notes ? " · generate notes" : ""}`;
  }
  if (action.area === "package") {
    return ` · tag ${action.dist_tag ?? "latest"}${action.access ? ` · ${action.access}` : ""}${action.provenance ? " · provenance" : ""}`;
  }
  return "";
}

function formatConnectorActionTarget(action: { area: string; repo?: string; number?: number; thread?: string; target_run_id?: string; workflow?: string; tag?: string }): string {
  if (action.area === "notification") {
    return action.thread ? `thread ${action.thread}` : "thread unknown";
  }
  if (action.area === "run") {
    return action.repo && action.target_run_id ? `${action.repo} run ${action.target_run_id}` : "run unknown";
  }
  if (action.area === "workflow") {
    return action.repo && action.workflow ? `${action.repo} workflow ${action.workflow}` : "workflow unknown";
  }
  if (action.area === "release") {
    return action.repo && action.tag ? `${action.repo} release ${action.tag}` : "release unknown";
  }
  if (action.area === "package") {
    return "current package";
  }
  return action.repo && action.number !== undefined ? `${action.repo}#${action.number}` : "target unknown";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatOptionalPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : formatPercent(value);
}

function selfImproveHelpLines(): string[] {
  return [
    `${fg256(39, "Purpose")} turn verified loop evidence into a reviewable workspace skill.`,
    `${fg256(39, "Flow")} status -> propose -> run --replay -> report -> adopt`,
    "",
    ...selfImproveCommandLines(),
  ];
}

function selfImproveStatusLines(status: Awaited<ReturnType<typeof optLiteStatus>>): string[] {
  const latestTargets = status.latest_proposal?.skill_targets?.map((target) => target.skill_id).join(", ");
  return [
    `${fg256(39, "Purpose")} turn verified loop evidence into reviewable Loop/Workspace Skills.`,
    `${fg256(39, "Evidence")} sessions ${status.eligible_goal_sessions} · verifications ${status.verified_records} · feedback ${status.human_feedback_records} · signals ${status.learning_signal_records} · body loads ${status.skill_body_load_records ?? 0} · applied ${status.skill_rule_application_records ?? 0}`,
    `${fg256(39, "Proposals")} total ${status.proposal_count} · staged ${status.staged_count} · adopted ${status.adopted_count}`,
    `${fg256(39, "Replay")} reports ${status.replay_count}`,
    status.latest_proposal
      ? `${fg256(39, "Latest proposal")} ${status.latest_proposal.id} · ${status.latest_proposal.status} · ${latestTargets || status.latest_proposal.skill_id}`
      : `${fg256(39, "Latest proposal")} none`,
    status.latest_replay
      ? `${fg256(39, "Latest replay")} ${status.latest_replay.id} · ${status.latest_replay.status} · samples ${status.latest_replay.sample_count} · ${formatOptScore(status.latest_replay.baseline_score)} -> ${formatOptScore(status.latest_replay.candidate_score)}`
      : `${fg256(39, "Latest replay")} none`,
    `${fg256(39, "Next")} ${selfImproveNextAction(status)}`,
    "",
    ...selfImproveCommandLines(),
  ];
}

function selfImproveCommandLines(): string[] {
  return [
    fg256(39, "Commands"),
    `${fg256(48, "  /self-improve help")} ${fg256(244, "show this workflow")}`,
    `${fg256(48, "  /self-improve status")} ${fg256(244, "show evidence, proposals, and replay reports")}`,
    `${fg256(48, "  /self-improve propose")} ${fg256(244, "stage learned Loop/Workspace Skills from verified loop evidence")}`,
    `${fg256(48, "  /self-improve run --replay [proposal_id]")} ${fg256(244, "gate the staged proposal against replay samples")}`,
    `${fg256(48, "  /self-improve report [replay_id]")} ${fg256(244, "show the latest replay gate report")}`,
    `${fg256(48, "  /self-improve adopt [proposal_id]")} ${fg256(244, "adopt accepted staged Loop/Workspace Skills")}`,
  ];
}

function selfImproveNextAction(status: Awaited<ReturnType<typeof optLiteStatus>>): string {
  if (!status.eligible_goal_sessions || !status.verified_records) {
    return "finish a /loop with verification evidence, then /self-improve propose";
  }
  if (!status.staged_count) {
    return "/self-improve propose";
  }
  if (status.latest_replay?.status === "accepted") {
    return `/self-improve adopt ${status.latest_replay.proposal_id}`;
  }
  const proposalId = status.latest_proposal?.status === "staged" ? ` ${status.latest_proposal.id}` : "";
  return `/self-improve run --replay${proposalId}`;
}

function formatOptScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function moveCursorVertical(delta: number): void {
  if (delta > 0) {
    stdout.write(`\x1b[${delta}B`);
  } else if (delta < 0) {
    stdout.write(`\x1b[${Math.abs(delta)}A`);
  }
}
