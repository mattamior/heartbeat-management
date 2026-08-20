import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEPLOYMENT_PROJECT_ROOT = '/home/bbg/bbg-projects';

/**
 * The deployed host keeps projects under /home/bbg/bbg-projects. A local
 * checkout instead manages its sibling directories unless explicitly set.
 */
export const PROJECT_ROOT = resolve(process.env.HEARTBEAT_PROJECT_ROOT
  ?? (existsSync(DEPLOYMENT_PROJECT_ROOT) ? DEPLOYMENT_PROJECT_ROOT : resolve(process.cwd(), '..')));

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export type ProjectKind = 'web' | 'unsupported';
export type ProjectState = 'managed' | 'external' | 'stopped' | 'failed' | 'conflict' | 'unsupported' | 'taking-over';

export type ListenerSide = 'wsl' | 'windows';
export type ListenerSource = 'linux-process' | 'windows-process' | 'windows-portproxy';

export interface PortProxyRule {
  family: 'v4tov4' | 'v6tov4' | 'v4tov6' | 'v6tov6' | string;
  listenAddress: string;
  listenPort: number;
  connectAddress: string;
  connectPort: number;
  /** Stable key used to revalidate the exact rule before deletion. */
  ruleKey: string;
}

export interface PortProxyRestoreResult {
  ruleKey: string;
  restored: boolean;
  error?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  kind: ProjectKind;
  cwd: string;
  command?: string;
  packageManager?: PackageManager;
  port?: number;
  url?: string;
  env?: Record<string, string>;
  unsupportedReason?: string;
}

export interface LogEntry {
  at: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

/** Process identity reviewed by the user before a takeover request. */
export interface ListenerSnapshot {
  pid: number;
  startedAt?: string;
  cwd?: string;
  command?: string;
  commandSummary?: string;
  pgid?: number;
  groupPids?: number[];
  groupComplete?: boolean;
  visibility?: 'visible' | 'unavailable' | string;
  side?: ListenerSide;
  source?: ListenerSource | string;
  manageable?: boolean;
  elevationRequired?: boolean;
  processName?: string;
  serviceName?: string;
  serviceLookup?: 'known' | 'none' | 'unavailable' | string;
  rejectionReason?: string;
  rule?: PortProxyRule;
}

export interface TakeoverProgress {
  phase?: string;
  port?: number;
  listeners: ListenerSnapshot[];
  terminated?: Array<{ pid: number; pgid?: number; startedAt?: string; signal: 'SIGTERM' | 'SIGKILL' | 'WINDOWS_TERMINATE'; outcome?: 'attempted' | 'confirmed-exited' | 'still-alive'; source?: ListenerSource | string; ruleKey?: string }>;
  message?: string;
  diagnostic?: string;
  /** Structured outcome for restoration attempts after a takeover failure. */
  restored?: boolean;
  restoreFailed?: boolean;
  restoreResults?: PortProxyRestoreResult[];
}

export interface ProjectStatus {
  state: ProjectState;
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  portPids: number[];
  listeners: ListenerSnapshot[];
  /** Alias for consumers that present listeners as takeover candidates. */
  candidates?: ListenerSnapshot[];
  /** True only when the bind probe reports EADDRINUSE but no visible listener exists. */
  invisiblePort?: boolean;
  takeover?: TakeoverProgress;
  error?: string;
}

export interface ProjectView extends ProjectConfig {
  status: ProjectStatus;
}
