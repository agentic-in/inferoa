import { ModelGateway } from "../model/gateway.js";
import { providerId } from "../model/endpoint-signals.js";
import { recordGoalLearningSignals } from "../loop/learning.js";
import { readGoalLoopView } from "../loop/projection.js";
import type { GoalLoopLearningSignal, GoalLoopVerification } from "../loop/types.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, ModelRequest, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { stableJson } from "../util/hash.js";
import type { OptLearningEdit, OptSkillTarget, OptSkillTargetKind } from "./opt-lite.js";

export type LoopLearningSignalTier = "T0" | "T1" | "T2" | "T3";
export type AgenticProposalSource = "agentic" | "deterministic_fallback";

export interface AgenticEvidencePacket {
  workspace: {
    id: string;
    root: string;
    alias: string;
  };
  sessions: AgenticEvidenceSession[];
  signals: AgenticEvidenceSignal[];
  source_events: AgenticSourceEvent[];
}

export interface AgenticEvidenceSession {
  session_id: string;
  goal_id: string;
  objective: string;
  verification_count: number;
}

export interface AgenticEvidenceSignal {
  signal_id: string;
  tier: LoopLearningSignalTier;
  target_hints: OptSkillTargetKind[];
  failure_mode: string;
  summary: string;
  source_event_id?: number;
  source_run_id?: string;
  evidence?: JsonObject;
}

export interface AgenticSourceEvent {
  session_id: string;
  event_id?: number;
  run_id?: string;
  type: string;
  summary: string;
}

export interface AgenticSkillProposalDraft {
  edits: AgenticSkillEditDraft[];
  rejected_signals?: AgenticRejectedSignal[];
}

export interface AgenticSkillEditDraft {
  target: OptSkillTargetKind;
  op: "add" | "replace" | "delete";
  section: string;
  anchor?: string;
  content: string;
  rationale: string;
  expected_behavior_change: string;
  eval_plan: string;
  source_event_ids: number[];
  source_signal_ids: string[];
}

export interface AgenticRejectedSignal {
  source_signal_id: string;
  reason: string;
}

export interface AgenticProposalOptimizer {
  propose(packet: AgenticEvidencePacket): Promise<AgenticProposalOptimizerResult>;
}

export type AgenticProposalOptimizerResult = AgenticSkillProposalDraft | AgenticProposalOptimizerOutput;

export interface AgenticProposalOptimizerOutput {
  draft: AgenticSkillProposalDraft;
  raw_proposal?: JsonObject;
  normalization_warnings?: string[];
  run?: AgenticOptimizerRun;
}

export interface AgenticOptimizerRun {
  session_id: string;
  run_id: string;
  title?: string;
  request_class: "background";
}

export interface NormalizedAgenticProposal {
  draft: AgenticSkillProposalDraft;
  raw_proposal?: JsonObject;
  normalization_warnings: string[];
}

export interface AgenticOptimizerRuntime {
  run(options: {
    prompt: string;
    title?: string;
    request_class?: "background";
    visibility?: "normal" | "internal";
    signal?: AbortSignal;
    max_tool_rounds?: number;
    tool_names?: string[];
  }): Promise<{
    session: { session_id: string; title?: string };
    run_id: string;
    content: string;
  }>;
}

export interface ValidatedAgenticProposal {
  proposal: AgenticSkillProposalDraft;
  edits: OptLearningEdit[];
  targets: OptSkillTarget[];
}

export class AgenticNoEditsError extends Error {
  constructor(readonly draft: AgenticSkillProposalDraft) {
    super(
      Array.isArray(draft.rejected_signals) && draft.rejected_signals.length
        ? "Agentic optimizer rejected all evidence and proposed no skill edits."
        : "Agentic optimizer proposed no skill edits.",
    );
    this.name = "AgenticNoEditsError";
  }
}

const VALID_TARGETS = new Set<OptSkillTargetKind>(["loop_skill", "workspace_skill"]);
const VALID_OPS = new Set(["add", "replace", "delete"]);
const MAX_EDIT_CONTENT_LENGTH = 1200;
export const SELF_IMPROVE_OPTIMIZER_TOOL_NAMES = [
  "ast_grep",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_explore",
  "codegraph_files",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_search",
  "codegraph_status",
  "file_search",
  "git_diff",
  "git_show",
  "git_status",
  "glob",
  "list_dir",
  "lsp",
  "read_file",
  "read_resource",
  "skill_list",
  "skill_read",
] as const;

