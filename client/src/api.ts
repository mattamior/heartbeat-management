export type ProjectStatusKind =
  | 'managed-running'
  | 'external-running'
  | 'stopped'
  | 'failed'
  | 'port-conflict'
  | 'unsupported'
  | string;

export interface ProjectConfig {
  id: string;
  name: string;
  kind?: 'web' | 'unsupported' | string;
  directory: string;
  startCommand: string;
  packageManager: string;
  port?: number;
  url?: string;
  env?: Record<string, string>;
  supported?: boolean;
  unsupportedReason?: string;
}

export interface PortProxyMapping {
  listenAddress?: string;
  listenPort?: number;
  connectAddress?: string;
  connectPort?: number;
  [key: string]: unknown;
}

/** The exact Windows rule identity required by the takeover endpoint. */
export interface PortProxyRule extends PortProxyMapping {
  family: string;
  listenAddress: string;
  listenPort: number;
  connectAddress: string;
  connectPort: number;
  ruleKey: string;
}

/** A listener snapshot is the exact process identity the user reviewed. */
export interface ProcessSnapshot {
  /** Windows portproxy entries have no process PID. */
  pid?: number;
  /** Stable client identity for non-process candidates such as portproxy rules. */
  id?: string;
  /** The side on which the listener was discovered. */
  side?: 'wsl' | 'windows' | 'unknown' | string;
  /** The resource type: process, service, or Windows portproxy rule. */
  kind?: 'process' | 'service' | 'portproxy' | 'unknown' | string;
  source?: string;
  processName?: string;
  mapping?: string | PortProxyMapping;
  listenAddress?: string;
  listenPort?: number;
  connectAddress?: string;
  connectPort?: number;
  /** Kept separately from mapping because the server revalidates this exact rule. */
  rule?: PortProxyRule | PortProxyMapping | string;
  ruleKey?: string;
  manageable?: boolean;
  managementReason?: string;
  rejectionReason?: string;
  requiresElevation?: boolean;
  elevationRequired?: boolean;
  startedAt?: string;
  cwd?: string;
  command?: string;
  commandSummary?: string;
  pgid?: number;
  groupPids?: number[];
  groupComplete?: boolean;
  visibility?: 'visible' | 'unavailable' | string;
}

export interface ServiceFailure {
  code?: string;
  phase?: string;
  operation?: string;
  message?: string;
  terminatedPids?: number[];
  diagnostics?: string;
  permissionRequired?: boolean;
  permissionDenied?: boolean;
  requiresElevation?: boolean;
  elevationRequired?: boolean;
  managementReason?: string;
  rejectionReason?: string;
  restored?: boolean;
  restoreFailed?: boolean;
  restore?: RestoreResult;
  restoreResults?: RestoreResultItem[];
  releaseTimedOut?: boolean;
}

export interface RestoreResult {
  status?: string;
  attempted?: boolean;
  success?: boolean;
  succeeded?: boolean;
  failed?: boolean;
  message?: string;
  error?: string;
  ruleKeys?: string[];
}

/** Per-rule restoration outcome returned by the takeover endpoint. */
export interface RestoreResultItem {
  ruleKey: string;
  restored: boolean;
  error?: string;
}

export interface ServiceStatus {
  kind: ProjectStatusKind;
  pid?: number;
  managedPid?: number;
  startedAt?: string;
  command?: string;
  exitCode?: number | null;
  message?: string;
  portPids: number[];
  listeners: ProcessSnapshot[];
  operation?: 'start' | 'stop' | 'restart' | 'takeover' | string;
  invisiblePort?: boolean;
  failure?: ServiceFailure;
  diagnostics?: string;
  takeover?: {
    phase?: string;
    port?: number;
    listeners: ProcessSnapshot[];
    terminatedPids?: number[];
    message?: string;
    restored?: boolean;
    restoreFailed?: boolean;
    restoreResults?: RestoreResultItem[];
  };
}

