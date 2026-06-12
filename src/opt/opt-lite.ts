import { promises as fs } from "node:fs";
import path from "node:path";
import { saveUserConfig } from "../config/config.js";
import { recordGoalLearningSignals } from "../loop/learning.js";
import { readGoalLoopView } from "../loop/projection.js";
import type { GoalLoopView } from "../loop/types.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { ensureDir } from "../util/fs.js";
import { shortHash, stableJson } from "../util/hash.js";
import {
  buildAgenticEvidencePacket,
  AgenticNoEditsError,
  modelGatewayAgenticOptimizer,
  normalizeAgenticProposalJson,
  renderAgenticSkillTargets,
  type AgenticOptimizerRun,
  type AgenticProposalOptimizer,
  type AgenticProposalOptimizerResult,
  type AgenticProposalSource,
  type AgenticSkillProposalDraft,
  type LoopLearningSignalTier,
} from "./agentic-propose.js";

export interface OptLiteStatus {
  proposal_count: number;
  staged_count: number;
  adopted_count: number;
  replay_count: number;
  eligible_goal_sessions: number;
  verified_records: number;
  human_feedback_records: number;
  learning_signal_records: number;
  skill_body_load_records?: number;
  skill_rule_application_records?: number;
  latest_proposal?: OptLiteProposalSummary;
  latest_replay?: OptReplayReportSummary;
}

export interface OptLiteProposalSummary {
  id: string;
  status: OptLiteProposalStatus;
  created_at: string;
  adopted_at?: string;
  skill_id: string;
  skill_path?: string;
  skill_targets?: OptSkillTargetSummary[];
  proposal_source?: AgenticProposalSource;
  agentic_run?: AgenticOptimizerRun;
  normalization_warnings?: string[];
  evidence: OptEvidenceSummary;
}

export type OptLiteProposalStatus = "staged" | "adopted";

export interface OptLiteProposal extends OptLiteProposalSummary {
  source_sessions: OptSourceSession[];
  source_events: OptSourceEvent[];
  workspace_commands?: OptWorkspaceCommandEvidence[];
  skill_targets?: OptSkillTarget[];
  model_proposal?: AgenticSkillProposalDraft;
  raw_model_proposal?: JsonObject;
  agentic_error?: string;
  skill_body: string;
  staged_skill_path: string;
  skill_paths?: Record<string, string>;
}

export interface OptReplayReportSummary {
  id: string;
  proposal_id: string;
  status: OptReplayStatus;
  created_at: string;
  sample_count: number;
  baseline_score: number;
  candidate_score: number;
  report_path: string;
}

export type OptReplayStatus = "accepted" | "rejected";

export interface OptReplayReport extends OptReplayReportSummary {
  gate: {
    validation_improved: boolean;
    heldout_not_regressed: boolean;
    hard_failures: number;
    edit_gate_passed?: boolean;
  };
  splits: {
    train: OptReplaySample[];
    validation: OptReplaySample[];
    heldout: OptReplaySample[];
  };
  edit_verdicts?: OptReplayEditVerdict[];
}

export interface OptReplayEditVerdict {
  target: OptSkillTargetKind;
  section: string;
  status: "accepted" | "rejected" | "needs_evidence";
  reason: string;
  source_signal_ids: string[];
  source_event_ids: number[];
}

export interface OptLiteRunOptions {
  replay?: boolean;
  proposal_id?: string;
}

export interface OptLiteRunReport {
  kind: "replay";
  replay: OptReplayReport;
}

export interface OptLiteLearnReport {
  kind: "learn";
  proposal: OptLiteProposal;
  replay: OptReplayReport;
}

export interface OptLiteProposeOptions {
  config?: VllmAgentConfig;
  optimizer?: AgenticProposalOptimizer;
  mode?: "auto" | "agentic" | "deterministic_fallback";
}

export interface OptReplaySample {
  session_id: string;
  goal_id: string;
  objective: string;
  split: "train" | "validation" | "heldout";
  verification_records: number;
  pass_records: number;
  fail_records: number;
  blocked_records: number;
  partial_records: number;
  baseline_policy_score: number;
  candidate_policy_score: number;
  target_scores?: OptReplayTargetScore[];
}

export interface OptEvidenceSummary {
  goal_sessions: number;
  verification_records: number;
  human_feedback_records: number;
  learning_signal_records: number;
  skill_snapshots: number;
  skill_body_load_records?: number;
  skill_rule_application_records?: number;
  workspace_command_records?: number;
}

export type OptSkillTargetKind = "loop_skill" | "workspace_skill";

export interface OptSkillTargetSummary {
  target: OptSkillTargetKind;
  skill_id: string;
  staged_skill_path: string;
  skill_path?: string;
  edit_count: number;
}

export interface OptSkillTarget extends OptSkillTargetSummary {
  skill_name: string;
  body: string;
  edits: OptLearningEdit[];
}

export interface OptAdoptPreview {
  proposal_id: string;
  proposal_source?: AgenticProposalSource;
  status: OptLiteProposalStatus;
  latest_replay?: OptReplayReportSummary;
  targets: OptAdoptPreviewTarget[];
}

export interface OptAdoptPreviewTarget {
  target: OptSkillTargetKind;
  skill_id: string;
  skill_name: string;
  staged_skill_path: string;
  body: string;
  line_count: number;
}

export interface OptLearningEdit {
  target: OptSkillTargetKind;
  op: "add" | "replace" | "delete";
  section: string;
  content: string;
  rationale: string;
  source_event_indexes: number[];
}

export interface OptWorkspaceCommandEvidence {
  command: string;
  cwd?: string;
  session_id: string;
  run_id?: string;
  verifier_role?: string;
  verdict: string;
  confidence: string;
}

export interface OptReplayTargetScore {
  target: OptSkillTargetKind;
  baseline_score: number;
  candidate_score: number;
  checks: string[];
}

interface OptSourceSession {
  session_id: string;
  title: string;
  goal_id: string;
  objective: string;
  kind: string;
  verification_count: number;
  skill_snapshot_count: number;
}

interface OptSourceEvent {
  session_id: string;
  event_id?: number;
  run_id?: string;
  type: string;
  summary: string;
}