export function buildAgenticEvidencePacket(store: SessionStore, workspace: WorkspaceIdentity): AgenticEvidencePacket {
  recordGoalLearningSignals(store, workspace);
  const sessions: AgenticEvidenceSession[] = [];
  const signals: AgenticEvidenceSignal[] = [];
  const sourceEvents: AgenticSourceEvent[] = [];
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    const view = readGoalLoopView(store, session.session_id);
    if (!view.goal) {
      continue;
    }
    const events = store.listEvents(session.session_id);
    sessions.push({
      session_id: session.session_id,
      goal_id: view.goal.id,
      objective: view.goal.objective,
      verification_count: view.verifications.length,
    });
    for (const signal of view.learning_signals) {
      signals.push(signalToEvidence(signal, view.verifications));
    }
    for (const event of events) {
      if (event.type === "goal.review.resolved" || event.type === "goal.verification.recorded") {
        sourceEvents.push({
          session_id: session.session_id,
          event_id: event.id,
          run_id: event.run_id,
          type: event.type,
          summary: eventSummary(event.data),
        });
      }
    }
  }
  return {
    workspace: {
      id: workspace.id,
      root: workspace.root,
      alias: workspace.alias,
    },
    sessions,
    signals: dedupeBy(signals, (signal) => signal.signal_id).slice(0, 80),
    source_events: sourceEvents.slice(0, 80),
  };
}

export function validateAgenticProposal(
  draft: AgenticSkillProposalDraft,
  packet: AgenticEvidencePacket,
): AgenticSkillProposalDraft {
  if (!Array.isArray(draft.edits) || draft.edits.length === 0) {
    throw new AgenticNoEditsError(draft);
  }
  const signalIds = new Set(packet.signals.map((signal) => signal.signal_id));
  const eventIds = new Set(packet.source_events.map((event) => event.event_id).filter((id): id is number => id !== undefined));
  const normalized: AgenticSkillEditDraft[] = draft.edits.map((edit, index) => {
    if (!VALID_TARGETS.has(edit.target)) {
      throw new Error(`Agentic edit ${index} has unsupported target: ${String(edit.target)}.`);
    }
    if (!VALID_OPS.has(edit.op)) {
      throw new Error(`Agentic edit ${index} has unsupported op: ${String(edit.op)}.`);
    }
    for (const key of ["section", "content", "rationale", "expected_behavior_change", "eval_plan"] as const) {
      if (!edit[key]?.trim()) {
        throw new Error(`Agentic edit ${index} is missing ${key}.`);
      }
    }
    if (edit.content.length > MAX_EDIT_CONTENT_LENGTH) {
      throw new Error(`Agentic edit ${index} is too large.`);
    }
    const citedSignals = [...new Set(edit.source_signal_ids ?? [])];
    const citedEvents = [...new Set(edit.source_event_ids ?? [])];
    if (!citedSignals.length && !citedEvents.length) {
      throw new Error(`Agentic edit ${index} has no citation; it must cite at least one source signal or event.`);
    }
    for (const signalId of citedSignals) {
      if (!signalIds.has(signalId)) {
        throw new Error(`Agentic edit ${index} cites unknown signal: ${signalId}.`);
      }
    }
    for (const eventId of citedEvents) {
      if (!eventIds.has(eventId)) {
        throw new Error(`Agentic edit ${index} cites unknown event: ${eventId}.`);
      }
    }
    if ((edit.op === "replace" || edit.op === "delete") && !edit.anchor?.trim()) {
      throw new Error(`Agentic edit ${index} with op ${edit.op} must include an anchor.`);
    }
    if (edit.anchor && edit.anchor.length > 500) {
      throw new Error(`Agentic edit ${index} anchor is too large.`);
    }
    if (looksLikeWholeTemplateRewrite(edit.content)) {
      throw new Error(`Agentic edit ${index} looks like a whole-skill template rewrite.`);
    }
    return {
      ...edit,
      source_signal_ids: citedSignals,
      source_event_ids: citedEvents,
    };
  });
  return {
    edits: normalized,
    rejected_signals: Array.isArray(draft.rejected_signals) ? draft.rejected_signals : [],
  };
}

export function renderAgenticSkillTargets(
  packet: AgenticEvidencePacket,
  draft: AgenticSkillProposalDraft,
  existingBodies: Partial<Record<OptSkillTargetKind, string>> = {},
): ValidatedAgenticProposal {
  const proposal = validateAgenticProposal(draft, packet);
  const edits = proposal.edits.map((edit, index): OptLearningEdit => ({
    target: edit.target,
    op: edit.op,
    section: edit.section,
    content: edit.content,
    rationale: [
      edit.rationale,
      `Expected behavior change: ${edit.expected_behavior_change}`,
      `Eval plan: ${edit.eval_plan}`,
    ].join("\n"),
    source_event_indexes: editSourceIndexes(packet, edit, index),
  }));
  return {
    proposal,
    edits,
    targets: (["loop_skill", "workspace_skill"] as const)
      .filter((target) => proposal.edits.some((edit) => edit.target === target))
      .map((target) =>
        target === "loop_skill"
          ? renderAgenticTarget("loop_skill", "inferoa-loop-skill", "Inferoa Loop Skill", proposal, existingBodies.loop_skill)
          : renderAgenticTarget("workspace_skill", "inferoa-workspace-skill", "Inferoa Workspace Skill", proposal, existingBodies.workspace_skill)
      ),
  };
}

