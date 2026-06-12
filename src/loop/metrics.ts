import type { AutomationSchedule, DiscoveryCandidate, DiscoverySchedule, ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, SessionEvent, SessionRecord, WorkspaceIdentity } from "../types.js";
import { readGoalState } from "../goals/state.js";
import type { GoalRecord } from "../goals/state.js";
import type { GoalLoopVerification } from "./types.js";
import { readGoalVerificationRecords } from "./verification.js";

export interface LoopTokenMetrics {
  model_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  cache_hit_rate?: number;
}

export interface LoopVerificationMetrics {
  total: number;
  pass: number;
  fail: number;
  partial: number;
  blocked: number;
  unknown: number;
  hard_pass: number;
  pass_rate?: number;
  hard_pass_rate?: number;
  latest_at?: string;
}

export interface LoopLearningSignalMetrics {
  total: number;
  positive: number;
  negative: number;
  constraint: number;
  by_category: Record<string, number>;
  by_polarity: Record<string, number>;
  latest_at?: string;
}

export interface LoopMetricsGroup {
  key: string;
  label?: string;
  sessions: number;
  runs: number;
  tokens: LoopTokenMetrics;
  verification: LoopVerificationMetrics;
}

export interface LoopDailyMetrics {
  date: string;
  tokens: LoopTokenMetrics;
  verification: LoopVerificationMetrics;
  checker: LoopVerificationMetrics;
}

export interface LoopMetricsReport {
  workspace_id: string;
  workspace_root: string;
  generated_at: string;
  totals: {
    sessions: number;
    runs: number;
    goals: number;
    model_calls: number;
    verifications: number;
  };
  tokens: LoopTokenMetrics;
  verification: {
    summary: LoopVerificationMetrics;
    by_provider: LoopMetricsGroup[];
    checker_effectiveness: LoopVerificationMetrics;
  };
  learning_signals: LoopLearningSignalMetrics;
  trends: {
    daily: LoopDailyMetrics[];
  };
  by_goal: LoopMetricsGroup[];
  by_source: LoopMetricsGroup[];
  by_system: LoopMetricsGroup[];
  by_worktree: LoopMetricsGroup[];
  by_request_class: LoopMetricsGroup[];
}

interface TokenObservation {
  session_id: string;
  run_id?: string;
  request_class?: string;
  created_at?: string;
  usage: JsonObject;
}

interface Attribution {
  goal_key: string;
  goal_label?: string;
  source_key: string;
  source_label?: string;
  system_key: string;
  system_label?: string;
  worktree_key: string;
  worktree_label?: string;
  request_class_key: string;
}

interface MutableGroup extends LoopMetricsGroup {
  sessionIds: Set<string>;
  runIds: Set<string>;
}

interface MutableDaily extends LoopDailyMetrics {
}

interface AttributionContext {
  goalsBySession: Map<string, GoalRecord>;
  goalsById: Map<string, GoalRecord>;
  jobsByRun: Map<string, SupervisorJob>;
  jobsBySession: Map<string, SupervisorJob[]>;
  automationById: Map<string, AutomationSchedule>;
  discoveryById: Map<string, DiscoverySchedule>;
  candidatesById: Map<string, DiscoveryCandidate>;
  worktreesById: Map<string, ManagedWorktree>;
  worktreesByJob: Map<string, ManagedWorktree>;
  worktreesBySession: Map<string, ManagedWorktree[]>;
}