export interface Project {
  config: ProjectConfig;
  status: ServiceStatus;
}

type UnknownRecord = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details: {
      code?: string;
      phase?: string;
      operation?: string;
      terminatedPids?: number[];
      diagnostics?: string;
      refreshRequired?: boolean;
      permissionRequired?: boolean;
      permissionDenied?: boolean;
      requiresElevation?: boolean;
      elevationRequired?: boolean;
      managementReason?: string;
      rejectionReason?: string;
      restored?: boolean;
      restoreFailed?: boolean;
      restore?: RestoreResult;
      restoreResults?: RestoreResultItem[];
      releaseTimedOut?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  let hasHeaders = false;
  headers.forEach(() => { hasHeaders = true; });
  if (typeof init?.body === 'string' && init.body.length > 0 && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
    hasHeaders = true;
  }

  const response = await fetch(path, {
    ...init,
    ...(hasHeaders ? { headers } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as UnknownRecord | null;
    const nested = asRecord(body?.details ?? body?.failure ?? body?.error);
    const code = asString(body?.code ?? nested.code) || undefined;
    const phase = asString(body?.phase ?? nested.phase) || undefined;
    const operation = asString(body?.operation ?? nested.operation) || undefined;
    const terminatedPids = asNumbers(body?.terminatedPids ?? nested.terminatedPids)
      ?? (Array.isArray(body?.terminated) ? asNumbers(body.terminated.map((item) => asRecord(item).pid)) : undefined)
      ?? (Array.isArray(nested.terminated) ? asNumbers(nested.terminated.map((item) => asRecord(item).pid)) : undefined);
    const diagnostics = asString(body?.diagnostics ?? body?.diagnostic ?? nested.diagnostics ?? nested.diagnostic) || undefined;
    const requiresElevation = readBoolean(body?.requiresElevation ?? nested.requiresElevation);
    const elevationRequired = readBoolean(body?.elevationRequired ?? nested.elevationRequired);
    const managementReason = asString(body?.managementReason ?? nested.managementReason) || undefined;
    const rejectionReason = asString(body?.rejectionReason ?? nested.rejectionReason) || undefined;
    const restore = normalizeRestoreResult(body?.restore ?? body?.restoreResult ?? nested.restore ?? nested.restoreResult);
    const restoreResults = normalizeRestoreResults(body?.restoreResults ?? nested.restoreResults);
    const permissionRequired = body?.permissionRequired === true || nested.permissionRequired === true
      || requiresElevation === true || elevationRequired === true
      || code === 'WINDOWS_ADMIN_REQUIRED' || code === 'ELEVATION_REQUIRED';
    const permissionDenied = body?.permissionDenied === true || nested.permissionDenied === true
      || code === 'WINDOWS_ADMIN_DENIED' || code === 'UAC_DENIED' || code === 'PERMISSION_DENIED';
    const allRulesRestored = restoreResults && restoreResults.length > 0 && restoreResults.every((result) => result.restored);
    const anyRuleFailed = restoreResults?.some((result) => !result.restored);
    const restored = body?.restored === true || nested.restored === true || restore?.success === true || restore?.succeeded === true || allRulesRestored;
    const restoreFailed = body?.restoreFailed === true || nested.restoreFailed === true
      || restore?.failed === true || restore?.success === false || restore?.succeeded === false
      || restore?.status === 'failed' || restore?.status === 'restore-failed' || anyRuleFailed;
    const releaseTimedOut = body?.releaseTimedOut === true || nested.releaseTimedOut === true
      || code === 'PORT_RELEASE_TIMEOUT' || code === 'TAKEOVER_RELEASE_TIMEOUT';
    const refreshRequired = body?.refreshRequired === true
      || nested.refreshRequired === true
      || response.status === 409
      || code === 'STALE_SNAPSHOT'
      || code === 'SNAPSHOT_STALE';
    throw new ApiError(
      typeof body?.message === 'string' ? body.message : `请求失败（HTTP ${response.status}）`,
      response.status,
      {
        code,
        phase,
        operation,
        terminatedPids,
        diagnostics,
        refreshRequired,
        permissionRequired,
        permissionDenied,
        requiresElevation,
        elevationRequired,
        managementReason,
        rejectionReason,
        restored,
        restoreFailed,
        restore,
        restoreResults,
        releaseTimedOut,
      },
    );
  }
  return response.json() as Promise<T>;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 1);
  return numbers.length > 0 ? [...new Set(numbers)] : undefined;
}

function normalizeRestoreResult(value: unknown): RestoreResult | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const rawRuleKeys = record.ruleKeys ?? record.restoredRuleKeys;
  const ruleKeys = Array.isArray(rawRuleKeys)
    ? rawRuleKeys.filter((item): item is string => typeof item === 'string')
    : undefined;
  const result: RestoreResult = {
    status: asString(record.status ?? record.state) || undefined,
    attempted: readBoolean(record.attempted),
    success: readBoolean(record.success ?? record.succeeded ?? record.restored),
    succeeded: readBoolean(record.succeeded ?? record.success ?? record.restored),
    failed: readBoolean(record.failed ?? record.restoreFailed),
    message: asString(record.message) || undefined,
    error: asString(record.error ?? record.diagnostic) || undefined,
    ruleKeys: ruleKeys && ruleKeys.length > 0 ? [...new Set(ruleKeys)] : undefined,
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function normalizeRestoreResults(value: unknown): RestoreResultItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results = value.flatMap((item): RestoreResultItem[] => {
    const record = asRecord(item);
    const ruleKey = asString(record.ruleKey ?? record.key).trim();
    if (!ruleKey) return [];
    const restored = readBoolean(record.restored ?? record.success ?? record.succeeded);
    if (restored === undefined) return [];
    return [{
      ruleKey,
      restored,
      error: asString(record.error ?? record.reason ?? record.message) || undefined,
    }];
  });
  return results.length > 0 ? results : undefined;
}

function normalizeSide(value: unknown): ProcessSnapshot['side'] | undefined {
  const side = asString(value).toLowerCase();
  if (!side) return undefined;
  if (side === 'win' || side === 'win32' || side === 'windows' || side === 'host' || side.includes('windows')) return 'windows';
  if (side === 'linux' || side === 'wsl' || side.includes('wsl')) return 'wsl';
  return side;
}

function normalizeListenerKind(value: unknown): ProcessSnapshot['kind'] | undefined {
  const kind = asString(value).toLowerCase();
  if (!kind) return undefined;
  if (kind === 'port-proxy' || kind === 'port_proxy' || kind === 'portproxy') return 'portproxy';
  if (kind === 'exe' || kind === 'process') return 'process';
  return kind;
}

function normalizeProcessSnapshot(value: unknown): ProcessSnapshot | undefined {
  const record = asRecord(value);
  const pid = asNumber(record.pid ?? record.processId);
  const kind = normalizeListenerKind(record.kind ?? record.type ?? record.resourceType);
  const source = asString(record.source ?? record.origin) || undefined;
  const rawRule = record.rule;
  const explicitMapping = record.mapping ?? record.portproxy ?? record.portProxy ?? record.forwarding;
  const rawMapping = explicitMapping
    ?? (rawRule && typeof rawRule === 'object' ? rawRule : undefined)
    ?? (kind === 'portproxy' || source === 'windows-portproxy' ? rawRule : undefined);
  const mapping = typeof rawMapping === 'string'
    ? (rawMapping || undefined)
    : rawMapping && typeof rawMapping === 'object' ? rawMapping as PortProxyMapping : undefined;
  const rule = typeof rawRule === 'string'
    ? (rawRule || undefined)
    : rawRule && typeof rawRule === 'object' ? rawRule as PortProxyRule : undefined;
  const ruleRecord = asRecord(rule);
  const mappingRecord = asRecord(mapping);
  const ownerRecord = asRecord(record.owner);
  const ownerSide = typeof record.owner === 'string' ? record.owner : undefined;
  if (!pid && kind !== 'portproxy' && !mapping) return undefined;
  const processGroup = asRecord(record.processGroup ?? record.group);
  const listenPort = asNumber(record.listenPort ?? record.localPort ?? record.sourcePort ?? record.port
    ?? mappingRecord.listenPort ?? mappingRecord.localPort ?? mappingRecord.sourcePort);
  const connectPort = asNumber(record.connectPort ?? record.remotePort ?? record.targetPort ?? record.destinationPort
    ?? mappingRecord.connectPort ?? mappingRecord.remotePort ?? mappingRecord.targetPort ?? mappingRecord.destinationPort);
  const normalizedKind = kind ?? (mapping ? 'portproxy' : 'process');
  const ruleKey = asString(record.ruleKey ?? ruleRecord.ruleKey ?? mappingRecord.ruleKey) || undefined;
  const elevation = readBoolean(record.requiresElevation ?? record.elevationRequired ?? record.requiresAdmin ?? record.adminRequired);
  const managementReason = asString(record.managementReason ?? record.rejectionReason ?? record.reason ?? record.unsupportedReason) || undefined;
  return {
    pid,
    id: asString(record.id ?? record.identity ?? record.key) || undefined,
    side: normalizeSide(record.side ?? record.platform ?? record.host ?? record.ownerSide ?? ownerSide
      ?? ownerRecord.side ?? ownerRecord.platform ?? ownerRecord.host),
    kind: normalizedKind,
    source,
    processName: asString(record.processName ?? record.name ?? record.image) || undefined,
    mapping,
    listenAddress: asString(record.listenAddress ?? record.localAddress ?? record.bindAddress
      ?? mappingRecord.listenAddress ?? mappingRecord.localAddress ?? mappingRecord.bindAddress) || undefined,
    listenPort,
    connectAddress: asString(record.connectAddress ?? record.remoteAddress ?? record.targetAddress ?? record.destinationAddress
      ?? mappingRecord.connectAddress ?? mappingRecord.remoteAddress ?? mappingRecord.targetAddress ?? mappingRecord.destinationAddress) || undefined,
    connectPort,
    rule,
    ruleKey,
    manageable: typeof record.manageable === 'boolean' ? record.manageable : undefined,
    managementReason,
    rejectionReason: managementReason,
    requiresElevation: elevation,
    elevationRequired: elevation,
    startedAt: asString(record.startedAt ?? record.startTime ?? record.startTimeIso) || undefined,
    cwd: asString(record.cwd ?? record.workingDirectory ?? record.directory) || undefined,
    command: asString(record.command ?? record.commandSummary ?? record.cmd) || undefined,
    commandSummary: asString(record.commandSummary ?? record.command ?? record.cmd) || undefined,
    pgid: asNumber(record.pgid ?? record.processGroupId ?? record.groupId ?? processGroup.pgid ?? processGroup.id),
    groupPids: asNumbers(record.groupPids ?? record.processGroupPids ?? processGroup.pids),
    groupComplete: typeof record.groupComplete === 'boolean' ? record.groupComplete : undefined,
    visibility: asString(record.visibility) || undefined,
  };
}

function normalizeProcessSnapshots(value: unknown): ProcessSnapshot[] {
  if (!Array.isArray(value)) return [];
  const snapshots = value.map(normalizeProcessSnapshot).filter((item): item is ProcessSnapshot => Boolean(item));
  const merged = new Map<string, ProcessSnapshot>();
  for (const snapshot of snapshots) {
    const key = processSnapshotKey(snapshot);
    const previous = merged.get(key);
    merged.set(key, previous ? mergeProcessSnapshots(previous, snapshot) : snapshot);
  }
  return [...merged.values()];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function isPortProxySnapshot(snapshot: ProcessSnapshot): boolean {
  return snapshot.kind === 'portproxy'
    || snapshot.kind === 'port-proxy'
    || snapshot.source === 'windows-portproxy'
    || Boolean((snapshot.pid === undefined || snapshot.pid === 0) && (snapshot.mapping || snapshot.rule));
}

function processSnapshotRuleKey(snapshot: ProcessSnapshot): string | undefined {
  if (snapshot.rule && typeof snapshot.rule === 'object' && typeof snapshot.rule.ruleKey === 'string' && snapshot.rule.ruleKey) return snapshot.rule.ruleKey;
  if (typeof snapshot.ruleKey === 'string' && snapshot.ruleKey) return snapshot.ruleKey;
  if (snapshot.mapping && typeof snapshot.mapping === 'object' && typeof snapshot.mapping.ruleKey === 'string' && snapshot.mapping.ruleKey) return snapshot.mapping.ruleKey;
  return undefined;
}

/** Stable identity used by both normalized state and UI list keys. */
export function processSnapshotKey(snapshot: ProcessSnapshot): string {
  if (snapshot.id) return `id:${snapshot.id}`;
  if (isPortProxySnapshot(snapshot)) {
    const ruleKey = processSnapshotRuleKey(snapshot);
    if (ruleKey) return `portproxy:rule:${ruleKey}`;
    if (typeof snapshot.mapping === 'string' && snapshot.mapping.trim()) return `portproxy:mapping:${snapshot.mapping.trim()}`;
    if (snapshot.mapping && typeof snapshot.mapping === 'object') return `portproxy:mapping:${stableSerialize(snapshot.mapping)}`;
    if (typeof snapshot.rule === 'string' && snapshot.rule.trim()) return `portproxy:rule-text:${snapshot.rule.trim()}`;
    return `portproxy:endpoints:${snapshot.listenAddress ?? ''}:${snapshot.listenPort ?? ''}:${snapshot.connectAddress ?? ''}:${snapshot.connectPort ?? ''}`;
  }
  return `process:${snapshot.kind ?? ''}:${snapshot.pid ?? ''}:${snapshot.startedAt ?? ''}:${snapshot.pgid ?? ''}`;
}

function mergeProcessSnapshots(previous: ProcessSnapshot, next: ProcessSnapshot): ProcessSnapshot {
  const merged: ProcessSnapshot = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && (merged[key as keyof ProcessSnapshot] === undefined || merged[key as keyof ProcessSnapshot] === '')) {
      (merged as UnknownRecord)[key] = value;
    }
  }
  if (next.rule && typeof next.rule === 'object' && (!previous.rule || typeof previous.rule === 'string')) merged.rule = next.rule;
  if (next.mapping && !previous.mapping) merged.mapping = next.mapping;
  if (next.groupPids && (!previous.groupPids || next.groupPids.length > previous.groupPids.length)) merged.groupPids = next.groupPids;
  return merged;
}

function asCandidateValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

function normalizeFailure(value: unknown): ServiceFailure | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const restore = normalizeRestoreResult(record.restore ?? record.restoreResult ?? record.portproxyRestore);
  const restoreResults = normalizeRestoreResults(record.restoreResults);
  const requiresElevation = readBoolean(record.requiresElevation ?? record.elevationRequired);
  const managementReason = asString(record.managementReason ?? record.rejectionReason) || undefined;
  const terminatedPids = asNumbers(record.terminatedPids ?? record.killedPids ?? record.stoppedPids)
    ?? (Array.isArray(record.terminated) ? asNumbers(record.terminated.map((item) => asRecord(item).pid)) : undefined);
  const failure: ServiceFailure = {
    code: asString(record.code) || undefined,
    phase: asString(record.phase ?? record.stage) || undefined,
    operation: asString(record.operation ?? record.action) || undefined,
    message: asString(record.message ?? record.error) || undefined,
    terminatedPids,
    diagnostics: asString(record.diagnostics ?? record.diagnostic) || undefined,
    permissionRequired: record.permissionRequired === true ? true : undefined,
    permissionDenied: record.permissionDenied === true ? true : undefined,
    requiresElevation,
    elevationRequired: requiresElevation,
    managementReason,
    rejectionReason: managementReason,
    restored: record.restored === true || restore?.success === true || restore?.succeeded === true || Boolean(restoreResults?.length && restoreResults.every((result) => result.restored)) ? true : undefined,
    restoreFailed: record.restoreFailed === true || restore?.failed === true || restore?.success === false || restore?.succeeded === false || restore?.status === 'failed' || restore?.status === 'restore-failed' || Boolean(restoreResults?.some((result) => !result.restored)) ? true : undefined,
    restore,
    restoreResults,
    releaseTimedOut: record.releaseTimedOut === true ? true : undefined,
  };
  return Object.values(failure).some((value) => value !== undefined) ? failure : undefined;
}