export function modelGatewayAgenticOptimizer(config: VllmAgentConfig): AgenticProposalOptimizer | undefined {
  if (!config.model_setup.base_url || !config.model_setup.model) {
    return undefined;
  }
  const gateway = new ModelGateway(config);
  return {
    async propose(packet: AgenticEvidencePacket): Promise<AgenticProposalOptimizerOutput> {
      const response = await gateway.stream(modelRequest(config, packet));
      return parseAgenticProposalJsonWithMetadata(response.content);
    },
  };
}

export function runtimeAgenticOptimizer(config: VllmAgentConfig, runtime: AgenticOptimizerRuntime, options: { signal?: AbortSignal } = {}): AgenticProposalOptimizer | undefined {
  if (!config.model_setup.base_url || !config.model_setup.model) {
    return undefined;
  }
  return {
    async propose(packet: AgenticEvidencePacket): Promise<AgenticProposalOptimizerOutput> {
      const run = await runtime.run({
        title: "self-improve optimizer",
        request_class: "background",
        visibility: "internal",
        signal: options.signal,
        tool_names: [...SELF_IMPROVE_OPTIMIZER_TOOL_NAMES],
        prompt: runtimeOptimizerPrompt(packet),
      });
      const parsed = parseAgenticProposalJsonWithMetadata(run.content);
      return {
        ...parsed,
        run: {
          session_id: run.session.session_id,
          run_id: run.run_id,
          title: run.session.title,
          request_class: "background",
        },
      };
    },
  };
}

export function parseAgenticProposalJson(text: string): AgenticSkillProposalDraft {
  return parseAgenticProposalJsonWithMetadata(text).draft;
}

export function parseAgenticProposalJsonWithMetadata(text: string): NormalizedAgenticProposal {
  const candidate = parseJsonObjectFromModelText(text);
  if (!candidate.parsed) {
    throw new Error("Model did not return a JSON proposal.");
  }
  const normalized = normalizeAgenticProposalJson(candidate.parsed);
  return candidate.warning
    ? {
        ...normalized,
        normalization_warnings: [candidate.warning, ...normalized.normalization_warnings],
      }
    : normalized;
}

function parseJsonObjectFromModelText(text: string): { parsed?: unknown; warning?: string } {
  const trimmed = text.trim();
  const candidates = jsonObjectCandidates(trimmed);
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    try {
      return {
        parsed: JSON.parse(candidate),
        warning: candidate.length < trimmed.length ? "Extracted JSON object from model prose or fenced output." : undefined,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError) {
    throw lastError;
  }
  return {};
}

function jsonObjectCandidates(text: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }
    const candidate = balancedJsonObjectAt(text, index);
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      output.push(candidate);
    }
  }
  const fallback = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (fallback && !seen.has(fallback)) {
    output.push(fallback);
  }
  return output;
}

function balancedJsonObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

export function normalizeAgenticProposalJson(value: unknown): NormalizedAgenticProposal {
  const raw = objectRecord(value);
  if (!raw) {
    throw new Error("Agentic proposal JSON must be an object.");
  }
  const warnings: string[] = [];
  const rawEdits = rawEditEntries(raw, warnings);
  if (rawEdits.length && !Array.isArray(raw.edits)) {
    warnings.push("Normalized proposal edits from a non-standard edit field.");
  }
  const edits = rawEdits
    .map((entry, index) => normalizeAgenticEdit(entry.value, index, warnings, entry.defaultTarget))
    .filter((item): item is AgenticSkillEditDraft => Boolean(item));
  for (const synthesized of synthesizePolicyEdits(raw, warnings)) {
    if (!edits.some((edit) => edit.target === synthesized.target && edit.section === synthesized.section && edit.content === synthesized.content)) {
      edits.push(synthesized);
    }
  }
  const rejectedSignals = (arrayValue(raw.rejected_signals) ?? [])
    .map((item) => normalizeRejectedSignal(item))
    .filter((item): item is AgenticRejectedSignal => Boolean(item));
  return {
    draft: {
      edits,
      rejected_signals: rejectedSignals,
    },
    raw_proposal: raw as JsonObject,
    normalization_warnings: warnings,
  };
}

