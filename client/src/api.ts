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
  directory: string;
  startCommand: string;
  packageManager: string;
  port?: number;
  url?: string;
  env?: Record<string, string>;
  supported?: boolean;
  unsupportedReason?: string;
}

export interface ServiceStatus {
  kind: ProjectStatusKind;
  pid?: number;
  managedPid?: number;
  startedAt?: string;
  command?: string;
  exitCode?: number | null;
  message?: string;
}

export interface Project {
  config: ProjectConfig;
  status: ServiceStatus;
}

type UnknownRecord = Record<string, unknown>;

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
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
    throw new ApiError(
      typeof body?.message === 'string' ? body.message : `请求失败（HTTP ${response.status}）`,
      response.status,
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  const kind = ({ managed: 'managed-running', external: 'external-running', conflict: 'port-conflict' } as Record<string, string>)[rawKind] ?? rawKind;
  return {
    config,
    status: {
      kind,
      pid: asNumber(statusSource.pid ?? record.pid),
      managedPid: asNumber(statusSource.managedPid ?? statusSource.managedProcessPid ?? record.managedPid),
      startedAt: asString(statusSource.startedAt ?? record.startedAt) || undefined,
      command: asString(statusSource.command ?? record.command) || undefined,
      exitCode: statusSource.exitCode === null ? null : asNumber(statusSource.exitCode ?? record.exitCode),
      message: asString(statusSource.message ?? statusSource.error ?? record.message ?? record.error) || undefined,
    },
  };
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

export async function runProjectAction(project: Project, action: 'start' | 'stop' | 'restart' | 'takeover'): Promise<Project> {
  const body = action === 'takeover'
    ? { confirm: true, confirmPort: project.config.port, confirmPid: project.status.pid }
    : undefined;
  const response = await request<unknown>(`/api/projects/${encodeURIComponent(project.config.id)}/${action}`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
  const record = asRecord(response);
  if (record.status) return normalizeProject({ ...project.config, status: record.status });
  return normalizeProject(record.project ?? response);
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