export function normalizeProject(value: unknown): Project {
  const record = asRecord(value);
  const configSource = asRecord(record.config ?? record);
  const statusSource = asRecord(record.status);
  const envSource = asRecord(configSource.env);
  const env = Object.fromEntries(
    Object.entries(envSource).filter(([, envValue]) => typeof envValue === 'string') as Array<[string, string]>,
  );
  const config: ProjectConfig = {
    id: asString(configSource.id, asString(record.id)),
    name: asString(configSource.name, asString(record.name, '未命名项目')),
    kind: asString(configSource.kind ?? record.kind) || undefined,
    directory: asString(configSource.directory ?? configSource.cwd, asString(record.directory ?? record.cwd)),
    startCommand: asString(configSource.startCommand ?? configSource.command, asString(record.startCommand ?? record.command)),
    packageManager: asString(configSource.packageManager, asString(record.packageManager)),
    port: asNumber(configSource.port ?? record.port),
    url: asString(configSource.url ?? record.url) || undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
    supported: configSource.supported !== false && record.supported !== false && configSource.kind !== 'unsupported' && record.kind !== 'unsupported',
    unsupportedReason: asString(configSource.unsupportedReason ?? record.unsupportedReason) || undefined,
  };
  const rawKind = asString(statusSource.kind ?? statusSource.state ?? record.state, config.supported ? 'stopped' : 'unsupported');
  const takeoverSource = asRecord(statusSource.takeover ?? record.takeover);
  const takeoverPhase = asString(takeoverSource.phase) || undefined;
  const kind = rawKind === 'taking-over' && takeoverPhase === 'failed'
    ? 'failed'
    : ({ managed: 'managed-running', external: 'external-running', conflict: 'port-conflict', 'taking-over': 'takeover-in-progress' } as Record<string, string>)[rawKind] ?? rawKind;
  const listenerValues = [
    statusSource.listeners,
    statusSource.portListeners,
    statusSource.portCandidates,
    statusSource.candidates,
    statusSource.windowsListeners,
    statusSource.windowsCandidates,
    statusSource.portproxyCandidates,
    statusSource.portProxyCandidates,
    statusSource.windowsPortProxies,
    record.listeners,
    record.portListeners,
    record.windowsListeners,
    record.windowsCandidates,
    record.portproxyCandidates,
    record.portProxyCandidates,
    record.windowsPortProxies,
    statusSource.portproxy,
    statusSource.portProxy,
    record.portproxy,
    record.portProxy,
    takeoverSource.listeners,
  ].flatMap(asCandidateValues);
  const listeners = normalizeProcessSnapshots(listenerValues);
  const portPids = asNumbers(statusSource.portPids ?? record.portPids) ?? listeners.flatMap((listener) => typeof listener.pid === 'number' ? [listener.pid] : []);
  const explicitFailure = statusSource.failure ?? statusSource.takeoverFailure ?? record.failure;
  const statusFailure = Object.keys(asRecord(explicitFailure)).length > 0
    ? normalizeFailure(explicitFailure)
    : (hasFailureMetadata(statusSource) || hasFailureMetadata(record) ? normalizeFailure(statusSource) ?? normalizeFailure(record) : undefined);
  const failure = statusFailure ?? (takeoverPhase === 'failed' ? normalizeFailure(takeoverSource) : undefined);
  const message = asString(statusSource.message ?? statusSource.error ?? record.message ?? record.error) || undefined;
  return {
    config,
    status: {
      kind,
      pid: asNumber(statusSource.pid ?? record.pid),
      managedPid: asNumber(statusSource.managedPid ?? statusSource.managedProcessPid ?? record.managedPid),
      startedAt: asString(statusSource.startedAt ?? record.startedAt) || undefined,
      command: asString(statusSource.command ?? record.command) || undefined,
      exitCode: statusSource.exitCode === null ? null : asNumber(statusSource.exitCode ?? record.exitCode),
      message,
      portPids,
      listeners,
      operation: asString(statusSource.operation ?? statusSource.action ?? record.operation)
        || (rawKind === 'taking-over' && takeoverPhase !== 'failed' ? 'takeover' : undefined),
      invisiblePort: statusSource.invisiblePort === true
        || statusSource.portVisible === false
        || statusSource.visibility === 'invisible'
        || statusSource.portVisibility === 'invisible'
        || /不可见|Windows|主机占用/i.test(message ?? ''),
      failure,
      diagnostics: asString(statusSource.diagnostics ?? record.diagnostics) || undefined,
      takeover: Object.keys(takeoverSource).length > 0 ? {
        phase: takeoverPhase,
        port: asNumber(takeoverSource.port),
        listeners: normalizeProcessSnapshots(takeoverSource.listeners),
        terminatedPids: asNumbers(takeoverSource.terminatedPids)
          ?? (Array.isArray(takeoverSource.terminated) ? asNumbers(takeoverSource.terminated.map((item) => asRecord(item).pid)) : undefined),
        message: asString(takeoverSource.message) || undefined,
        restored: takeoverSource.restored === true ? true : undefined,
        restoreFailed: takeoverSource.restoreFailed === true ? true : undefined,
        restoreResults: normalizeRestoreResults(takeoverSource.restoreResults),
      } : undefined,
    },
  };
}