export async function optLiteStatus(store: SessionStore, workspace: WorkspaceIdentity): Promise<OptLiteStatus> {
  const proposals = await readProposals(workspace.root);
  const replays = await readReplayReports(workspace.root);
  const evidence = collectOptEvidence(store, workspace);
  const latest = proposals.at(-1);
  const latestReplay = replays.at(-1);
  return {
    proposal_count: proposals.length,
    staged_count: proposals.filter((proposal) => proposal.status === "staged").length,
    adopted_count: proposals.filter((proposal) => proposal.status === "adopted").length,
    replay_count: replays.length,
    eligible_goal_sessions: evidence.sessions.length,
    verified_records: evidence.summary.verification_records,
    human_feedback_records: evidence.summary.human_feedback_records,
    learning_signal_records: evidence.summary.learning_signal_records,
    skill_body_load_records: evidence.summary.skill_body_load_records,
    skill_rule_application_records: evidence.summary.skill_rule_application_records,
    latest_proposal: latest ? proposalSummary(latest) : undefined,
    latest_replay: latestReplay ? replaySummary(latestReplay) : undefined,
  };
}

export async function optLitePropose(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: OptLiteProposeOptions = {},
): Promise<OptLiteProposal> {
  recordGoalLearningSignals(store, workspace);
  const evidence = collectOptEvidence(store, workspace);
  if (!evidence.sessions.length) {
    throw new Error("No eligible loop evidence found. Complete or verify a loop before proposing a learned skill.");
  }
  const createdAt = new Date().toISOString();
  const agentic = await tryAgenticSkillTargets(store, workspace, options);
  const targetDrafts = agentic?.targets ?? renderSkillTargets(evidence);
  const proposalSource: AgenticProposalSource = agentic?.source ?? "deterministic_fallback";
  const skillBody = renderCombinedSkillBody(targetDrafts);
  const id = `self_improve_${shortHash(stableJson({
    proposal_source: proposalSource,
    evidence: evidence.source_events,
    workspace_commands: evidence.workspace_commands,
    model_proposal: agentic?.model_proposal,
    raw_model_proposal: agentic?.raw_model_proposal,
    normalization_warnings: agentic?.normalization_warnings,
    agentic_error: agentic?.error,
    skill_targets: targetDrafts.map((target) => ({ target: target.target, skill_id: target.skill_id, body: target.body, edits: target.edits })),
  }), 12)}`;
  const skillTargets = targetDrafts.map((target) => ({
    ...target,
    staged_skill_path: path.join(optProposalArtifactDir(workspace.root, id), stagedTargetFilename(target.target)),
  }));
  const primaryTarget = skillTargets[0]!;
  const proposal: OptLiteProposal = {
    id,
    status: "staged",
    created_at: createdAt,
    skill_id: primaryTarget.skill_id,
    proposal_source: proposalSource,
    evidence: evidence.summary,
    source_sessions: evidence.sessions,
    source_events: evidence.source_events,
    workspace_commands: evidence.workspace_commands,
    skill_targets: skillTargets,
    model_proposal: agentic?.model_proposal,
    raw_model_proposal: agentic?.raw_model_proposal,
    normalization_warnings: agentic?.normalization_warnings,
    agentic_run: agentic?.agentic_run,
    agentic_error: agentic?.error,
    skill_body: skillBody,
    staged_skill_path: primaryTarget.staged_skill_path,
  };
  await writeProposal(workspace.root, proposal);
  for (const target of skillTargets) {
    await ensureDir(path.dirname(target.staged_skill_path));
    await fs.writeFile(target.staged_skill_path, target.body, "utf8");
  }
  recordSkillProposalStaged(store, workspace, proposal);
  return proposal;
}

export async function optLiteAdopt(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  config: VllmAgentConfig,
  proposalId?: string,
): Promise<OptLiteProposal> {
  const proposals = await readProposals(workspace.root);
  const proposal = proposalId
    ? proposals.find((item) => item.id === proposalId)
    : proposals.slice().reverse().find((item) => item.status === "staged");
  if (!proposal) {
    throw new Error(proposalId ? `No proposal found: ${proposalId}` : "No staged self-improve proposal found.");
  }
  const targets = proposalSkillTargets(proposal);
  const skillPaths: Record<string, string> = {};
  const enabled = new Set(config.skills.enabled);
  for (const target of targets) {
    const skillDir = path.join(workspace.root, ".inferoa", "skills", target.skill_id);
    const skillPath = path.join(skillDir, "SKILL.md");
    await ensureDir(skillDir);
    await fs.writeFile(skillPath, target.body, "utf8");
    skillPaths[target.skill_id] = skillPath;
    enabled.add(target.skill_id);
  }
  config.skills.enabled = [...enabled].sort();
  const config_path = await saveUserConfig(config);
  const adoptedTargets = targets.map((target) => ({
    ...target,
    skill_path: skillPaths[target.skill_id],
  }));
  const primaryTarget = adoptedTargets[0]!;
  const adopted: OptLiteProposal = {
    ...proposal,
    status: "adopted",
    adopted_at: new Date().toISOString(),
    skill_id: primaryTarget.skill_id,
    skill_path: primaryTarget.skill_path,
    skill_paths: skillPaths,
    skill_targets: adoptedTargets,
    source_events: [
      ...proposal.source_events,
      {
        session_id: "workspace",
        type: "self_improve.adopted",
        summary: `adopted ${adoptedTargets.map((target) => target.skill_id).join(", ")}; config ${config_path}`,
      },
    ],
  };
  await writeProposal(workspace.root, adopted);
  recordSkillProposalAdopted(store, workspace, adopted);
  store.appendEvent({
    session_id: proposal.source_sessions[0]?.session_id ?? store.createSession(workspace, "self-improve adoption").session_id,
    type: "self_improve.skill.adopted",
    data: {
      proposal_id: adopted.id,
      skill_id: adopted.skill_id,
      skill_path: adopted.skill_path,
      skill_target_ids: adoptedTargets.map((target) => target.skill_id),
      skill_paths: skillPaths,
      config_path,
    },
  });
  return adopted;
}