export function readLoopMetrics(store: SessionStore, workspace: WorkspaceIdentity): LoopMetricsReport {
  const sessions = store.listSessions(workspace.id, { includeArchived: true });
  const sessionIds = new Set(sessions.map((session) => session.session_id));
  const context = buildAttributionContext(store, workspace, sessions);
  const tokenGroups = {
    goal: new Map<string, MutableGroup>(),
    source: new Map<string, MutableGroup>(),
    system: new Map<string, MutableGroup>(),
    worktree: new Map<string, MutableGroup>(),
    requestClass: new Map<string, MutableGroup>(),
    provider: new Map<string, MutableGroup>(),
  };
  const daily = new Map<string, MutableDaily>();
  const totals = emptyTokenMetrics();
  let runIds = new Set<string>();
  let modelCalls = 0;

  for (const session of sessions) {
    for (const observation of tokenObservations(store, session)) {
      const usage = normalizeUsage(observation.usage);
      const attribution = attributeObservation(context, observation);
      modelCalls += usage.model_calls;
      addTokens(totals, usage);
      if (observation.run_id) {
        runIds.add(observation.run_id);
      }
      addTokenGroup(tokenGroups.goal, attribution.goal_key, attribution.goal_label, observation, usage);
      addTokenGroup(tokenGroups.source, attribution.source_key, attribution.source_label, observation, usage);
      addTokenGroup(tokenGroups.system, attribution.system_key, attribution.system_label, observation, usage);
      addTokenGroup(tokenGroups.worktree, attribution.worktree_key, attribution.worktree_label, observation, usage);
      addTokenGroup(tokenGroups.requestClass, attribution.request_class_key, undefined, observation, usage);
      const date = dayKey(observation.created_at);
      if (date) {
        addTokens(getDaily(daily, date).tokens, usage);
      }
    }
  }

  const verificationSummary = emptyVerificationMetrics();
  const checkerSummary = emptyVerificationMetrics();
  const learningSignalSummary = emptyLearningSignalMetrics();
  for (const session of sessions) {
    const verifications = readGoalVerificationRecords(store, session.session_id);
    for (const record of verifications) {
      const attribution = attributeVerification(context, session.session_id, record);
      addVerification(verificationSummary, record);
      if (record.provider === "checker") {
        addVerification(checkerSummary, record);
      }
      addVerificationGroup(tokenGroups.goal, attribution.goal_key, attribution.goal_label, session.session_id, record.run_id, record);
      addVerificationGroup(tokenGroups.source, attribution.source_key, attribution.source_label, session.session_id, record.run_id, record);
      addVerificationGroup(tokenGroups.system, attribution.system_key, attribution.system_label, session.session_id, record.run_id, record);
      addVerificationGroup(tokenGroups.worktree, attribution.worktree_key, attribution.worktree_label, session.session_id, record.run_id, record);
      addVerificationGroup(tokenGroups.provider, record.provider, undefined, session.session_id, record.run_id, record);
      const date = dayKey(record.created_at);
      if (date) {
        const bucket = getDaily(daily, date);
        addVerification(bucket.verification, record);
        if (record.provider === "checker") {
          addVerification(bucket.checker, record);
        }
      }
    }
    for (const event of store.listEvents(session.session_id).filter((item) => item.type === "goal.learning_signal.recorded")) {
      addLearningSignal(learningSignalSummary, event);
    }
  }

  finalizeTokens(totals);
  finalizeVerification(verificationSummary);
  finalizeVerification(checkerSummary);
  for (const bucket of daily.values()) {
    finalizeTokens(bucket.tokens);
    finalizeVerification(bucket.verification);
    finalizeVerification(bucket.checker);
  }

  return {
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    generated_at: new Date().toISOString(),
    totals: {
      sessions: sessions.length,
      runs: runIds.size,
      goals: context.goalsById.size,
      model_calls: modelCalls,
      verifications: verificationSummary.total,
    },
    tokens: totals,
    verification: {
      summary: verificationSummary,
      by_provider: finalizeGroups(tokenGroups.provider),
      checker_effectiveness: checkerSummary,
    },
    learning_signals: learningSignalSummary,
    trends: {
      daily: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    },
    by_goal: finalizeGroups(tokenGroups.goal),
    by_source: finalizeGroups(tokenGroups.source),
    by_system: finalizeGroups(tokenGroups.system),
    by_worktree: finalizeGroups(tokenGroups.worktree),
    by_request_class: finalizeGroups(tokenGroups.requestClass),
  };
}