function hasFailureMetadata(record: UnknownRecord): boolean {
  return ['restore', 'restoreResult', 'portproxyRestore', 'restoreResults', 'restoreFailed', 'restored', 'elevationRequired', 'requiresElevation', 'rejectionReason', 'managementReason'].some((key) => key in record);
}

export async function getProjects(): Promise<Project[]> {
  const payload = await request<unknown>('/api/projects');
  if (Array.isArray(payload)) return payload.map(normalizeProject);
  const projects = asRecord(payload).projects;
  return Array.isArray(projects) ? projects.map(normalizeProject) : [];
}

export async function updateProject(id: string, config: Omit<ProjectConfig, 'id'>): Promise<Project> {
  const project = await request<unknown>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: config.name,
      cwd: config.directory,
      command: config.startCommand,
      packageManager: config.packageManager,
      port: config.port,
      url: config.url,
      env: config.env,
    }),
  });
  return normalizeProject(asRecord(project).project ?? project);
}

export async function runProjectAction(project: Project, action: 'start' | 'stop' | 'restart' | 'takeover' | 'force-takeover'): Promise<Project> {
  const force = action === 'force-takeover';
  const body = (action === 'takeover' || force)
    ? {
      confirm: true,
      ...(force ? { force: true, confirmPort: project.config.port, acknowledgement: String(project.config.port ?? '') } : {}),
      snapshot: {
        port: project.config.port,
        // Portproxy candidates have pid 0 and are rules, not processes.  Keep
        // their exact nested rule in the request even when the response used
        // the older `mapping` shape.
        listeners: project.status.listeners.map(prepareTakeoverSnapshot),
      },
    }
    : undefined;
  const endpoint = force ? 'takeover' : action;
  const response = await request<unknown>(`/api/projects/${encodeURIComponent(project.config.id)}/${endpoint}`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
  const record = asRecord(response);
  if (record.status) return normalizeProject({ ...project.config, status: record.status });
  return normalizeProject(record.project ?? response);
}

function prepareTakeoverSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
  const rule = toPortProxyRule(snapshot);
  if (!rule || (snapshot.rule && typeof snapshot.rule === 'object' && isCompletePortProxyRule(snapshot.rule))) return snapshot;
  return { ...snapshot, rule };
}