export async function optLiteReplay(store: SessionStore, workspace: WorkspaceIdentity, proposalId?: string): Promise<OptReplayReport> {
  const proposals = await readProposals(workspace.root);
  const proposal = proposalId
    ? proposals.find((item) => item.id === proposalId)
    : proposals.slice().reverse().find((item) => item.status === "staged") ?? proposals.at(-1);
  if (!proposal) {
    throw new Error(proposalId ? `No proposal found: ${proposalId}` : "No self-improve proposal found.");
  }
  const samples = collectReplaySamples(store, workspace, proposal);
  if (!samples.length) {
    throw new Error("No replay samples found. Record verified loop evidence before running self-improve replay.");
  }
  const splits = splitReplaySamples(samples);
  const validationImproved = averageScore(splits.validation, "candidate_policy_score") > averageScore(splits.validation, "baseline_policy_score");
  const heldoutNotRegressed = averageScore(splits.heldout, "candidate_policy_score") >= averageScore(splits.heldout, "baseline_policy_score");
  const hardFailures = [...splits.validation, ...splits.heldout].reduce((sum, sample) => sum + sample.fail_records + sample.blocked_records, 0);
  const editVerdicts = proposal.model_proposal ? agenticEditVerdicts(store, workspace, proposal) : undefined;
  const editGatePassed = !editVerdicts?.some((verdict) => verdict.status !== "accepted");
  const accepted = validationImproved && heldoutNotRegressed && hardFailures === 0 && editGatePassed;
  const id = `replay_${shortHash(stableJson({ proposal_id: proposal.id, samples }), 12)}`;
  const reportPath = path.join(optReplayDir(workspace.root), `${id}.json`);
  const report: OptReplayReport = {
    id,
    proposal_id: proposal.id,
    status: accepted ? "accepted" : "rejected",
    created_at: new Date().toISOString(),
    sample_count: samples.length,
    baseline_score: averageScore(samples, "baseline_policy_score"),
    candidate_score: averageScore(samples, "candidate_policy_score"),
    report_path: reportPath,
    gate: {
      validation_improved: validationImproved,
      heldout_not_regressed: heldoutNotRegressed,
      hard_failures: hardFailures,
      edit_gate_passed: editVerdicts ? editGatePassed : undefined,
    },
    splits,
    edit_verdicts: editVerdicts,
  };
  await writeReplayReport(workspace.root, report);
  recordOptReplay(store, workspace, proposal, report);
  return report;
}

export async function optLiteRun(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: OptLiteRunOptions,
): Promise<OptLiteRunReport> {
  if (!options.replay) {
    throw new Error("Self-improve run requires an explicit training mode. Use: inferoa self-improve learn for the default flow.");
  }
  return {
    kind: "replay",
    replay: await optLiteReplay(store, workspace, options.proposal_id),
  };
}

export async function optLiteLearn(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: OptLiteProposeOptions = {},
): Promise<OptLiteLearnReport> {
  const proposal = await optLitePropose(store, workspace, options);
  const replay = await optLiteReplay(store, workspace, proposal.id);
  return {
    kind: "learn",
    proposal,
    replay,
  };
}

export async function optLiteReport(workspace: WorkspaceIdentity, replayId?: string): Promise<OptReplayReport> {
  const reports = await readReplayReports(workspace.root);
  const report = replayId
    ? reports.find((item) => item.id === replayId)
    : reports.at(-1);
  if (!report) {
    throw new Error(replayId ? `No self-improve replay report found: ${replayId}` : "No self-improve replay report found.");
  }
  return report;
}

export async function optLiteAdoptPreview(workspace: WorkspaceIdentity, proposalId?: string): Promise<OptAdoptPreview> {
  const proposals = await readProposals(workspace.root);
  const proposal = proposalId
    ? proposals.find((item) => item.id === proposalId)
    : proposals.slice().reverse().find((item) => item.status === "staged");
  if (!proposal) {
    throw new Error(proposalId ? `No proposal found: ${proposalId}` : "No staged self-improve proposal found.");
  }
  const reports = await readReplayReports(workspace.root);
  const latestReplay = reports.slice().reverse().find((report) => report.proposal_id === proposal.id);
  return {
    proposal_id: proposal.id,
    proposal_source: proposal.proposal_source,
    status: proposal.status,
    latest_replay: latestReplay ? replaySummary(latestReplay) : undefined,
    targets: proposalSkillTargets(proposal).map((target) => ({
      target: target.target,
      skill_id: target.skill_id,
      skill_name: target.skill_name,
      staged_skill_path: target.staged_skill_path,
      body: target.body,
      line_count: target.body.split(/\r?\n/).length,
    })),
  };
}

function recordSkillProposalStaged(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal): void {
  const targets = proposalSkillTargets(proposal);
  appendOptEventOnce(store, workspace, proposal.source_sessions, "skill.proposal.staged", "proposal_id", proposal.id, {
    proposal_id: proposal.id,
    status: proposal.status,
    skill_id: proposal.skill_id,
    proposal_source: proposal.proposal_source,
    agentic_run: agenticRunToJson(proposal.agentic_run),
    agentic_error: proposal.agentic_error,
    normalization_warnings: proposal.normalization_warnings,
    skill_target_ids: targets.map((target) => target.skill_id),
    skill_targets: targets.map((target) => ({
      target: target.target,
      skill_id: target.skill_id,
      staged_skill_path: target.staged_skill_path,
      edit_count: target.edit_count,
    })),
    staged_skill_path: proposal.staged_skill_path,
    source_session_ids: proposal.source_sessions.map((session) => session.session_id),
    evidence: {
      goal_sessions: proposal.evidence.goal_sessions,
      verification_records: proposal.evidence.verification_records,
      human_feedback_records: proposal.evidence.human_feedback_records,
      learning_signal_records: proposal.evidence.learning_signal_records,
      skill_snapshots: proposal.evidence.skill_snapshots,
      skill_body_load_records: proposal.evidence.skill_body_load_records,
      skill_rule_application_records: proposal.evidence.skill_rule_application_records,
      workspace_command_records: proposal.evidence.workspace_command_records,
    },
  });
}