function buildAttributionContext(store: SessionStore, workspace: WorkspaceIdentity, sessions: SessionRecord[]): AttributionContext {
  const sessionIds = new Set(sessions.map((session) => session.session_id));
  const goalsBySession = new Map<string, GoalRecord>();
  const goalsById = new Map<string, GoalRecord>();
  for (const session of sessions) {
    const goal = readGoalState(store, session.session_id)?.goal;
    if (goal) {
      goalsBySession.set(session.session_id, goal);
      goalsById.set(goal.id, goal);
    }
  }
  const jobs = store.listSupervisorJobs().filter((job) => sessionIds.has(job.session_id));
  const jobsByRun = new Map<string, SupervisorJob>();
  const jobsBySession = new Map<string, SupervisorJob[]>();
  for (const job of jobs) {
    if (job.run_id) {
      jobsByRun.set(job.run_id, job);
    }
    const list = jobsBySession.get(job.session_id) ?? [];
    list.push(job);
    jobsBySession.set(job.session_id, list);
  }
  const worktrees = store.listManagedWorktrees({ workspaceId: workspace.id });
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.worktree_id, worktree]));
  const worktreesByJob = new Map<string, ManagedWorktree>();
  const worktreesBySession = new Map<string, ManagedWorktree[]>();
  for (const worktree of worktrees) {
    if (worktree.job_id) {
      worktreesByJob.set(worktree.job_id, worktree);
    }
    if (worktree.session_id) {
      const list = worktreesBySession.get(worktree.session_id) ?? [];
      list.push(worktree);
      worktreesBySession.set(worktree.session_id, list);
    }
  }
  return {
    goalsBySession,
    goalsById,
    jobsByRun,
    jobsBySession,
    automationById: new Map(store.listAutomationSchedules({ workspaceId: workspace.id }).map((schedule) => [schedule.schedule_id, schedule])),
    discoveryById: new Map(store.listDiscoverySchedules({ workspaceId: workspace.id }).map((schedule) => [schedule.schedule_id, schedule])),
    candidatesById: new Map(store.listDiscoveryCandidates({ workspaceId: workspace.id }).map((candidate) => [candidate.candidate_id, candidate])),
    worktreesById,
    worktreesByJob,
    worktreesBySession,
  };
}

function tokenObservations(store: SessionStore, session: SessionRecord): TokenObservation[] {
  const endpoint = store.listEndpointEvidence(session.session_id).map((record): TokenObservation | undefined => {
    const usage = objectValue(record.usage);
    if (!usage) {
      return undefined;
    }
    return {
      session_id: session.session_id,
      run_id: stringValue(record.run_id),
      request_class: stringValue(record.request_class),
      created_at: stringValue(record.created_at),
      usage,
    };
  }).filter((item): item is TokenObservation => Boolean(item));
  if (endpoint.length) {
    return endpoint;
  }
  return store.listEvents(session.session_id)
    .filter((event) => event.type === "model.response.settled")
    .map((event): TokenObservation | undefined => {
      const usage = objectValue(event.data.usage);
      if (!usage) {
        return undefined;
      }
      return {
        session_id: session.session_id,
        run_id: event.run_id,
        request_class: stringValue(event.data.request_class),
        created_at: event.created_at,
        usage,
      };
    })
    .filter((item): item is TokenObservation => Boolean(item));
}

function attributeObservation(context: AttributionContext, observation: TokenObservation): Attribution {
  const goal = context.goalsBySession.get(observation.session_id);
  return attributionFromParts(context, observation.session_id, observation.run_id, observation.request_class, goal?.id);
}

function attributeVerification(
  context: AttributionContext,
  sessionId: string,
  record: GoalLoopVerification,
): Attribution {
  const base = attributionFromParts(context, sessionId, record.run_id, undefined, record.goal_id);
  const source = sourceFromVerification(record);
  return source
    ? { ...base, source_key: source.key, source_label: source.label, system_key: source.system, system_label: source.system }
    : base;
}

function attributionFromParts(
  context: AttributionContext,
  sessionId: string,
  runId: string | undefined,
  requestClass: string | undefined,
  goalId: string | undefined,
): Attribution {
  const goal = goalId ? context.goalsById.get(goalId) : context.goalsBySession.get(sessionId);
  const job = runId ? context.jobsByRun.get(runId) : undefined;
  const fallbackJob = job ?? singleItem(context.jobsBySession.get(sessionId));
  const source = sourceFromJob(context, fallbackJob) ?? sourceFromSession(context, sessionId) ?? {
    key: "direct",
    label: "direct",
    system: "direct",
  };
  const worktree = worktreeFromJob(context, fallbackJob) ?? singleItem(context.worktreesBySession.get(sessionId));
  return {
    goal_key: goal?.id ?? "no_goal",
    goal_label: goal?.objective,
    source_key: source.key,
    source_label: source.label,
    system_key: source.system,
    system_label: source.system,
    worktree_key: worktree?.worktree_id ?? "active_checkout",
    worktree_label: worktree?.branch ?? "active checkout",
    request_class_key: requestClass ?? "unknown",
  };
}