function synthesizePolicyEdits(raw: Record<string, unknown>, warnings: string[]): AgenticSkillEditDraft[] {
  const failureModes = (arrayValue(raw.failure_modes) ?? []).map((item) => objectRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
  const output: AgenticSkillEditDraft[] = [];
  for (const failureMode of failureModes) {
    const signalIds = stringArray(failureMode.sig_ids) ?? stringArray(failureMode.source_signal_ids) ?? [];
    if (!signalIds.length) {
      continue;
    }
    const modeId = stringValue(failureMode.mode_id) ?? stringValue(failureMode.id) ?? "model_failure_mode";
    const pattern = stringValue(failureMode.pattern) ?? stringValue(failureMode.summary) ?? "";
    const rootCause = stringValue(failureMode.root_cause) ?? "";
    const text = `${modeId} ${pattern} ${rootCause}`.toLowerCase();
    if (/not deep|不够深入|human.*fail|shallow|拆分更多/.test(text)) {
      output.push({
        target: "loop_skill",
        op: "add",
        section: "verification",
        content: [
          "When human feedback says a bug hunt was not deep enough, do not close after a small number of surface fixes.",
          "Expand the loop into structural checks such as concurrency/cancellation, zero-value sentinels, cache lifecycle, normalization edge cases, and missing verifier coverage before claiming completion.",
        ].join(" "),
        rationale: `Model-observed failure mode ${modeId}: ${pattern || rootCause}`,
        expected_behavior_change: "Future loop-control decisions expand or continue after shallow bug-hunt feedback instead of accepting reflection-only completion.",
        eval_plan: "Replay human-fail bug-hunt sessions and verify the controller chooses expand/continue with deeper structural checks.",
        source_event_ids: [],
        source_signal_ids: signalIds,
      });
    }
    if (/soft|reflection|self-reflection|validation|closure|done/.test(text)) {
      output.push({
        target: "loop_skill",
        op: "add",
        section: "completion",
        content: "Do not treat self-reflection as sufficient validation for deep code-quality or bug-hunting loops when hard human or verifier feedback has contradicted prior completion claims.",
        rationale: `Model-observed failure mode ${modeId}: ${pattern || rootCause}`,
        expected_behavior_change: "Future loops require verifier-backed or human-accepted evidence before completing deep bug-hunt work.",
        eval_plan: "Replay sessions with soft reflection passes and hard human failures; completion should be blocked until stronger verification exists.",
        source_event_ids: [],
        source_signal_ids: signalIds,
      });
    }
  }
  const observations = (arrayValue(raw.observations) ?? []).map((item) => objectRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
  const observedSignals = uniqueStrings(output.flatMap((edit) => edit.source_signal_ids));
  if (observations.length && observedSignals.length) {
    const bullets = observations
      .slice(0, 6)
      .map((observation) => {
        const file = stringValue(observation.file);
        const summary = stringValue(observation.summary) ?? stringValue(observation.detail);
        return [file, summary].filter((item): item is string => Boolean(item)).join(": ");
      })
      .filter(Boolean);
    if (bullets.length) {
      output.push({
        target: "workspace_skill",
        op: "add",
        section: "testing",
        content: [
          "For deep semantic-router looper bug hunts, include a broad checklist before completion:",
          ...bullets.map((bullet) => `- ${bullet}`),
        ].join("\n"),
        rationale: "Model observations identified recurring code-quality surfaces that prior shallow loops missed.",
        expected_behavior_change: "Future workspace work inspects the recurring looper bug surfaces instead of stopping at the first simple sort-order fix.",
        eval_plan: "During replay, workspace skill scoring should require these bug-surface checks for similar looper quality tasks.",
        source_event_ids: [],
        source_signal_ids: observedSignals,
      });
    }
  }
  if (output.length) {
    warnings.push("Synthesized skill policy edits from model failure modes and observations.");
  }
  return output;
}

function rawEditEntries(raw: Record<string, unknown>, warnings: string[]): Array<{ value: unknown; defaultTarget?: OptSkillTargetKind }> {
  const direct = arrayValue(raw.edits);
  if (direct) {
    return direct.map((value) => ({ value }));
  }
  const namedSources: Array<{ key: string; defaultTarget?: OptSkillTargetKind }> = [
    { key: "policy_edits" },
    { key: "skill_edits" },
    { key: "loop_policy_edits", defaultTarget: "loop_skill" },
    { key: "loop_rules", defaultTarget: "loop_skill" },
    { key: "workspace_rules", defaultTarget: "workspace_skill" },
    { key: "verifier_candidates", defaultTarget: "loop_skill" },
    { key: "bug_candidates", defaultTarget: "workspace_skill" },
  ];
  for (const source of namedSources) {
    const values = arrayValue(raw[source.key]);
    if (values?.length) {
      return values.map((value) => ({ value, defaultTarget: source.defaultTarget }));
    }
  }
  if (arrayValue(raw.observations)?.length || arrayValue(raw.failure_modes)?.length) {
    warnings.push("Model returned observations without concrete skill edits.");
  }
  return [];
}

function normalizeAgenticEdit(value: unknown, index: number, warnings: string[], defaultTarget?: OptSkillTargetKind): AgenticSkillEditDraft | undefined {
  const raw = objectRecord(value);
  if (!raw) {
    warnings.push(`Dropped edit ${index}: not an object.`);
    return undefined;
  }
  const rawTarget = objectRecord(raw.target);
  const target = normalizeTarget(raw.target) ?? defaultTarget;
  if (!target) {
    warnings.push(`Dropped edit ${index}: unsupported target ${String(raw.target)}.`);
    return undefined;
  }
  const rawOp = stringValue(raw.op);
  const op = normalizeOp(rawOp);
  if (!op) {
    warnings.push(`Normalized edit ${index}: missing or unsupported op ${String(raw.op)}; defaulted to add.`);
  }
  const section = normalizeEditSection(stringValue(raw.section) ?? stringValue(raw.type) ?? stringValue(raw.kind) ?? stringValue(raw.category) ?? (rawTarget ? "bug_hunting" : undefined), target);
  const summary = stringValue(raw.summary) ?? stringValue(raw.title) ?? stringValue(raw.description);
  const content = normalizeEditContent(raw.content, summary, target, warnings, index, rawTarget);
  const rationale = stringValue(raw.rationale) ?? stringValue(raw.reason) ?? summary ?? "Model-authored self-improve proposal.";
  return {
    target,
    op: op ?? "add",
    section,
    anchor: stringValue(raw.anchor),
    content,
    rationale,
    expected_behavior_change: stringValue(raw.expected_behavior_change)
      ?? stringValue(raw.expected_behavior)
      ?? summary
      ?? `Future ${target === "loop_skill" ? "loop control" : "workspace workflow"} follows this learned rule.`,
    eval_plan: stringValue(raw.eval_plan)
      ?? stringValue(raw.evaluation)
      ?? defaultEvalPlan(target, section),
    source_event_ids: numberArray(raw.source_event_ids)
      ?? numberArray(raw.source_events)
      ?? numberArray(objectRecord(raw.citations)?.events)
      ?? numberArray(objectRecord(raw.citation)?.events)
      ?? [],
    source_signal_ids: stringArray(raw.source_signal_ids)
      ?? stringArray(raw.signal_ids)
      ?? stringArray(raw.source_signals)
      ?? oneStringArray(raw.source_signal_id)
      ?? stringArray(objectRecord(raw.citations)?.signals)
      ?? stringArray(objectRecord(raw.citation)?.signals)
      ?? oneStringArray(objectRecord(raw.citation)?.signal_id)
      ?? [],
  };
}

function normalizeRejectedSignal(value: unknown): AgenticRejectedSignal | undefined {
  const raw = objectRecord(value);
  if (!raw) {
    return undefined;
  }
  const sourceSignalId = stringValue(raw.source_signal_id) ?? stringValue(raw.signal_id) ?? stringValue(raw.id);
  const reason = stringValue(raw.reason) ?? stringValue(raw.summary);
  if (!sourceSignalId || !reason) {
    return undefined;
  }
  return {
    source_signal_id: sourceSignalId,
    reason,
  };
}

function normalizeTarget(value: unknown): OptSkillTargetKind | undefined {
  const raw = objectRecord(value);
  if (raw) {
    return normalizeTarget(raw.type ?? raw.target ?? raw.kind);
  }
  if (value === "loop_skill" || value === "workspace_skill") {
    return value;
  }
  const text = stringValue(value)?.toLowerCase().replaceAll("-", "_");
  if (text === "loop" || text === "loop_policy" || text === "controller") {
    return "loop_skill";
  }
  if (text === "workspace" || text === "workspace_policy" || text === "project") {
    return "workspace_skill";
  }
  return undefined;
}

function normalizeOp(value: string | undefined): AgenticSkillEditDraft["op"] | undefined {
  const text = value?.toLowerCase().replaceAll("-", "_");
  if (text === "add" || text === "append" || text === "insert" || text === "create") {
    return "add";
  }
  if (text === "replace" || text === "update") {
    return "replace";
  }
  if (text === "delete" || text === "remove") {
    return "delete";
  }
  return undefined;
}

function normalizeEditSection(value: string | undefined, target: OptSkillTargetKind): string {
  const raw = value?.trim();
  const text = raw?.toLowerCase().replaceAll("-", "_").trim();
  switch (text) {
    case "verification_breadth":
    case "verifier_policy":
    case "verification_policy":
      return "verification";
    case "decompose_strategy":
    case "decomposition_strategy":
      return "decomposition";
    case "bug_surface_coverage":
    case "static_analysis":
      return target === "workspace_skill" ? "testing" : "verification";
    case "repo_convention":
    case "repo_conventions":
      return "repo_conventions";
    default:
      return raw || (target === "loop_skill" ? "verification" : "repo_conventions");
  }
}

function normalizeEditContent(
  value: unknown,
  summary: string | undefined,
  target: OptSkillTargetKind,
  warnings: string[],
  index: number,
  rawTarget?: Record<string, unknown>,
): string {
  if (rawTarget && stringValue(rawTarget.file)) {
    warnings.push(`Normalized edit ${index}: converted source-code patch target to a workspace skill policy.`);
    return truncateEditContent(codeTargetPolicyContent(value, summary, rawTarget), warnings, index);
  }
  if (typeof value === "string" && value.trim()) {
    return truncateEditContent(value.trim(), warnings, index);
  }
  const raw = objectRecord(value);
  if (!raw) {
    return truncateEditContent(summary ?? defaultEditContent(target), warnings, index);
  }
  warnings.push(`Normalized edit ${index}: converted structured content object to a skill instruction.`);
  const lines: string[] = [];
  if (summary) {
    lines.push(summary);
  }
  for (const [key, item] of Object.entries(raw)) {
    const title = normalizeSectionTitle(key.replaceAll("_", " "));
    if (Array.isArray(item)) {
      const values = item.map((entry) => stringValue(entry) ?? stableJson(entry)).filter(Boolean).slice(0, 8);
      if (values.length) {
        lines.push(`${title}:`);
        lines.push(...values.map((entry) => `- ${entry}`));
      }
    } else if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      lines.push(`${title}: ${String(item)}`);
    } else if (objectRecord(item)) {
      lines.push(`${title}: ${stableJson(item)}`);
    }
  }
  return truncateEditContent(lines.join("\n"), warnings, index);
}

function codeTargetPolicyContent(value: unknown, summary: string | undefined, rawTarget: Record<string, unknown>): string {
  const file = stringValue(rawTarget.file) ?? "the referenced source file";
  const lines = numberArray(rawTarget.lines);
  const location = lines?.length ? `${file}:${lines.join("-")}` : file;
  const notes = typeof value === "string" && value.trim()
    ? value.trim().replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "").trim()
    : undefined;
  return [
    summary
      ? `When doing similar bug-hunting work, inspect this pattern before claiming completion: ${summary}`
      : `Inspect ${location} before claiming similar work complete.`,
    `Scope: ${location}.`,
    "Use this as a workspace bug-hunting/checklist rule, not an automatic code patch.",
    notes ? `Inspection notes: ${notes}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function truncateEditContent(content: string, warnings: string[], index: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_EDIT_CONTENT_LENGTH) {
    return trimmed;
  }
  warnings.push(`Normalized edit ${index}: truncated content to ${MAX_EDIT_CONTENT_LENGTH} characters.`);
  return `${trimmed.slice(0, MAX_EDIT_CONTENT_LENGTH - 15).trimEnd()}\n... truncated`;
}

function defaultEditContent(target: OptSkillTargetKind): string {
  return target === "loop_skill"
    ? "When prior loop feedback indicates incomplete verification or insufficient depth, expand or verify before claiming completion."
    : "When this workspace has recurring verification feedback, inspect the relevant package, scripts, and verifier history before claiming completion.";
}

function defaultEvalPlan(target: OptSkillTargetKind, section: string): string {
  return target === "loop_skill"
    ? `Replay loop-control decisions for ${section} cases and verify the candidate prevents the previous incorrect decision.`
    : `Run or review the relevant workspace verifier for ${section} cases before adopting this rule.`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
  return values.length ? [...new Set(values)] : undefined;
}

function oneStringArray(value: unknown): string[] | undefined {
  const item = stringValue(value);
  return item ? [item] : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((item) => typeof item === "number" && Number.isFinite(item) ? Math.trunc(item) : typeof item === "string" && /^\d+$/.test(item) ? Number(item) : undefined)
    .filter((item): item is number => item !== undefined);
  return values.length ? [...new Set(values)] : undefined;
}

function runtimeOptimizerPrompt(packet: AgenticEvidencePacket): string {
  return [
    "You are the Inferoa self-improve optimizer.",
    "This is a proposal-only learning session, not a coding task.",
    "Never modify workspace files, run shell commands, enable or disable skills, spawn subagents, update goals, or write notes.",
    "Use only the read-only tools exposed in this session when extra context is necessary.",
    "Return only JSON. Prefer {observations, failure_modes, edits, rejected_signals}; edits may contain string or structured content.",
    "Write bounded Loop Skill or Workspace Skill policy edits, not whole skill templates.",
    "Do not propose source-code patches, diffs, or implementation changes; convert code findings into future loop/workspace behavior rules.",
    "Use edit target as the string loop_skill or workspace_skill, not a source file object.",
    "Every edit must cite source_signal_ids or source_event_ids from the evidence packet; use target loop_skill or workspace_skill.",
    "Do not accept soft-only evidence as validation.",
    "If the evidence is insufficient, return {\"edits\":[],\"rejected_signals\":[...]} instead of attempting implementation.",
    "",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

function modelRequest(config: VllmAgentConfig, packet: AgenticEvidencePacket): ModelRequest {
  return {
    session_id: "self_improve_agentic",
    run_id: "run_self_improve_agentic",
    mode: config.model_setup.mode,
    provider_id: providerId(config),
    model: config.model_setup.model ?? "",
    request_class: "background",
    tools: [],
    temperature: 0,
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: [
          "You are the Inferoa self-improve optimizer.",
          "Return only JSON. Prefer {observations, failure_modes, edits, rejected_signals}; edits may contain string or structured content.",
          "Write bounded Loop Skill or Workspace Skill policy edits, not whole skill templates.",
          "Do not propose source-code patches, diffs, or implementation changes; convert code findings into future loop/workspace behavior rules.",
          "Use edit target as the string loop_skill or workspace_skill, not a source file object.",
          "Every edit must cite source_signal_ids or source_event_ids from the packet; use target loop_skill or workspace_skill.",
          "Do not accept soft-only evidence as validation.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(packet, null, 2),
      },
    ],
  };
}

function signalToEvidence(signal: GoalLoopLearningSignal, verifications: GoalLoopVerification[]): AgenticEvidenceSignal {
  const matchingVerification = verifications.find((verification) =>
    verification.run_id === signal.source_run_id || verification.source_run_id === signal.source_run_id
  );
  return {
    signal_id: signal.signal_id,
    tier: signalTier(signal, matchingVerification),
    target_hints: signalTargetHints(signal, matchingVerification),
    failure_mode: signalFailureMode(signal, matchingVerification),
    summary: signal.summary,
    source_event_id: signal.source_event_id,
    source_run_id: signal.source_run_id,
    evidence: signal.evidence,
  };
}

function signalTier(signal: GoalLoopLearningSignal, verification: GoalLoopVerification | undefined): LoopLearningSignalTier {
  if (signal.category === "human_feedback") {
    return "T0";
  }
  if (!verification || verification.provider === "reflection") {
    return "T2";
  }
  if (verification.provider === "research") {
    return "T0";
  }
  if (verification.provider === "command" || verification.provider === "checker") {
    return "T1";
  }
  return verification.confidence === "hard" ? "T1" : "T2";
}

function signalTargetHints(signal: GoalLoopLearningSignal, verification: GoalLoopVerification | undefined): OptSkillTargetKind[] {
  const text = `${signal.summary} ${JSON.stringify(signal.evidence ?? {})}`.toLowerCase();
  const hints = new Set<OptSkillTargetKind>();
  if (verification?.provider === "command" || /\bnpm\b|\btest\b|\bdocs\b|\brelease\b|\brepo\b|\bworkspace\b/.test(text)) {
    hints.add("workspace_skill");
  }
  if (signal.category === "human_feedback" || /completion|done|blocked|partial|reflect|verify/.test(text)) {
    hints.add("loop_skill");
  }
  if (!hints.size) {
    hints.add("loop_skill");
  }
  return [...hints];
}

function signalFailureMode(signal: GoalLoopLearningSignal, verification: GoalLoopVerification | undefined): string {
  if (signal.category === "human_feedback") {
    return "human_feedback_constraint";
  }
  if (!verification || verification.provider === "reflection") {
    return "soft_or_reflection_only_evidence";
  }
  if (verification.verdict === "fail" || verification.verdict === "blocked" || verification.verdict === "partial") {
    return "non_pass_verifier";
  }
  if (verification.provider === "command") {
    return "workspace_command_verifier";
  }
  return "verified_behavior";
}

function renderAgenticTarget(
  target: OptSkillTargetKind,
  skillId: string,
  skillName: string,
  proposal: AgenticSkillProposalDraft,
  existingBody?: string,
): OptSkillTarget {
  const edits = proposal.edits.filter((edit) => edit.target === target);
  return {
    target,
    skill_id: skillId,
    skill_name: skillName,
    staged_skill_path: "",
    edit_count: edits.length,
    edits: edits.map((edit, index): OptLearningEdit => ({
      target,
      op: edit.op,
      section: edit.section,
      content: edit.content,
      rationale: edit.rationale,
      source_event_indexes: [index],
    })),
    body: renderAgenticSkillBody(skillName, target, edits, existingBody),
  };
}

function renderAgenticSkillBody(
  skillName: string,
  target: OptSkillTargetKind,
  edits: AgenticSkillEditDraft[],
  existingBody?: string,
): string {
  if (!edits.length) {
    return existingBody?.trimEnd() ?? renderEmptyAgenticSkillBody(skillName, target);
  }
  let body = existingBody?.trimEnd() ?? renderEmptyAgenticSkillBody(skillName, target);
  for (const edit of edits) {
    body = applyAgenticEdit(body, edit, Boolean(existingBody?.trim()));
  }
  return `${body.trimEnd()}\n\n${renderPatchNotes(edits)}`;
}

function renderEmptyAgenticSkillBody(skillName: string, target: OptSkillTargetKind): string {
  const title = target === "loop_skill" ? "Inferoa Loop Skill" : "Inferoa Workspace Skill";
  return [
    "---",
    `name: ${skillName}`,
    `description: Model-authored ${target === "loop_skill" ? "loop-control" : "workspace workflow"} policy learned from verified Inferoa evidence.`,
    "---",
    "",
    `# ${title}`,
    "",
    "Proposal source: model-authored self-improve optimizer.",
  ].join("\n");
}