function recordSkillProposalAdopted(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal): void {
  const targets = proposalSkillTargets(proposal);
  appendOptEventOnce(store, workspace, proposal.source_sessions, "skill.proposal.adopted", "proposal_id", proposal.id, {
    proposal_id: proposal.id,
    status: proposal.status,
    skill_id: proposal.skill_id,
    proposal_source: proposal.proposal_source,
    agentic_run: agenticRunToJson(proposal.agentic_run),
    skill_path: proposal.skill_path,
    skill_target_ids: targets.map((target) => target.skill_id),
    skill_paths: proposal.skill_paths,
    source_session_ids: proposal.source_sessions.map((session) => session.session_id),
    adopted_at: proposal.adopted_at,
  });
}

function recordOptReplay(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal, report: OptReplayReport): void {
  appendOptEventOnce(store, workspace, proposal.source_sessions, "self_improve.replay.recorded", "replay_id", report.id, {
    replay_id: report.id,
    proposal_id: report.proposal_id,
    status: report.status,
    proposal_source: proposal.proposal_source,
    sample_count: report.sample_count,
    baseline_score: report.baseline_score,
    candidate_score: report.candidate_score,
    report_path: report.report_path,
    gate: {
      validation_improved: report.gate.validation_improved,
      heldout_not_regressed: report.gate.heldout_not_regressed,
      hard_failures: report.gate.hard_failures,
      edit_gate_passed: report.gate.edit_gate_passed,
    },
    edit_verdicts: report.edit_verdicts as unknown as JsonObject[],
    split_counts: {
      train: report.splits.train.length,
      validation: report.splits.validation.length,
      heldout: report.splits.heldout.length,
    },
  });
}

function appendOptEventOnce(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  sourceSessions: OptSourceSession[],
  type: string,
  uniqueKey: string,
  uniqueValue: string,
  data: JsonObject,
): void {
  const sessionId = sourceSessions[0]?.session_id ?? store.createSession(workspace, "self-improve memory").session_id;
  const exists = store
    .listEvents(sessionId)
    .some((event) => event.type === type && event.data[uniqueKey] === uniqueValue);
  if (exists) {
    return;
  }
  store.appendEvent({
    session_id: sessionId,
    type,
    data,
  });
}