function sourceFromJob(
  context: AttributionContext,
  job: SupervisorJob | undefined,
): { key: string; label?: string; system: string } | undefined {
  if (!job) {
    return undefined;
  }
  const candidateId = stringValue(job.metadata.discovery_candidate_id);
  if (candidateId) {
    const candidate = context.candidatesById.get(candidateId);
    const source = sourceFromCandidate(candidate);
    if (source) {
      return source;
    }
    return { key: "discovery", label: "discovery", system: "discovery" };
  }
  const discoveryScheduleId = stringValue(job.metadata.discovery_schedule_id);
  if (discoveryScheduleId) {
    const schedule = context.discoveryById.get(discoveryScheduleId);
    const source = stringValue(schedule?.metadata.source) ?? "command";
    return { key: source, label: source, system: systemForSource(source) };
  }
  const automationScheduleId = stringValue(job.metadata.automation_schedule_id);
  if (automationScheduleId) {
    const schedule = context.automationById.get(automationScheduleId);
    const source = stringValue(schedule?.metadata.source) ?? "automation";
    return { key: source, label: source, system: systemForSource(source) };
  }
  const inboxKind = stringValue(job.metadata.inbox_item_kind);
  if (inboxKind) {
    return { key: `inbox:${inboxKind}`, label: `inbox ${inboxKind}`, system: "inbox" };
  }
  return undefined;
}

function sourceFromSession(
  context: AttributionContext,
  sessionId: string,
): { key: string; label?: string; system: string } | undefined {
  const automation = [...context.automationById.values()].filter((schedule) => schedule.session_id === sessionId);
  if (automation.length === 1) {
    const source = stringValue(automation[0]?.metadata.source) ?? "automation";
    return { key: source, label: source, system: systemForSource(source) };
  }
  const discovery = [...context.discoveryById.values()].filter((schedule) => schedule.session_id === sessionId);
  if (discovery.length === 1) {
    const source = stringValue(discovery[0]?.metadata.source) ?? "command";
    return { key: source, label: source, system: systemForSource(source) };
  }
  return undefined;
}

function sourceFromCandidate(candidate: DiscoveryCandidate | undefined): { key: string; label?: string; system: string } | undefined {
  if (!candidate) {
    return undefined;
  }
  const kind = stringValue(candidate.source.kind) ?? "discovery";
  const provider = stringValue(candidate.source.provider);
  return {
    key: kind,
    label: candidate.title,
    system: provider ?? systemForSource(kind),
  };
}

function sourceFromVerification(record: GoalLoopVerification): { key: string; label?: string; system: string } | undefined {
  const system = stringValue(record.evidence?.system);
  if (!system) {
    return undefined;
  }
  const verifier = stringValue(record.evidence?.verifier) ?? "checker";
  return {
    key: verifier,
    label: verifier,
    system,
  };
}

function systemForSource(source: string): string {
  if (source.startsWith("github-")) {
    return "github";
  }
  if (source === "git-changes") {
    return "git";
  }
  if (source === "command") {
    return "command";
  }
  if (source === "automation") {
    return "automation";
  }
  return source;
}

function worktreeFromJob(context: AttributionContext, job: SupervisorJob | undefined): ManagedWorktree | undefined {
  if (!job) {
    return undefined;
  }
  const worktreeId = stringValue(job.metadata.worktree_id);
  if (worktreeId) {
    return context.worktreesById.get(worktreeId);
  }
  return context.worktreesByJob.get(job.job_id);
}

function addTokenGroup(
  groups: Map<string, MutableGroup>,
  key: string,
  label: string | undefined,
  observation: TokenObservation,
  usage: LoopTokenMetrics,
): void {
  const group = getGroup(groups, key, label);
  group.sessionIds.add(observation.session_id);
  if (observation.run_id) {
    group.runIds.add(observation.run_id);
  }
  addTokens(group.tokens, usage);
}

function addVerificationGroup(
  groups: Map<string, MutableGroup>,
  key: string,
  label: string | undefined,
  sessionId: string,
  runId: string | undefined,
  record: GoalLoopVerification,
): void {
  const group = getGroup(groups, key, label);
  group.sessionIds.add(sessionId);
  if (runId) {
    group.runIds.add(runId);
  }
  addVerification(group.verification, record);
}

function getGroup(groups: Map<string, MutableGroup>, key: string, label?: string): MutableGroup {
  const existing = groups.get(key);
  if (existing) {
    if (!existing.label && label) {
      existing.label = label;
    }
    return existing;
  }
  const group: MutableGroup = {
    key,
    label,
    sessions: 0,
    runs: 0,
    tokens: emptyTokenMetrics(),
    verification: emptyVerificationMetrics(),
    sessionIds: new Set(),
    runIds: new Set(),
  };
  groups.set(key, group);
  return group;
}