function toPortProxyRule(snapshot: ProcessSnapshot): PortProxyRule | undefined {
  if (snapshot.rule && typeof snapshot.rule === 'object' && isCompletePortProxyRule(snapshot.rule)) {
    return snapshot.rule as PortProxyRule;
  }
  const mapping = snapshot.mapping && typeof snapshot.mapping === 'object' ? snapshot.mapping : undefined;
  const existingRule = snapshot.rule && typeof snapshot.rule === 'object' ? snapshot.rule : undefined;
  const candidate: UnknownRecord = {
    ...(mapping ?? {}),
    ...(existingRule ?? {}),
    family: existingRule?.family ?? mapping?.family ?? (snapshot.kind === 'portproxy' ? 'v4tov4' : undefined),
    listenAddress: existingRule?.listenAddress ?? mapping?.listenAddress ?? snapshot.listenAddress,
    listenPort: existingRule?.listenPort ?? mapping?.listenPort ?? snapshot.listenPort,
    connectAddress: existingRule?.connectAddress ?? mapping?.connectAddress ?? snapshot.connectAddress,
    connectPort: existingRule?.connectPort ?? mapping?.connectPort ?? snapshot.connectPort,
    ruleKey: existingRule?.ruleKey ?? mapping?.ruleKey ?? snapshot.ruleKey,
  };
  if (!isCompletePortProxyRule(candidate)) return undefined;
  return candidate as PortProxyRule;
}