async function tryAgenticSkillTargets(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: OptLiteProposeOptions,
): Promise<{
  source: AgenticProposalSource;
  targets: OptSkillTarget[];
  model_proposal?: AgenticSkillProposalDraft;
  raw_model_proposal?: JsonObject;
  normalization_warnings?: string[];
  agentic_run?: AgenticOptimizerRun;
  error?: string;
} | undefined> {
  if (options.mode === "deterministic_fallback") {
    return undefined;
  }
  const optimizer = options.optimizer ?? (options.config ? modelGatewayAgenticOptimizer(options.config) : undefined);
  if (!optimizer) {
    return undefined;
  }
  try {
    const packet = buildAgenticEvidencePacket(store, workspace);
    const result = unwrapAgenticOptimizerResult(await optimizer.propose(packet));
    const normalized = normalizeAgenticProposalJson(result.draft);
    const normalizationWarnings = uniqueStrings([
      ...(result.normalization_warnings ?? []),
      ...normalized.normalization_warnings,
    ]);
    const rendered = renderAgenticSkillTargets(packet, normalized.draft, await readExistingLearnedSkillBodies(workspace.root));
    return {
      source: "agentic",
      targets: rendered.targets,
      model_proposal: rendered.proposal,
      raw_model_proposal: result.raw_proposal ?? normalized.raw_proposal,
      normalization_warnings: normalizationWarnings.length ? normalizationWarnings : undefined,
      agentic_run: result.run,
    };
  } catch (error) {
    if (error instanceof AgenticNoEditsError) {
      throw error;
    }
    if (isAgenticOptimizerInterrupted(error)) {
      throw error;
    }
    if (options.mode === "agentic") {
      throw error;
    }
    return {
      source: "deterministic_fallback",
      targets: renderSkillTargets(collectOptEvidence(store, workspace)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isAgenticOptimizerInterrupted(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|user exited tui|interrupted/i.test(error.message);
  }
  return /aborted|user exited tui|interrupted/i.test(String(error));
}

async function readExistingLearnedSkillBodies(workspaceRoot: string): Promise<Partial<Record<OptSkillTargetKind, string>>> {
  const entries: Array<[OptSkillTargetKind, string]> = [
    ["loop_skill", path.join(workspaceRoot, ".inferoa", "skills", "inferoa-loop-skill", "SKILL.md")],
    ["workspace_skill", path.join(workspaceRoot, ".inferoa", "skills", "inferoa-workspace-skill", "SKILL.md")],
  ];
  const output: Partial<Record<OptSkillTargetKind, string>> = {};
  for (const [target, file] of entries) {
    const body = await fs.readFile(file, "utf8").catch(() => undefined);
    if (body?.trim()) {
      output[target] = body;
    }
  }
  return output;
}

function unwrapAgenticOptimizerResult(result: AgenticProposalOptimizerResult): {
  draft: AgenticSkillProposalDraft;
  raw_proposal?: JsonObject;
  normalization_warnings?: string[];
  run?: AgenticOptimizerRun;
} {
  if (typeof result === "object" && result !== null && "draft" in result) {
    return {
      draft: result.draft,
      raw_proposal: result.raw_proposal,
      normalization_warnings: result.normalization_warnings,
      run: result.run,
    };
  }
  return { draft: result };
}

function agenticRunToJson(run: AgenticOptimizerRun | undefined): JsonObject | undefined {
  return run ? {
    session_id: run.session_id,
    run_id: run.run_id,
    title: run.title,
    request_class: run.request_class,
  } : undefined;
}

function agenticEditVerdicts(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  proposal: OptLiteProposal,
): OptReplayEditVerdict[] {
  const packet = buildAgenticEvidencePacket(store, workspace);
  const tiers = new Map(packet.signals.map((signal) => [signal.signal_id, signal.tier]));
  const eventTypes = new Map(packet.source_events
    .filter((event) => event.event_id !== undefined)
    .map((event) => [event.event_id!, event.type]));
  return (proposal.model_proposal?.edits ?? []).map((edit) => {
    const citedTiers = edit.source_signal_ids
      .map((signalId) => tiers.get(signalId))
      .filter((tier): tier is LoopLearningSignalTier => Boolean(tier));
    const citesVerifierEvent = edit.source_event_ids.some((eventId) => eventTypes.get(eventId) === "goal.verification.recorded");
    if (citedTiers.some((tier) => tier === "T0" || tier === "T1") || citesVerifierEvent) {
      return {
        target: edit.target,
        section: edit.section,
        status: "accepted",
        reason: "Edit cites T0/T1 verifier or human evidence.",
        source_signal_ids: edit.source_signal_ids,
        source_event_ids: edit.source_event_ids,
      };
    }
    if (citedTiers.length) {
      return {
        target: edit.target,
        section: edit.section,
        status: "needs_evidence",
        reason: `Edit cites only ${[...new Set(citedTiers)].join("/")} soft evidence; hard evidence is required for acceptance.`,
        source_signal_ids: edit.source_signal_ids,
        source_event_ids: edit.source_event_ids,
      };
    }
    return {
      target: edit.target,
      section: edit.section,
      status: "rejected",
      reason: "Edit citations were not found in the replay evidence packet.",
      source_signal_ids: edit.source_signal_ids,
      source_event_ids: edit.source_event_ids,
    };
  });
}

function collectOptEvidence(store: SessionStore, workspace: WorkspaceIdentity): {
  sessions: OptSourceSession[];
  source_events: OptSourceEvent[];
  workspace_commands: OptWorkspaceCommandEvidence[];
  summary: OptEvidenceSummary;
} {
  const sessions: OptSourceSession[] = [];
  const sourceEvents: OptSourceEvent[] = [];
  const workspaceCommands = new Map<string, OptWorkspaceCommandEvidence>();
  let verificationRecords = 0;
  let humanFeedbackRecords = 0;
  let learningSignalRecords = 0;
  let skillSnapshots = 0;
  let skillBodyLoadRecords = 0;
  let skillRuleApplicationRecords = 0;
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    const view = readGoalLoopView(store, session.session_id);
    if (!view.goal) {
      continue;
    }
    const reviewEvents = store
      .listEvents(session.session_id)
      .filter((event) => event.type === "goal.review.resolved" && typeof event.data.feedback === "string" && event.data.feedback.trim());
    if (!view.verifications.length && !reviewEvents.length && !view.learning_signals.length) {
      continue;
    }
    sessions.push({
      session_id: session.session_id,
      title: session.title,
      goal_id: view.goal.id,
      objective: view.goal.objective,
      kind: view.goal.kind,
      verification_count: view.verifications.length,
      skill_snapshot_count: view.skill_snapshots.length,
    });
    verificationRecords += view.verifications.length;
    learningSignalRecords += view.learning_signals.length;
    skillSnapshots += view.skill_snapshots.length;
    skillBodyLoadRecords += view.skill_body_loads.length;
    skillRuleApplicationRecords += view.skill_rule_applications.length;
    for (const command of workspaceCommandEvidence(view, session.session_id)) {
      workspaceCommands.set(`${command.command}:${command.cwd ?? ""}:${command.session_id}:${command.run_id ?? ""}`, command);
    }
    sourceEvents.push(...verificationEvents(view, session.session_id));
    sourceEvents.push(...learningSignalEvents(view, session.session_id));
    for (const event of reviewEvents) {
      humanFeedbackRecords += 1;
      sourceEvents.push({
        session_id: session.session_id,
        event_id: event.id,
        run_id: event.run_id,
        type: event.type,
        summary: `human feedback: ${String(event.data.feedback)}`,
      });
    }
  }
  return {
    sessions,
    source_events: sourceEvents.slice(0, 60),
    workspace_commands: [...workspaceCommands.values()].sort((left, right) =>
      left.command.localeCompare(right.command) || (left.cwd ?? "").localeCompare(right.cwd ?? "") || left.session_id.localeCompare(right.session_id)
    ).slice(0, 20),
    summary: {
      goal_sessions: sessions.length,
      verification_records: verificationRecords,
      human_feedback_records: humanFeedbackRecords,
      learning_signal_records: learningSignalRecords,
      skill_snapshots: skillSnapshots,
      skill_body_load_records: skillBodyLoadRecords,
      skill_rule_application_records: skillRuleApplicationRecords,
      workspace_command_records: workspaceCommands.size,
    },
  };
}

function collectReplaySamples(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal): OptReplaySample[] {
  const samples: OptReplaySample[] = [];
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    const view = readGoalLoopView(store, session.session_id);
    if (!view.goal || !view.verifications.length) {
      continue;
    }
    const counts = verificationCounts(view);
    samples.push({
      session_id: session.session_id,
      goal_id: view.goal.id,
      objective: view.goal.objective,
      split: "train",
      verification_records: view.verifications.length,
      pass_records: counts.pass,
      fail_records: counts.fail,
      blocked_records: counts.blocked,
      partial_records: counts.partial,
      baseline_policy_score: baselinePolicyScore(proposal, view),
      candidate_policy_score: candidatePolicyScore(proposal, view),
      target_scores: replayTargetScores(proposal, view),
    });
  }
  return samples.sort((left, right) => left.session_id.localeCompare(right.session_id));
}

function verificationCounts(view: GoalLoopView): { pass: number; fail: number; blocked: number; partial: number } {
  return {
    pass: view.verifications.filter((verification) => verification.verdict === "pass").length,
    fail: view.verifications.filter((verification) => verification.verdict === "fail").length,
    blocked: view.verifications.filter((verification) => verification.verdict === "blocked").length,
    partial: view.verifications.filter((verification) => verification.verdict === "partial").length,
  };
}

function baselinePolicyScore(proposal: OptLiteProposal, view: GoalLoopView): number {
  const targetScores = replayTargetScores(proposal, view);
  if (targetScores.length) {
    return targetScores.reduce((sum, score) => sum + score.baseline_score, 0) / targetScores.length;
  }
  const latest = view.skill_snapshots.at(-1);
  if (!latest || !latest.skills.length) {
    return 0;
  }
  const hasLearnedPolicy = latest.skills.some((skill) => skill.id === "workspace-learned-loop-policy");
  return hasLearnedPolicy ? 1 : 0.25;
}

function candidatePolicyScore(proposal: OptLiteProposal, view: GoalLoopView): number {
  const targetScores = replayTargetScores(proposal, view);
  if (targetScores.length) {
    return targetScores.reduce((sum, score) => sum + score.candidate_score, 0) / targetScores.length;
  }
  const body = proposal.skill_body.toLowerCase();
  let score = 0;
  if (proposal.source_sessions.some((session) => session.session_id === view.session_id)) {
    score += 0.35;
  }
  if (body.includes("structured verification evidence")) {
    score += 0.25;
  }
  if (body.includes("human review feedback")) {
    score += 0.2;
  }
  if (body.includes("learning signals")) {
    score += 0.1;
  }
  if (body.includes("primary metric")) {
    score += 0.2;
  }
  return Math.min(1, score);
}

function replayTargetScores(proposal: OptLiteProposal, view: GoalLoopView): OptReplayTargetScore[] {
  return proposalSkillTargets(proposal).map((target) => {
    if (target.target === "loop_skill") {
      return loopSkillReplayScore(target, proposal, view);
    }
    return workspaceSkillReplayScore(target, view);
  });
}

function loopSkillReplayScore(target: OptSkillTarget, proposal: OptLiteProposal, view: GoalLoopView): OptReplayTargetScore {
  const body = target.body.toLowerCase();
  const latest = view.skill_snapshots.at(-1);
  const baseline = latest?.skills.some((skill) => skill.id === target.skill_id || skill.id === "workspace-learned-loop-policy") ? 1 : 0;
  let candidate = 0;
  const checks: string[] = [];
  if (proposal.source_sessions.some((session) => session.session_id === view.session_id)) {
    candidate += 0.2;
    checks.push("source-session-covered");
  }
  if (body.includes("soft-only") && view.verifications.some((verification) => verification.confidence === "soft")) {
    candidate += 0.25;
    checks.push("soft-only-completion-rule");
  }
  if (body.includes("fail, blocked, or partial") && view.verifications.some((verification) => verification.verdict === "fail" || verification.verdict === "blocked" || verification.verdict === "partial")) {
    candidate += 0.25;
    checks.push("non-pass-verifier-rule");
  }
  if (body.includes("human feedback") && proposal.evidence.human_feedback_records > 0) {
    candidate += 0.2;
    checks.push("human-feedback-rule");
  }
  if (body.includes("verifier-backed evidence") || body.includes("command, checker")) {
    candidate += 0.2;
    checks.push("verifier-backed-completion-rule");
  }
  return {
    target: "loop_skill",
    baseline_score: baseline,
    candidate_score: Math.min(1, candidate),
    checks,
  };
}

function workspaceSkillReplayScore(target: OptSkillTarget, view: GoalLoopView): OptReplayTargetScore {
  const body = target.body;
  const latest = view.skill_snapshots.at(-1);
  const baseline = latest?.skills.some((skill) => skill.id === target.skill_id) ? 1 : 0;
  const commands = uniqueCommands(workspaceCommandEvidence(view, view.session_id));
  let candidate = 0;
  const checks: string[] = [];
  if (commands.length) {
    for (const command of commands.slice(0, 3)) {
      if (body.includes(command.command)) {
        candidate += 0.3;
        checks.push(`command:${command.command}`);
      }
    }
    if (body.includes("observed verifier command")) {
      candidate += 0.2;
      checks.push("observed-verifier-command-rule");
    }
  } else if (body.includes("inspect verifier history")) {
    candidate += 0.25;
    checks.push("no-command-evidence-guard");
  }
  return {
    target: "workspace_skill",
    baseline_score: baseline,
    candidate_score: Math.min(1, candidate),
    checks,
  };
}

function splitReplaySamples(samples: OptReplaySample[]): OptReplayReport["splits"] {
  const trainEnd = Math.max(1, Math.floor(samples.length * 0.6));
  const validationEnd = Math.max(trainEnd + 1, Math.floor(samples.length * 0.8));
  return {
    train: samples.slice(0, trainEnd).map((sample) => ({ ...sample, split: "train" })),
    validation: samples.slice(trainEnd, validationEnd).map((sample) => ({ ...sample, split: "validation" })),
    heldout: samples.slice(validationEnd).map((sample) => ({ ...sample, split: "heldout" })),
  };
}

function averageScore(samples: OptReplaySample[], key: "baseline_policy_score" | "candidate_policy_score"): number {
  if (!samples.length) {
    return 0;
  }
  return samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
}

function verificationEvents(view: GoalLoopView, sessionId: string): OptSourceEvent[] {
  return view.verifications.map((verification) => ({
    session_id: sessionId,
    run_id: verification.run_id,
    type: `${verification.provider}.verification`,
    summary: [
      verification.provider,
      verification.verdict,
      verification.confidence,
      verification.horizon_generation !== undefined ? `loop task ${verification.horizon_generation}` : undefined,
      metricSummary(verification.metrics),
      verificationEvidenceSummary(verification.evidence),
      verification.failure_reason,
    ].filter((item): item is string => Boolean(item)).join(" · "),
  }));
}

function workspaceCommandEvidence(view: GoalLoopView, sessionId: string): OptWorkspaceCommandEvidence[] {
  return view.verifications.flatMap((verification) => {
    const command = cleanString(verification.evidence?.command);
    if (!command) {
      return [];
    }
    return [{
      command,
      cwd: cleanString(verification.evidence?.cwd),
      session_id: sessionId,
      run_id: verification.run_id,
      verifier_role: verification.verifier_role,
      verdict: verification.verdict,
      confidence: verification.confidence,
    }];
  });
}

function learningSignalEvents(view: GoalLoopView, sessionId: string): OptSourceEvent[] {
  return view.learning_signals.map((signal) => ({
    session_id: sessionId,
    event_id: signal.source_event_id,
    run_id: signal.source_run_id,
    type: `learning_signal.${signal.category}`,
    summary: `${signal.polarity} · ${signal.summary}`,
  }));
}

function metricSummary(metrics: JsonObject | undefined): string | undefined {
  if (!metrics) {
    return undefined;
  }
  const primary = typeof metrics.primary_metric === "string" ? metrics.primary_metric : undefined;
  const metric = typeof metrics.metric === "number" || typeof metrics.metric === "string" ? String(metrics.metric) : undefined;
  return primary && metric ? `${primary}=${metric}` : metric;
}

function verificationEvidenceSummary(evidence: JsonObject | undefined): string | undefined {
  if (!evidence) {
    return undefined;
  }
  const command = cleanString(evidence.command);
  if (command) {
    const cwd = cleanString(evidence.cwd);
    const status = cleanString(evidence.status);
    return ["command", command, cwd ? `cwd ${cwd}` : undefined, status ? `status ${status}` : undefined].filter((item): item is string => Boolean(item)).join(" ");
  }
  const verifier = cleanString(evidence.verifier) ?? cleanString(evidence.verifier_id);
  return verifier ? `verifier ${verifier}` : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function renderSkillTargets(evidence: {
  sessions: OptSourceSession[];
  source_events: OptSourceEvent[];
  workspace_commands: OptWorkspaceCommandEvidence[];
  summary: OptEvidenceSummary;
}): OptSkillTarget[] {
  const loopEdits = loopSkillEdits(evidence);
  const workspaceEdits = workspaceSkillEdits(evidence);
  const loopBody = renderLoopSkillBody(evidence, loopEdits);
  const workspaceBody = renderWorkspaceSkillBody(evidence, workspaceEdits);
  return [
    {
      target: "loop_skill",
      skill_id: "inferoa-loop-skill",
      skill_name: "Inferoa Loop Skill",
      staged_skill_path: "",
      edit_count: loopEdits.length,
      edits: loopEdits,
      body: loopBody,
    },
    {
      target: "workspace_skill",
      skill_id: "inferoa-workspace-skill",
      skill_name: "Inferoa Workspace Skill",
      staged_skill_path: "",
      edit_count: workspaceEdits.length,
      edits: workspaceEdits,
      body: workspaceBody,
    },
  ];
}

function loopSkillEdits(evidence: { source_events: OptSourceEvent[]; summary: OptEvidenceSummary }): OptLearningEdit[] {
  const edits: OptLearningEdit[] = [
    {
      target: "loop_skill",
      op: "add",
      section: "completion",
      content: "When completion evidence is reflection-only or otherwise soft-only completion evidence, do not mark the loop complete until a command, checker, research metric, or explicit human approval verifies the result.",
      rationale: "Loop completion should be tied to verifier-backed evidence instead of the agent's own reflection.",
      source_event_indexes: sourceIndexes(evidence.source_events, (event) => event.summary.includes("soft") || event.summary.includes("reflection")),
    },
    {
      target: "loop_skill",
      op: "add",
      section: "verification",
      content: "When a verifier returns fail, blocked, or partial, choose continue, pause, or expand instead of done, and preserve the verifier failure reason in the next loop state.",
      rationale: "Failed and blocked verifier outcomes are control signals, not completion evidence.",
      source_event_indexes: sourceIndexes(evidence.source_events, (event) => /\b(fail|blocked|partial)\b/.test(event.summary)),
    },
  ];
  if (evidence.summary.human_feedback_records > 0) {
    edits.push({
      target: "loop_skill",
      op: "add",
      section: "review",
      content: "When human feedback revises, rejects, or blocks a loop decision, carry that feedback as a constraint for the next horizon and cite it before claiming completion.",
      rationale: "Human review is the highest-quality correction signal for future loop control.",
      source_event_indexes: sourceIndexes(evidence.source_events, (event) => event.type === "goal.review.resolved" || event.summary.includes("human feedback")),
    });
  }
  return edits.map((edit) => ({
    ...edit,
    source_event_indexes: edit.source_event_indexes.length ? edit.source_event_indexes : [0].filter((index) => evidence.source_events[index]),
  }));
}

function workspaceSkillEdits(evidence: {
  source_events: OptSourceEvent[];
  workspace_commands: OptWorkspaceCommandEvidence[];
}): OptLearningEdit[] {
  const commands = uniqueCommands(evidence.workspace_commands);
  if (!commands.length) {
    return [{
      target: "workspace_skill",
      op: "add",
      section: "repo_conventions",
      content: "When a loop touches this workspace, inspect verifier history and project scripts before inventing a new validation command.",
      rationale: "No stable command verifier has enough evidence yet, so the workspace skill should avoid pretending a command rule is proven.",
      source_event_indexes: sourceIndexes(evidence.source_events, (event) => event.type.includes("verification")),
    }];
  }
  return commands.slice(0, 5).map((command) => ({
    target: "workspace_skill",
    op: "add",
    section: "testing",
    content: `When code or documentation changes need repo validation, prefer the observed verifier command \`${command.command}\`${command.cwd ? ` from \`${command.cwd}\`` : ""} before claiming completion.`,
    rationale: `This command appeared in verifier evidence with ${command.confidence} confidence and ${command.verdict} verdict.`,
    source_event_indexes: sourceIndexes(evidence.source_events, (event) => event.summary.includes(command.command)),
  }));
}

function renderCombinedSkillBody(targets: OptSkillTarget[]): string {
  return targets.map((target) => target.body).join("\n\n---\n\n");
}

function renderLoopSkillBody(
  evidence: { sessions: OptSourceSession[]; source_events: OptSourceEvent[]; summary: OptEvidenceSummary },
  edits: OptLearningEdit[],
): string {
  return [
    "---",
    "name: Inferoa Loop Skill",
    "description: Per-workspace loop-control policy learned from verified Inferoa loop evidence.",
    "---",
    "",
    "# Inferoa Loop Skill",
    "",
    "Use this skill when making `/loop` control decisions in this workspace.",
    "",
    "## Evidence Summary",
    "",
    `- Loop sessions: ${evidence.summary.goal_sessions}`,
    `- Verification records: ${evidence.summary.verification_records}`,
    `- Human feedback records: ${evidence.summary.human_feedback_records}`,
    `- Learning signals: ${evidence.summary.learning_signal_records}`,
    `- Skill snapshots: ${evidence.summary.skill_snapshots}`,
    `- Skill body loads: ${evidence.summary.skill_body_load_records ?? 0}`,
    `- Skill rule applications: ${evidence.summary.skill_rule_application_records ?? 0}`,
    "",
    "## Controller Rules",
    "",
    ...edits.map((edit) => `- ${edit.content}`),
    "",
    "## Source Sessions",
    "",
    ...evidence.sessions.map((session) => `- ${session.session_id}: ${session.objective} (${session.kind}, ${session.verification_count} verification records)`),
    "",
    "## Citations",
    "",
    ...evidence.source_events.map((event) => `- ${event.session_id}${event.event_id ? `#${event.event_id}` : ""}${event.run_id ? ` run ${event.run_id}` : ""}: ${event.summary}`),
    "",
  ].join("\n");
}

function renderWorkspaceSkillBody(
  evidence: {
    sessions: OptSourceSession[];
    source_events: OptSourceEvent[];
    workspace_commands: OptWorkspaceCommandEvidence[];
    summary: OptEvidenceSummary;
  },
  edits: OptLearningEdit[],
): string {
  const commands = uniqueCommands(evidence.workspace_commands);
  return [
    "---",
    "name: Inferoa Workspace Skill",
    "description: Per-workspace development workflow learned from verified Inferoa loop evidence.",
    "---",
    "",
    "# Inferoa Workspace Skill",
    "",
    "Use this skill when code, documentation, release, test, or review work touches this workspace.",
    "",
    "## Evidence Summary",
    "",
    `- Loop sessions: ${evidence.summary.goal_sessions}`,
    `- Verification records: ${evidence.summary.verification_records}`,
    `- Skill body loads: ${evidence.summary.skill_body_load_records ?? 0}`,
    `- Skill rule applications: ${evidence.summary.skill_rule_application_records ?? 0}`,
    `- Workspace command records: ${evidence.summary.workspace_command_records ?? commands.length}`,
    "",
    "## Workspace Rules",
    "",
    ...edits.map((edit) => `- ${edit.content}`),
    "",
    "## Observed Verifier Commands",
    "",
    ...(commands.length
      ? commands.map((command) => `- \`${command.command}\`${command.cwd ? ` in \`${command.cwd}\`` : ""} (${command.verdict}, ${command.confidence})`)
      : ["- No stable command verifier has been observed yet."]),
    "",
    "## Source Sessions",
    "",
    ...evidence.sessions.map((session) => `- ${session.session_id}: ${session.objective} (${session.kind}, ${session.verification_count} verification records)`),
    "",
    "## Citations",
    "",
    ...evidence.source_events.map((event) => `- ${event.session_id}${event.event_id ? `#${event.event_id}` : ""}${event.run_id ? ` run ${event.run_id}` : ""}: ${event.summary}`),
    "",
  ].join("\n");
}

function optProposalDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".inferoa", "self-improve", "proposals");
}

function optProposalArtifactDir(workspaceRoot: string, proposalId: string): string {
  return path.join(optProposalDir(workspaceRoot), proposalId);
}

function stagedTargetFilename(target: OptSkillTargetKind): string {
  return target === "loop_skill" ? "proposed.loop.SKILL.md" : "proposed.workspace.SKILL.md";
}

function optReplayDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".inferoa", "self-improve", "replays");
}

function proposalSkillTargets(proposal: OptLiteProposal): OptSkillTarget[] {
  if (proposal.skill_targets?.length) {
    return proposal.skill_targets;
  }
  return [{
    target: "loop_skill",
    skill_id: proposal.skill_id,
    skill_name: proposal.skill_id,
    staged_skill_path: proposal.staged_skill_path,
    skill_path: proposal.skill_path,
    edit_count: 0,
    edits: [],
    body: proposal.skill_body,
  }];
}

function uniqueCommands(commands: OptWorkspaceCommandEvidence[]): OptWorkspaceCommandEvidence[] {
  const seen = new Set<string>();
  const output: OptWorkspaceCommandEvidence[] = [];
  for (const command of commands) {
    const key = `${command.command}:${command.cwd ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(command);
  }
  return output.sort((left, right) => left.command.localeCompare(right.command) || (left.cwd ?? "").localeCompare(right.cwd ?? ""));
}

function sourceIndexes(events: OptSourceEvent[], predicate: (event: OptSourceEvent) => boolean): number[] {
  return events
    .map((event, index) => predicate(event) ? index : undefined)
    .filter((index): index is number => index !== undefined)
    .slice(0, 12);
}

async function readProposals(workspaceRoot: string): Promise<OptLiteProposal[]> {
  const dir = optProposalDir(workspaceRoot);
  const entries = await fs.readdir(dir).catch(() => []);
  const proposals: OptLiteProposal[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as OptLiteProposal;
    proposals.push(parsed);
  }
  return proposals.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function writeProposal(workspaceRoot: string, proposal: OptLiteProposal): Promise<void> {
  const dir = optProposalDir(workspaceRoot);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, `${proposal.id}.json`), `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

async function readReplayReports(workspaceRoot: string): Promise<OptReplayReport[]> {
  const dir = optReplayDir(workspaceRoot);
  const entries = await fs.readdir(dir).catch(() => []);
  const reports: OptReplayReport[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
    reports.push(JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as OptReplayReport);
  }
  return reports.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function writeReplayReport(workspaceRoot: string, report: OptReplayReport): Promise<void> {
  const dir = optReplayDir(workspaceRoot);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function proposalSummary(proposal: OptLiteProposal): OptLiteProposalSummary {
  return {
    id: proposal.id,
    status: proposal.status,
    created_at: proposal.created_at,
    adopted_at: proposal.adopted_at,
    skill_id: proposal.skill_id,
    skill_path: proposal.skill_path,
    proposal_source: proposal.proposal_source,
    agentic_run: proposal.agentic_run,
    normalization_warnings: proposal.normalization_warnings,
    skill_targets: proposalSkillTargets(proposal).map((target) => ({
      target: target.target,
      skill_id: target.skill_id,
      staged_skill_path: target.staged_skill_path,
      skill_path: target.skill_path,
      edit_count: target.edit_count,
    })),
    evidence: proposal.evidence,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function replaySummary(report: OptReplayReport): OptReplayReportSummary {
  return {
    id: report.id,
    proposal_id: report.proposal_id,
    status: report.status,
    created_at: report.created_at,
    sample_count: report.sample_count,
    baseline_score: report.baseline_score,
    candidate_score: report.candidate_score,
    report_path: report.report_path,
  };
}
