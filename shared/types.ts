export const PROJECT_ROOT = '/home/bbg/bbg-projects';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export type ProjectKind = 'web' | 'unsupported';
export type ProjectState = 'managed' | 'external' | 'stopped' | 'failed' | 'conflict' | 'unsupported';

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

export interface ProjectStatus {
  state: ProjectState;
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  portPids: number[];
  error?: string;
}

export interface ProjectView extends ProjectConfig {
  status: ProjectStatus;
}