function applyAgenticEdit(body: string, edit: AgenticSkillEditDraft, hadExistingBody: boolean): string {
  if (edit.op === "add") {
    return applyAddEdit(body, edit);
  }
  if (!hadExistingBody) {
    throw new Error(`Agentic ${edit.op} edit for ${edit.target}/${edit.section} requires an existing skill body.`);
  }
  if (!edit.anchor?.trim()) {
    throw new Error(`Agentic ${edit.op} edit for ${edit.target}/${edit.section} is missing an anchor.`);
  }
  if (!body.includes(edit.anchor)) {
    throw new Error(`Agentic ${edit.op} edit anchor not found in ${edit.target}/${edit.section}: ${edit.anchor}`);
  }
  if (edit.op === "replace") {
    return body.replace(edit.anchor, formatSkillInstruction(edit.content));
  }
  return collapseBlankLines(body.replace(edit.anchor, ""));
}

function applyAddEdit(body: string, edit: AgenticSkillEditDraft): string {
  const lines = body.split("\n");
  const heading = findMarkdownHeading(lines, edit.section);
  const instruction = formatSkillInstruction(edit.content);
  if (!heading) {
    return `${body.trimEnd()}\n\n## ${normalizeSectionTitle(edit.section)}\n\n${instruction}`;
  }
  const insertAt = findNextHeadingAtOrAbove(lines, heading.index + 1, heading.level) ?? lines.length;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const needsLeadingBlank = before.length > 0 && before.at(-1)?.trim() !== "";
  const insert = [
    ...(needsLeadingBlank ? [""] : []),
    instruction,
    "",
  ];
  return [...before, ...insert, ...after].join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();
}