function isCompletePortProxyRule(value: unknown): value is PortProxyRule {
  const rule = asRecord(value);
  return typeof rule.family === 'string'
    && typeof rule.listenAddress === 'string'
    && Number.isSafeInteger(rule.listenPort)
    && typeof rule.connectAddress === 'string'
    && Number.isSafeInteger(rule.connectPort)
    && typeof rule.ruleKey === 'string'
    && rule.ruleKey.length > 0;
}

export async function getLogs(id: string): Promise<string[]> {
  const payload = await request<{ logs?: unknown; lines?: unknown; entries?: unknown }>(`/api/projects/${encodeURIComponent(id)}/logs`);
  const logs = payload.logs ?? payload.lines ?? payload.entries;
  if (!Array.isArray(logs)) return [];
  return logs.map((line) => {
    if (typeof line === 'string') return line;
    const record = asRecord(line);
    return asString(record.text, JSON.stringify(line) ?? '');
  });
}

export interface StreamEvent {
  event: 'project' | 'status' | 'log';
  project?: Project;
  projectId?: string;
  log?: string;
  projects?: Project[];
}

export function parseStreamEvent(eventName: string, data: string): StreamEvent | null {
  try {
    const decoded: unknown = JSON.parse(data);
    if (eventName === 'status' && Array.isArray(decoded)) return { event: 'status', projects: decoded.map(normalizeProject) };
    const payload = asRecord(decoded);
    const event = eventName === 'message' ? asString(payload.type, 'project') : eventName;
    if (event !== 'project' && event !== 'status' && event !== 'log') return null;
    const candidate = payload.project ?? (event === 'log' ? undefined : payload);
    return {
      event,
      project: candidate ? normalizeProject(candidate) : undefined,
      projectId: asString(payload.projectId ?? payload.id) || undefined,
      log: asString(payload.log ?? payload.line ?? asRecord(payload.entry).text ?? payload.message) || undefined,
    };
  } catch {
    return null;
  }
}
