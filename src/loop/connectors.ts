import type { DiscoveryCandidate, DiscoverySchedule, SessionStore } from "../session/store.js";
import type { WorkspaceIdentity } from "../types.js";
import { listConnectorActionPolicyDefinitions } from "../tools/connector-actions.js";
import { listConnectorActionRunnerDefinitions } from "./actions.js";
import { listConnectorVerifierDefinitions } from "./connector-verifiers.js";
import { listDiscoverySourceDefinitions, type LoopDiscoverySourceDefinition } from "./discovery.js";

export interface LoopConnectorDiscoverySource extends LoopDiscoverySourceDefinition {
  schedules: number;
  enabled_schedules: number;
  paused_schedules: number;
  due_schedules: number;
  open_candidates: number;
  high_open_candidates: number;
  last_error?: string;
}

export interface LoopConnectorVerifierCapability {
  id: string;
  verifier_role: string;
  cli_command: string;
  tui_action: string;
  description: string;
}

export interface LoopConnectorActionPolicyCapability {
  id: string;
  surface: string;
  command?: string;
  tool_names: string[];
  kind: string;
  request_classes: string[];
  decision: string;
  review_surface: string;
  description: string;
}

export interface LoopConnectorActionRunnerCapability {
  id: string;
  surface: string;
  kind: string;
  area: string;
  operation: string;
  cli_command: string;
  tui_action: string;
  default_mode: string;
  description: string;
}

export interface LoopConnectorCatalogItem {
  connector: string;
  status: "available" | "configured";
  discovery_sources: LoopConnectorDiscoverySource[];
  verifiers: LoopConnectorVerifierCapability[];
  action_policies: LoopConnectorActionPolicyCapability[];
  action_runners: LoopConnectorActionRunnerCapability[];
  summary: {
    discovery_sources: number;
    schedules: number;
    enabled_schedules: number;
    paused_schedules: number;
    due_schedules: number;
    open_candidates: number;
    high_open_candidates: number;
    verifiers: number;
    action_policies: number;
    action_runners: number;
  };
}

export interface LoopConnectorCatalogReport {
  generated_at: string;
  summary: {
    connectors: number;
    configured_connectors: number;
    discovery_sources: number;
    schedules: number;
    enabled_schedules: number;
    paused_schedules: number;
    due_schedules: number;
    open_candidates: number;
    high_open_candidates: number;
    verifiers: number;
    action_policies: number;
    action_runners: number;
    global_action_policies: number;
  };
  connectors: LoopConnectorCatalogItem[];
  global_action_policies: LoopConnectorActionPolicyCapability[];
}