function getDaily(buckets: Map<string, MutableDaily>, date: string): MutableDaily {
  const existing = buckets.get(date);
  if (existing) {
    return existing;
  }
  const bucket: MutableDaily = {
    date,
    tokens: emptyTokenMetrics(),
    verification: emptyVerificationMetrics(),
    checker: emptyVerificationMetrics(),
  };
  buckets.set(date, bucket);
  return bucket;
}

function finalizeGroups(groups: Map<string, MutableGroup>): LoopMetricsGroup[] {
  return [...groups.values()].map((group) => {
    finalizeTokens(group.tokens);
    finalizeVerification(group.verification);
    const { sessionIds, runIds, ...output } = group;
    return {
      ...output,
      sessions: sessionIds.size,
      runs: runIds.size,
    };
  }).sort((left, right) => {
    const tokenDelta = right.tokens.total_tokens - left.tokens.total_tokens;
    if (tokenDelta) {
      return tokenDelta;
    }
    const verificationDelta = right.verification.total - left.verification.total;
    if (verificationDelta) {
      return verificationDelta;
    }
    return left.key.localeCompare(right.key);
  });
}

function normalizeUsage(usage: JsonObject): LoopTokenMetrics {
  const prompt = numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens) ?? 0;
  const completion = numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens) ?? 0;
  const total = numberValue(usage.total_tokens) ?? prompt + completion;
  const cached = numberValue(usage.cached_prompt_tokens)
    ?? numberValue(usage.prompt_tokens_cached)
    ?? numberValue(usage.input_tokens_cached)
    ?? 0;
  return {
    model_calls: 1,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_prompt_tokens: cached,
  };
}

function addTokens(target: LoopTokenMetrics, value: LoopTokenMetrics): void {
  target.model_calls += value.model_calls;
  target.prompt_tokens += value.prompt_tokens;
  target.completion_tokens += value.completion_tokens;
  target.total_tokens += value.total_tokens;
  target.cached_prompt_tokens += value.cached_prompt_tokens;
}

function finalizeTokens(target: LoopTokenMetrics): void {
  target.cache_hit_rate = target.prompt_tokens > 0 ? roundRatio(target.cached_prompt_tokens / target.prompt_tokens) : undefined;
}

function emptyTokenMetrics(): LoopTokenMetrics {
  return {
    model_calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_prompt_tokens: 0,
  };
}

function addVerification(target: LoopVerificationMetrics, record: GoalLoopVerification): void {
  target.total += 1;
  target[record.verdict] += 1;
  if (record.verdict === "pass" && record.confidence === "hard") {
    target.hard_pass += 1;
  }
  if (!target.latest_at || (record.created_at && record.created_at > target.latest_at)) {
    target.latest_at = record.created_at;
  }
}

function finalizeVerification(target: LoopVerificationMetrics): void {
  target.pass_rate = target.total > 0 ? roundRatio(target.pass / target.total) : undefined;
  target.hard_pass_rate = target.total > 0 ? roundRatio(target.hard_pass / target.total) : undefined;
}

function emptyVerificationMetrics(): LoopVerificationMetrics {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    partial: 0,
    blocked: 0,
    unknown: 0,
    hard_pass: 0,
  };
}

function addLearningSignal(target: LoopLearningSignalMetrics, event: SessionEvent): void {
  const polarity = stringValue(event.data.polarity);
  const category = stringValue(event.data.category);
  target.total += 1;
  if (polarity === "positive" || polarity === "negative" || polarity === "constraint") {
    target[polarity] += 1;
    target.by_polarity[polarity] = (target.by_polarity[polarity] ?? 0) + 1;
  } else {
    target.by_polarity.unknown = (target.by_polarity.unknown ?? 0) + 1;
  }
  if (category) {
    target.by_category[category] = (target.by_category[category] ?? 0) + 1;
  }
  if (!target.latest_at || (event.created_at && event.created_at > target.latest_at)) {
    target.latest_at = event.created_at;
  }
}

function emptyLearningSignalMetrics(): LoopLearningSignalMetrics {
  return {
    total: 0,
    positive: 0,
    negative: 0,
    constraint: 0,
    by_category: {},
    by_polarity: {},
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function dayKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString().slice(0, 10);
}

function singleItem<T>(items: T[] | undefined): T | undefined {
  return items?.length === 1 ? items[0] : undefined;
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}