function renderPatchNotes(edits: AgenticSkillEditDraft[]): string {
  return [
    "## Self-Improve Patch Notes",
    "",
    ...edits.flatMap((edit) => [
      `- ${edit.op} ${edit.section}`,
      `  - Rationale: ${edit.rationale}`,
      `  - Expected behavior change: ${edit.expected_behavior_change}`,
      `  - Eval plan: ${edit.eval_plan}`,
      `  - Citations: signals ${edit.source_signal_ids.join(", ") || "none"}; events ${edit.source_event_ids.join(", ") || "none"}`,
    ]),
    "",
  ].join("\n");
}

function formatSkillInstruction(content: string): string {
  const trimmed = content.trim();
  if (/^(?:[-*] |\d+\. |#{1,6} |\||```)/.test(trimmed)) {
    return trimmed;
  }
  return `- ${trimmed}`;
}

function findMarkdownHeading(lines: string[], section: string): { index: number; level: number } | undefined {
  const wanted = normalizeHeadingText(section);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match && normalizeHeadingText(match[2] ?? "") === wanted) {
      return { index, level: match[1]!.length };
    }
  }
  return undefined;
}

function findNextHeadingAtOrAbove(lines: string[], start: number, level: number): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
    if (match && match[1]!.length <= level) {
      return index;
    }
  }
  return undefined;
}

function normalizeHeadingText(text: string): string {
  return text.trim().replace(/#+$/, "").trim().toLowerCase();
}

function normalizeSectionTitle(section: string): string {
  const trimmed = section.trim().replace(/^#+\s*/, "");
  if (!trimmed) {
    return "Learned Rules";
  }
  return trimmed
    .split(/\s+/)
    .map((word) => word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word)
    .join(" ");
}

function collapseBlankLines(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function editSourceIndexes(packet: AgenticEvidencePacket, edit: AgenticSkillEditDraft, fallback: number): number[] {
  const indexes = packet.source_events
    .map((event, index) => event.event_id !== undefined && edit.source_event_ids.includes(event.event_id) ? index : undefined)
    .filter((index): index is number => index !== undefined);
  return indexes.length ? indexes : [fallback];
}

function eventSummary(data: JsonObject): string {
  return Object.entries(data)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

function looksLikeWholeTemplateRewrite(content: string): boolean {
  return /^---\s*\n/.test(content) || /# Inferoa (Loop|Workspace) Skill/.test(content) || content.length > MAX_EDIT_CONTENT_LENGTH;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}