export function readLoopConnectors(store: SessionStore, workspace: WorkspaceIdentity, now = new Date()): LoopConnectorCatalogReport {
  const discoveryDefinitions = listDiscoverySourceDefinitions();
  const verifierDefinitions = listConnectorVerifierDefinitions();
  const actionPolicyDefinitions = listConnectorActionPolicyDefinitions();
  const actionRunnerDefinitions = listConnectorActionRunnerDefinitions();
  const schedules = store.listDiscoverySchedules({ workspaceId: workspace.id });
  const candidates = store.listDiscoveryCandidates({ workspaceId: workspace.id });
  const sourceById = new Map(discoveryDefinitions.map((source) => [source.id, source]));
  const schedulesBySource = groupBy(schedules, (schedule) => discoverySourceId(schedule));
  const candidatesBySource = groupBy(candidates, (candidate) => candidateSourceId(candidate, schedules, sourceById));
  const connectorIds = new Set<string>();

  for (const source of discoveryDefinitions) {
    connectorIds.add(source.connector);
  }
  for (const verifier of verifierDefinitions) {
    connectorIds.add(verifier.connector);
  }
  for (const policy of actionPolicyDefinitions) {
    if (policy.connector !== "*") {
      connectorIds.add(policy.connector);
    }
  }
  for (const runner of actionRunnerDefinitions) {
    connectorIds.add(runner.connector);
  }
  for (const schedule of schedules) {
    connectorIds.add(connectorForDiscoverySource(discoverySourceId(schedule), sourceById));
  }
  for (const candidate of candidates) {
    connectorIds.add(connectorForDiscoverySource(candidateSourceId(candidate, schedules, sourceById), sourceById));
  }

  const dueAt = now.toISOString();
  const connectors = [...connectorIds].sort().map((connector) => {
    const discoverySources = discoveryDefinitions
      .filter((source) => source.connector === connector)
      .map((source) => projectDiscoverySource(source, schedulesBySource.get(source.id) ?? [], candidatesBySource.get(source.id) ?? [], dueAt));
    const customSourceIds = customSourceIdsForConnector(connector, schedules, candidates, sourceById);
    for (const sourceId of customSourceIds) {
      discoverySources.push(projectDiscoverySource({
        id: sourceId,
        connector,
        description: "Configured custom discovery source.",
        dismiss_stale: false,
      }, schedulesBySource.get(sourceId) ?? [], candidatesBySource.get(sourceId) ?? [], dueAt));
    }
    discoverySources.sort((a, b) => a.id.localeCompare(b.id));
    const verifiers = verifierDefinitions
      .filter((definition) => definition.connector === connector)
      .map((definition) => ({
        id: definition.id,
        verifier_role: definition.verifier_role,
        cli_command: definition.cli_command,
        tui_action: definition.tui_action,
        description: definition.description,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const actionPolicies = actionPolicyDefinitions
      .filter((definition) => definition.connector === connector)
      .map(projectActionPolicy)
      .sort((a, b) => a.id.localeCompare(b.id));
    const actionRunners = actionRunnerDefinitions
      .filter((definition) => definition.connector === connector)
      .map(projectActionRunner)
      .sort((a, b) => a.id.localeCompare(b.id));
    const summary = {
      discovery_sources: discoverySources.length,
      schedules: sum(discoverySources.map((source) => source.schedules)),
      enabled_schedules: sum(discoverySources.map((source) => source.enabled_schedules)),
      paused_schedules: sum(discoverySources.map((source) => source.paused_schedules)),
      due_schedules: sum(discoverySources.map((source) => source.due_schedules)),
      open_candidates: sum(discoverySources.map((source) => source.open_candidates)),
      high_open_candidates: sum(discoverySources.map((source) => source.high_open_candidates)),
      verifiers: verifiers.length,
      action_policies: actionPolicies.length,
      action_runners: actionRunners.length,
    };
    return {
      connector,
      status: summary.schedules > 0 || summary.open_candidates > 0 ? "configured" : "available",
      discovery_sources: discoverySources,
      verifiers,
      action_policies: actionPolicies,
      action_runners: actionRunners,
      summary,
    } satisfies LoopConnectorCatalogItem;
  });

  const globalActionPolicies = actionPolicyDefinitions
    .filter((definition) => definition.connector === "*")
    .map(projectActionPolicy)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      connectors: connectors.length,
      configured_connectors: connectors.filter((connector) => connector.status === "configured").length,
      discovery_sources: sum(connectors.map((connector) => connector.summary.discovery_sources)),
      schedules: schedules.length,
      enabled_schedules: schedules.filter((schedule) => schedule.status === "enabled").length,
      paused_schedules: schedules.filter((schedule) => schedule.status === "paused").length,
      due_schedules: schedules.filter((schedule) => schedule.status === "enabled" && schedule.next_run_at <= dueAt).length,
      open_candidates: candidates.filter((candidate) => candidate.status === "open").length,
      high_open_candidates: candidates.filter((candidate) => candidate.status === "open" && candidate.priority === "high").length,
      verifiers: verifierDefinitions.length,
      action_policies: actionPolicyDefinitions.filter((definition) => definition.connector !== "*").length,
      action_runners: actionRunnerDefinitions.length,
      global_action_policies: globalActionPolicies.length,
    },
    connectors,
    global_action_policies: globalActionPolicies,
  };
}

function projectDiscoverySource(
  source: LoopDiscoverySourceDefinition,
  schedules: DiscoverySchedule[],
  candidates: DiscoveryCandidate[],
  dueAt: string,
): LoopConnectorDiscoverySource {
  const activeCandidates = candidates.filter((candidate) => candidate.status === "open");
  const lastError = schedules.find((schedule) => schedule.last_error)?.last_error;
  return {
    ...source,
    schedules: schedules.length,
    enabled_schedules: schedules.filter((schedule) => schedule.status === "enabled").length,
    paused_schedules: schedules.filter((schedule) => schedule.status === "paused").length,
    due_schedules: schedules.filter((schedule) => schedule.status === "enabled" && schedule.next_run_at <= dueAt).length,
    open_candidates: activeCandidates.length,
    high_open_candidates: activeCandidates.filter((candidate) => candidate.priority === "high").length,
    last_error: lastError,
  };
}

function projectActionPolicy(definition: ReturnType<typeof listConnectorActionPolicyDefinitions>[number]): LoopConnectorActionPolicyCapability {
  return {
    id: definition.id,
    surface: definition.surface,
    command: definition.command,
    tool_names: [...definition.tool_names],
    kind: definition.kind,
    request_classes: [...definition.request_classes],
    decision: definition.decision,
    review_surface: definition.review_surface,
    description: definition.description,
  };
}

function projectActionRunner(definition: ReturnType<typeof listConnectorActionRunnerDefinitions>[number]): LoopConnectorActionRunnerCapability {
  return {
    id: definition.id,
    surface: definition.surface,
    kind: definition.kind,
    area: definition.area,
    operation: definition.operation,
    cli_command: definition.cli_command,
    tui_action: definition.tui_action,
    default_mode: definition.default_mode,
    description: definition.description,
  };
}

function discoverySourceId(schedule: DiscoverySchedule): string {
  const source = typeof schedule.metadata.source === "string" ? schedule.metadata.source.trim() : "";
  return source || schedule.command;
}

function candidateSourceId(
  candidate: DiscoveryCandidate,
  schedules: DiscoverySchedule[],
  sourceById: Map<string, LoopDiscoverySourceDefinition>,
): string {
  const kind = typeof candidate.source.kind === "string" ? candidate.source.kind.trim() : "";
  if (kind) {
    return kind;
  }
  const command = typeof candidate.source.command === "string" ? candidate.source.command.trim() : "";
  if (command && sourceById.has(command)) {
    return command;
  }
  const schedule = schedules.find((item) => item.schedule_id === candidate.schedule_id);
  return schedule ? discoverySourceId(schedule) : "custom";
}

function connectorForDiscoverySource(sourceId: string, sourceById: Map<string, LoopDiscoverySourceDefinition>): string {
  return sourceById.get(sourceId)?.connector ?? "custom";
}

function customSourceIdsForConnector(
  connector: string,
  schedules: DiscoverySchedule[],
  candidates: DiscoveryCandidate[],
  sourceById: Map<string, LoopDiscoverySourceDefinition>,
): string[] {
  if (connector !== "custom") {
    return [];
  }
  const ids = new Set<string>();
  for (const schedule of schedules) {
    const sourceId = discoverySourceId(schedule);
    if (!sourceById.has(sourceId)) {
      ids.add(sourceId);
    }
  }
  for (const candidate of candidates) {
    const sourceId = candidateSourceId(candidate, schedules, sourceById);
    if (!sourceById.has(sourceId)) {
      ids.add(sourceId);
    }
  }
  return [...ids].sort();
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
