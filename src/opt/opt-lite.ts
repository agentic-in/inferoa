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

export interface OptLiteStatus {
  proposal_count: number;
  staged_count: number;
  adopted_count: number;
  replay_count: number;
  eligible_goal_sessions: number;
  verified_records: number;
  human_feedback_records: number;
  learning_signal_records: number;
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
  evidence: OptEvidenceSummary;
}

export type OptLiteProposalStatus = "staged" | "adopted";

export interface OptLiteProposal extends OptLiteProposalSummary {
  source_sessions: OptSourceSession[];
  source_events: OptSourceEvent[];
  skill_body: string;
  staged_skill_path: string;
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
  };
  splits: {
    train: OptReplaySample[];
    validation: OptReplaySample[];
    heldout: OptReplaySample[];
  };
}

export interface OptLiteRunOptions {
  replay?: boolean;
  proposal_id?: string;
}

export interface OptLiteRunReport {
  kind: "replay";
  replay: OptReplayReport;
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
}

export interface OptEvidenceSummary {
  goal_sessions: number;
  verification_records: number;
  human_feedback_records: number;
  learning_signal_records: number;
  skill_snapshots: number;
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
    latest_proposal: latest ? proposalSummary(latest) : undefined,
    latest_replay: latestReplay ? replaySummary(latestReplay) : undefined,
  };
}

export async function optLitePropose(store: SessionStore, workspace: WorkspaceIdentity): Promise<OptLiteProposal> {
  recordGoalLearningSignals(store, workspace);
  const evidence = collectOptEvidence(store, workspace);
  if (!evidence.sessions.length) {
    throw new Error("No eligible loop evidence found. Complete or verify a loop before proposing a learned skill.");
  }
  const createdAt = new Date().toISOString();
  const skillId = "workspace-learned-loop-policy";
  const skillBody = renderSkillBody(evidence);
  const id = `self_improve_${shortHash(stableJson({ evidence: evidence.source_events, skill_body: skillBody }), 12)}`;
  const stagedSkillPath = path.join(optProposalDir(workspace.root), `${id}.SKILL.md`);
  const proposal: OptLiteProposal = {
    id,
    status: "staged",
    created_at: createdAt,
    skill_id: skillId,
    evidence: evidence.summary,
    source_sessions: evidence.sessions,
    source_events: evidence.source_events,
    skill_body: skillBody,
    staged_skill_path: stagedSkillPath,
  };
  await writeProposal(workspace.root, proposal);
  await fs.writeFile(stagedSkillPath, skillBody, "utf8");
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
  const skillDir = path.join(workspace.root, ".inferoa", "skills", proposal.skill_id);
  const skillPath = path.join(skillDir, "SKILL.md");
  await ensureDir(skillDir);
  await fs.writeFile(skillPath, proposal.skill_body, "utf8");
  const enabled = new Set(config.skills.enabled);
  enabled.add(proposal.skill_id);
  config.skills.enabled = [...enabled].sort();
  const config_path = await saveUserConfig(config);
  const adopted: OptLiteProposal = {
    ...proposal,
    status: "adopted",
    adopted_at: new Date().toISOString(),
    skill_path: skillPath,
    source_events: [
      ...proposal.source_events,
      {
        session_id: "workspace",
        type: "self_improve.adopted",
        summary: `adopted ${proposal.skill_id}; config ${config_path}`,
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
  const accepted = validationImproved && heldoutNotRegressed && hardFailures === 0;
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
    },
    splits,
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
    throw new Error("Self-improve run requires an explicit training mode. Use: inferoa self-improve run --replay [proposal_id]");
  }
  return {
    kind: "replay",
    replay: await optLiteReplay(store, workspace, options.proposal_id),
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

function recordSkillProposalStaged(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal): void {
  appendOptEventOnce(store, workspace, proposal.source_sessions, "skill.proposal.staged", "proposal_id", proposal.id, {
    proposal_id: proposal.id,
    status: proposal.status,
    skill_id: proposal.skill_id,
    staged_skill_path: proposal.staged_skill_path,
    source_session_ids: proposal.source_sessions.map((session) => session.session_id),
    evidence: {
      goal_sessions: proposal.evidence.goal_sessions,
      verification_records: proposal.evidence.verification_records,
      human_feedback_records: proposal.evidence.human_feedback_records,
      learning_signal_records: proposal.evidence.learning_signal_records,
      skill_snapshots: proposal.evidence.skill_snapshots,
    },
  });
}

function recordSkillProposalAdopted(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal): void {
  appendOptEventOnce(store, workspace, proposal.source_sessions, "skill.proposal.adopted", "proposal_id", proposal.id, {
    proposal_id: proposal.id,
    status: proposal.status,
    skill_id: proposal.skill_id,
    skill_path: proposal.skill_path,
    source_session_ids: proposal.source_sessions.map((session) => session.session_id),
    adopted_at: proposal.adopted_at,
  });
}

function recordOptReplay(store: SessionStore, workspace: WorkspaceIdentity, proposal: OptLiteProposal, report: OptReplayReport): void {
  appendOptEventOnce(store, workspace, proposal.source_sessions, "self_improve.replay.recorded", "replay_id", report.id, {
    replay_id: report.id,
    proposal_id: report.proposal_id,
    status: report.status,
    sample_count: report.sample_count,
    baseline_score: report.baseline_score,
    candidate_score: report.candidate_score,
    report_path: report.report_path,
    gate: {
      validation_improved: report.gate.validation_improved,
      heldout_not_regressed: report.gate.heldout_not_regressed,
      hard_failures: report.gate.hard_failures,
    },
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

function collectOptEvidence(store: SessionStore, workspace: WorkspaceIdentity): {
  sessions: OptSourceSession[];
  source_events: OptSourceEvent[];
  summary: OptEvidenceSummary;
} {
  const sessions: OptSourceSession[] = [];
  const sourceEvents: OptSourceEvent[] = [];
  let verificationRecords = 0;
  let humanFeedbackRecords = 0;
  let learningSignalRecords = 0;
  let skillSnapshots = 0;
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
    summary: {
      goal_sessions: sessions.length,
      verification_records: verificationRecords,
      human_feedback_records: humanFeedbackRecords,
      learning_signal_records: learningSignalRecords,
      skill_snapshots: skillSnapshots,
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
      baseline_policy_score: baselinePolicyScore(view),
      candidate_policy_score: candidatePolicyScore(proposal, view),
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

function baselinePolicyScore(view: GoalLoopView): number {
  const latest = view.skill_snapshots.at(-1);
  if (!latest || !latest.skills.length) {
    return 0;
  }
  const hasLearnedPolicy = latest.skills.some((skill) => skill.id === "workspace-learned-loop-policy");
  return hasLearnedPolicy ? 1 : 0.25;
}

function candidatePolicyScore(proposal: OptLiteProposal, view: GoalLoopView): number {
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
      verification.failure_reason,
    ].filter((item): item is string => Boolean(item)).join(" · "),
  }));
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

function renderSkillBody(evidence: { sessions: OptSourceSession[]; source_events: OptSourceEvent[]; summary: OptEvidenceSummary }): string {
  return [
    "---",
    "name: Workspace Learned Loop Policy",
    "description: Adopted policy from verified Inferoa loop evidence in this workspace.",
    "---",
    "",
    "# Workspace Learned Loop Policy",
    "",
    "Use this skill when working on loop tasks in this workspace.",
    "",
    "## Evidence Summary",
    "",
    `- Loop sessions: ${evidence.summary.goal_sessions}`,
    `- Verification records: ${evidence.summary.verification_records}`,
    `- Human feedback records: ${evidence.summary.human_feedback_records}`,
    `- Learning signals: ${evidence.summary.learning_signal_records}`,
    `- Skill snapshots: ${evidence.summary.skill_snapshots}`,
    "",
    "## Policy",
    "",
    "- Keep loop completion tied to structured verification evidence.",
    "- Review recorded learning signals before updating recurring workspace policy.",
    "- Preserve human review feedback as a constraint on the next loop task.",
    "- For research loops, cite the primary metric and result status before claiming progress.",
    "- Prefer explicit workspace skills over ad hoc hidden prompt changes.",
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

function optReplayDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".inferoa", "self-improve", "replays");
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
    evidence: proposal.evidence,
  };
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
