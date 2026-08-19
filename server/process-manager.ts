import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { LogEntry, PortProxyRestoreResult, ProjectConfig, ProjectStatus } from '../shared/types.js';
import { LogBuffer } from './log-buffer.js';
import {
  assertPortCanBind,
  inspectListeningProcesses,
  inspectProcess,
  processGroupId,
  scanProcessGroup,
  PortBindError,
  type ListeningProcessSnapshot,
  type ProcessSnapshot
} from './ports.js';
import { isSupportedPortProxyFamily, WindowsPortManager, type WindowsListenerCandidate } from './windows-ports.js';
import type { PortProxyRule } from '../shared/types.js';

export interface TakeoverSnapshot {
  port: number;
  listeners: Array<Pick<ListeningProcessSnapshot, 'pid' | 'startedAt' | 'cwd' | 'command' | 'commandSummary' | 'pgid' | 'groupPids' | 'groupComplete' | 'visibility' | 'side' | 'source' | 'manageable' | 'elevationRequired' | 'processName' | 'serviceName' | 'serviceLookup' | 'rejectionReason' | 'rule'>>;
}

export interface TerminatedProcess {
  pid: number;
  pgid?: number;
  startedAt?: string;
  signal: 'SIGTERM' | 'SIGKILL' | 'WINDOWS_TERMINATE';
  outcome: 'attempted' | 'confirmed-exited' | 'still-alive';
  source?: string;
  ruleKey?: string;
}

export type TakeoverPhase = 'preflight' | 'validating' | 'terminating' | 'waiting' | 'force-killing' | 'starting' | 'completed' | 'failed';

export interface TakeoverProgress {
  phase: TakeoverPhase;
  port: number;
  listeners: TakeoverSnapshot['listeners'];
  terminated?: TerminatedProcess[];
  message?: string;
  diagnostic?: string;
  restored?: boolean;
  restoreFailed?: boolean;
  restoreResults?: PortProxyRestoreResult[];
}

/** Error metadata is serialized by the Fastify error handler. */
export class ProcessOperationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly phase: TakeoverPhase | 'validate' | 'operation',
    public readonly terminated: TerminatedProcess[] = [],
    public readonly diagnostic?: string,
    public readonly restored?: boolean,
    public readonly restoreFailed?: boolean,
    public readonly restoreResults?: PortProxyRestoreResult[]
  ) {
    super(message);
    this.name = 'ProcessOperationError';
  }
}

interface ManagedProcess {
  child: ChildProcess;
  pid: number;
  startedAt: string;
  exitCode?: number | null;
  error?: string;
  stopping?: boolean;
  logs: LogBuffer;
}

export type ExtendedProjectStatus = Omit<ProjectStatus, 'state'> & {
  state: ProjectStatus['state'] | 'taking-over';
  listeners: ListeningProcessSnapshot[];
  takeover?: TakeoverProgress;
};

export interface ProjectProcessManagerOptions {
  /** Override the bind probe in tests without touching real services. */
  assertPortCanBind?: typeof assertPortCanBind;
  /** Windows/WSL bridge; disabled automatically where Windows commands are unavailable. */
  windows?: WindowsPortManager;
}

interface VerifiedGroup {
  pgid: number;
  members: ProcessSnapshotIdentity[];
}

interface VerifiedWindowsCandidate {
  candidate: WindowsListenerCandidate;
}

interface ValidatedTakeover {
  groups: VerifiedGroup[];
  windows: VerifiedWindowsCandidate[];
}

interface RestoreSummary {
  restored: boolean;
  restoreFailed: boolean;
  results: PortProxyRestoreResult[];
}

interface ProcessSnapshotIdentity {
  pid: number;
  startedAt?: string;
  pgid?: number;
  cwd?: string;
}

type Operation<T> = () => Promise<T>;

export class ProjectProcessManager extends EventEmitter {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly operationLocks = new Map<string, Promise<unknown>>();
  private readonly takeoverProgress = new Map<string, TakeoverProgress>();
  private readonly canBind: typeof assertPortCanBind;
  private readonly windows: WindowsPortManager;

  constructor(options: ProjectProcessManagerOptions = {}) {
    super();
    this.canBind = options.assertPortCanBind ?? assertPortCanBind;
    this.windows = options.windows ?? new WindowsPortManager();
  }

  async status(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    if (project.kind === 'unsupported') return { state: 'unsupported', portPids: [], listeners: [], error: project.unsupportedReason };
    const record = this.processes.get(project.id);
    const listeners = project.port ? await this.inspectAllListeners(project.port) : [];
    const portPids = listeners.map(({ pid }) => pid).filter((pid) => pid > 0);
    const candidates = listeners;
    const progress = this.takeoverProgress.get(project.id);
    if (progress) {
      return {
        state: 'taking-over', pid: portPids[0] ?? record?.pid, startedAt: record?.startedAt,
        portPids, listeners, candidates, takeover: { ...progress, listeners }, error: progress.message
      };
    }
    if (record && record.exitCode === undefined) {
      const ownGroup = await this.listenerBelongsTo(record.pid, listeners);
      const windowsError = listeners.find((listener) => listener.side === 'windows' && listener.manageable === false)?.rejectionReason;
      return {
        state: portPids.length > 0 && !ownGroup ? 'conflict' : 'managed', pid: portPids[0] ?? record.pid,
        startedAt: record.startedAt, portPids, listeners, candidates,
        invisiblePort: listeners.some((listener) => listener.side === 'windows'),
        error: windowsError ?? (portPids.length > 0 && !ownGroup ? `端口 ${project.port} 被非受管进程占用` : undefined)
      };
    }
    if (listeners.length > 0) return {
      state: 'external', pid: portPids[0], portPids, listeners, candidates,
      invisiblePort: listeners.some((listener) => listener.side === 'windows'),
      error: listeners.find((listener) => listener.side === 'windows' && listener.manageable === false)?.rejectionReason ?? `端口 ${project.port} 正由外部进程监听`
    };
    if (project.port) {
      try { await this.canBind(project.port); }
      catch (error) {
        const message = error instanceof Error ? error.message : `端口 ${project.port} 无法绑定`;
        if (error instanceof PortBindError && error.code === 'PORT_IN_USE' && listeners.length === 0) {
          // Keep the occupancy fact separate from human-readable errors. The
          // client renders this as the single "不可见占用" prompt and must not
          // offer takeover without a visible, verified process snapshot.
          return { state: 'conflict', portPids, listeners, candidates, invisiblePort: true };
        }
        return { state: 'conflict', portPids, listeners, candidates, error: message };
      }
    }
    if (record?.exitCode !== undefined && record.exitCode !== 0) {
      return { state: 'failed', pid: record.pid, startedAt: record.startedAt, exitCode: record.exitCode, portPids, listeners, candidates, error: record.error };
    }
    return { state: 'stopped', portPids, listeners, candidates, exitCode: record?.exitCode };
  }

  async start(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    return this.serialize(project, () => this.startUnlocked(project));
  }

  private async startUnlocked(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    this.requireWeb(project);
    const current = await this.status(project);
    if (current.state === 'managed') return current;
    if (current.listeners.length > 0) throw new ProcessOperationError(`端口 ${project.port} 正被 ${current.portPids.length > 0 ? `PID ${current.portPids.join(', ')}` : 'Windows 端口资源'} 占用；请先接管或停止它`, 'PORT_IN_USE', 'operation');
    await this.canBind(project.port);
    await this.preflight(project);
    const logs = new LogBuffer();
    const command = [
      'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; elif [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
      `exec ${project.command}`
    ].join('; ');
    const child = spawn('bash', ['-lc', command], { cwd: project.cwd, env: { ...process.env, ...project.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!child.pid) throw new ProcessOperationError('无法创建服务进程', 'START_FAILED', 'operation');
    const record: ManagedProcess = { child, pid: child.pid, startedAt: new Date().toISOString(), logs };
    this.processes.set(project.id, record);
    this.attachOutput(project.id, record, 'stdout');
    this.attachOutput(project.id, record, 'stderr');
    child.once('error', (error) => this.finish(project.id, record, null, error.message));
    child.once('exit', (code) => this.finish(project.id, record, code, code === 0 ? undefined : `服务退出，退出码 ${code ?? 'signal'}`));
    this.emitChange();
    return this.status(project);
  }

  async stop(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    return this.serialize(project, () => this.stopUnlocked(project));
  }

  private async stopUnlocked(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    this.requireWeb(project);
    const record = this.processes.get(project.id);
    if (record && record.exitCode === undefined) {
      record.stopping = true;
      await terminateManagedProcessGroup(record.pid);
      record.logs.append('system', `已请求停止进程组 ${record.pid}`);
      await waitForManagedProcessToExit(record);
    }
    this.emitChange();
    return this.status(project);
  }

  async restart(project: ProjectConfig): Promise<ExtendedProjectStatus> {
    return this.serialize(project, async () => { await this.stopUnlocked(project); return this.startUnlocked(project); });
  }

  /** The HTTP endpoint only accepts the explicit snapshot overload. */
  async takeover(project: ProjectConfig, snapshot: TakeoverSnapshot): Promise<ExtendedProjectStatus>;
  async takeover(project: ProjectConfig, confirmPort: number, confirmPid: number): Promise<ExtendedProjectStatus>;
  async takeover(project: ProjectConfig, snapshotOrPort: TakeoverSnapshot | number, confirmPid?: number): Promise<ExtendedProjectStatus> {
    return this.serialize(project, async () => {
      this.requireWeb(project);
      const snapshot = typeof snapshotOrPort === 'number' ? await this.legacySnapshot(project, snapshotOrPort, confirmPid) : snapshotOrPort;
      try {
        return await this.takeoverUnlocked(project, snapshot);
      } catch (error) {
        // Keep a failed takeover visible in the status stream. The UI needs
        // the phase, diagnostic, and complete signal audit after the request
        // has returned; clearing this in finally used to hide that evidence.
        const previous = this.takeoverProgress.get(project.id);
        const operationError = error instanceof ProcessOperationError ? error : undefined;
        const audit = operationError?.terminated ?? previous?.terminated ?? [];
        const retainFailure = operationError?.code === 'TAKEOVER_START_FAILED' || audit.length > 0;
        if (!retainFailure) {
          if (this.takeoverProgress.delete(project.id)) this.emitChange();
          throw error;
        }
        this.takeoverProgress.set(project.id, {
          phase: 'failed',
          port: snapshot.port,
          listeners: previous?.listeners ?? snapshot.listeners,
          terminated: audit,
          message: error instanceof Error ? error.message : '接管失败',
          diagnostic: operationError?.diagnostic,
          restored: operationError?.restored ?? previous?.restored,
          restoreFailed: operationError?.restoreFailed ?? previous?.restoreFailed,
          restoreResults: operationError?.restoreResults ?? previous?.restoreResults
        });
        this.emitChange();
        throw error;
      }
    });
  }

  /**
   * Deliberately dangerous escape hatch. The caller has explicitly confirmed
   * the port, so incomplete groups are never expanded into negative-PGID
   * signals: only the socket-owning PID is targeted.
   */
  async forceTakeover(project: ProjectConfig, snapshot: TakeoverSnapshot): Promise<ExtendedProjectStatus> {
    return this.serialize(project, async () => {
      this.requireWeb(project);
      if (snapshot.port !== project.port || snapshot.listeners.length === 0) throw new ProcessOperationError('强制释放端口必须确认当前完整监听快照', 'FORCE_TAKEOVER_INVALID_SNAPSHOT', 'validate');
      const own = this.processes.get(project.id);
      if (own && own.exitCode === undefined) throw new ProcessOperationError('项目已有受管进程，不能强制接管', 'TAKEOVER_MANAGED_RUNNING', 'validate');
      try { await this.preflight(project); }
      catch (error) { throw new ProcessOperationError(error instanceof Error ? error.message : '启动前检查失败', 'TAKEOVER_PREFLIGHT_FAILED', 'preflight'); }

      const observed = await this.inspectAllListeners(project.port);
      if (!sameForceSnapshot(snapshot.listeners, observed)) throw new ProcessOperationError('端口监听状态已变化，请刷新后重新确认强制释放', 'TAKEOVER_STALE', 'validate');
      const terminated: TerminatedProcess[] = [];
      const removedRules: PortProxyRule[] = [];
      let restoreSummary: RestoreSummary | undefined;
      const update = (phase: TakeoverPhase, message?: string) => {
        this.takeoverProgress.set(project.id, { phase, port: project.port, listeners: snapshot.listeners, terminated: [...terminated], message, restored: restoreSummary?.restored, restoreFailed: restoreSummary?.restoreFailed, restoreResults: restoreSummary?.results });
        this.emitChange();
      };
      const restoreRules = async () => { if (removedRules.length) restoreSummary = await this.restorePortProxies(removedRules); };

      try {
        update('terminating', '正在强制释放端口；仅终止当前监听 PID，不终止整个进程组。');
        const release = async (signal: 'SIGTERM' | 'SIGKILL', timeoutMs: number): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const current = await this.inspectAllListeners(project.port);
            if (!current.length) return true;
            for (const listener of current) {
              if (listener.side === 'windows' || listener.source === 'windows-process' || listener.source === 'windows-portproxy') {
                const candidate = listener as WindowsListenerCandidate;
                if (!candidate.manageable) throw new ProcessOperationError(`Windows 占用方不可强制管理：${candidate.rejectionReason ?? candidate.processName ?? candidate.pid}`, 'FORCE_TAKEOVER_UNMANAGEABLE_WINDOWS', 'terminating', terminated);
                if (candidate.source === 'windows-portproxy') {
                  if (!candidate.rule) throw new ProcessOperationError('Windows portproxy 规则身份不完整', 'TAKEOVER_UNSAFE_WINDOWS_RULE', 'validate', terminated);
                  if (!removedRules.some((rule) => rule.ruleKey === candidate.rule!.ruleKey)) {
                    await this.windows.removePortProxy(candidate.rule);
                    removedRules.push(candidate.rule);
                    terminated.push({ pid: 0, signal: 'WINDOWS_TERMINATE', outcome: 'confirmed-exited', source: candidate.source, ruleKey: candidate.rule.ruleKey });
                  }
                } else if (!terminated.some((entry) => entry.source === candidate.source && entry.pid === candidate.pid && entry.startedAt === candidate.startedAt)) {
                  await this.windows.terminateProcess(candidate);
                  terminated.push({ pid: candidate.pid, startedAt: candidate.startedAt, signal: 'WINDOWS_TERMINATE', outcome: 'attempted', source: candidate.source });
                }
                continue;
              }
              try { process.kill(listener.pid, signal); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ProcessOperationError(`无法终止监听 PID ${listener.pid}`, 'FORCE_TAKEOVER_SIGNAL_FAILED', 'terminating', terminated, error instanceof Error ? error.message : undefined); }
              if (!terminated.some((entry) => entry.pid === listener.pid && entry.startedAt === listener.startedAt && entry.signal === signal)) terminated.push({ pid: listener.pid, startedAt: listener.startedAt, signal, outcome: 'attempted', source: listener.source });
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return (await this.inspectAllListeners(project.port)).length === 0;
        };
        if (!await release('SIGTERM', 3000)) {
          update('force-killing', '端口仍被占用，正在强制终止当前监听 PID。');
          if (!await release('SIGKILL', 2000)) throw new ProcessOperationError(`端口 ${project.port} 未能强制释放`, 'FORCE_TAKEOVER_PORT_NOT_RELEASED', 'force-killing', terminated, '仍有不可管理或持续重启的监听者；请刷新状态查看剩余候选。');
        }
        for (const entry of terminated) if (entry.outcome === 'attempted') entry.outcome = 'confirmed-exited';
        update('starting');
        await this.startUnlocked(project);
        await this.waitForTakeoverStart(project);
        this.takeoverProgress.delete(project.id);
        this.emitChange();
        return this.status(project);
      } catch (error) {
        await restoreRules();
        const original = error instanceof ProcessOperationError ? error : new ProcessOperationError(error instanceof Error ? error.message : '强制释放端口失败', 'FORCE_TAKEOVER_FAILED', 'operation', terminated);
        throw new ProcessOperationError(original.message, original.code, original.phase, original.terminated.length ? original.terminated : terminated, appendRestoreDiagnostic(original.diagnostic, restoreSummary), restoreSummary?.restored, restoreSummary?.restoreFailed, restoreSummary?.results);
      }
    });
  }

  private async takeoverUnlocked(project: ProjectConfig, snapshot: TakeoverSnapshot): Promise<ExtendedProjectStatus> {
    this.requireWeb(project);
    const terminated: TerminatedProcess[] = [];
    let restoreSummary: RestoreSummary | undefined;
    let startupConfirmed = false;
    const updateProgress = (phase: TakeoverPhase, message?: string) => {
      const value: TakeoverProgress = {
        phase, port: project.port, listeners: snapshot.listeners, terminated: [...terminated], message,
        restored: restoreSummary?.restored,
        restoreFailed: restoreSummary?.restoreFailed,
        restoreResults: restoreSummary?.results
      };
      this.takeoverProgress.set(project.id, value);
      this.emitChange();
    };
    updateProgress('preflight');
    if (snapshot.port !== project.port) throw new ProcessOperationError('确认端口与项目配置不一致', 'TAKEOVER_INVALID_SNAPSHOT', 'validate');
    const own = this.processes.get(project.id);
    if (own && own.exitCode === undefined) throw new ProcessOperationError('项目已有受管进程，不能接管外部进程', 'TAKEOVER_MANAGED_RUNNING', 'validate');
    try { await this.preflight(project); }
    catch (error) { throw new ProcessOperationError(error instanceof Error ? error.message : '启动前检查失败', 'TAKEOVER_PREFLIGHT_FAILED', 'preflight'); }

    updateProgress('validating');
    const expectedCwd = await realpath(project.cwd).catch(() => { throw new ProcessOperationError(`无法验证项目工作目录: ${project.cwd}`, 'TAKEOVER_PROJECT_CWD_UNAVAILABLE', 'validate'); });
    const current = await this.inspectAllListeners(project.port);
    const managerPgid = await processGroupId(process.pid);
    const validated = await validateSnapshot(snapshot, current, project.port, expectedCwd, managerPgid);
    const groups = validated.groups;
    const removedRules: PortProxyRule[] = [];

    // Windows portproxy is a rule hosted by svchost, not a process that may be
    // killed.  Ordinary user listeners are terminated through an elevated,
    // PID-scoped PowerShell request after the same snapshot revalidation.
    try {
      for (const { candidate } of validated.windows) {
        const latest = await this.windows.inspect(project.port);
        const currentCandidate = latest.find((item) => sameWindowsCandidate(item, candidate));
        if (!currentCandidate) throw new ProcessOperationError('Windows 端口占用状态已变化，请刷新后重新确认', 'TAKEOVER_STALE', 'validate');
        if (candidate.source === 'windows-portproxy') {
          if (!candidate.rule) throw new ProcessOperationError('Windows 端口转发规则缺少完整元数据', 'TAKEOVER_UNSAFE_WINDOWS_RULE', 'validate');
          await this.windows.removePortProxy(candidate.rule);
          removedRules.push(candidate.rule);
          terminated.push({ pid: 0, signal: 'WINDOWS_TERMINATE', outcome: 'confirmed-exited', source: candidate.source, ruleKey: candidate.rule.ruleKey });
        } else {
          await this.windows.terminateProcess(candidate);
          terminated.push({ pid: candidate.pid, startedAt: candidate.startedAt, signal: 'WINDOWS_TERMINATE', outcome: 'attempted', source: candidate.source });
        }
      }
    } catch (error) {
      if (!removedRules.length) throw error;
      restoreSummary = await this.restorePortProxies(removedRules);
      const original = error instanceof ProcessOperationError
        ? error
        : new ProcessOperationError(error instanceof Error ? error.message : 'Windows 侧接管失败', 'TAKEOVER_WINDOWS_FAILED', 'terminating', terminated);
      const diagnostic = appendRestoreDiagnostic(original.diagnostic, restoreSummary);
      const audit = original.terminated.length > 0 ? original.terminated : terminated;
      throw new ProcessOperationError(original.message, original.code, original.phase, audit, diagnostic, restoreSummary.restored, restoreSummary.restoreFailed, restoreSummary.results);
    }

    try {
      updateProgress('terminating');
      for (const group of groups) {
        // This is a final TOCTOU check immediately before every negative-PGID
        // signal. It verifies the original identities, group ownership, and the
        // manager's own process-group exclusion again.
        const members = await revalidateGroupForSignal(group, expectedCwd, managerPgid);
        if (members.length === 0) { markGroupExited(terminated, group.pgid, 'SIGTERM'); continue; }
        try { process.kill(-group.pgid, 'SIGTERM'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ProcessOperationError(`无法终止进程组 ${group.pgid}`, 'TAKEOVER_TERM_FAILED', 'terminating', terminated, error instanceof Error ? error.message : undefined);
        }
        appendSignalAudit(terminated, members, group.pgid, 'SIGTERM');
      }
      updateProgress('waiting');
      const remainingAfterTerm = await waitForGroupsToExit(groups, expectedCwd, managerPgid, 3000, terminated, 'SIGTERM');
      if (remainingAfterTerm.size > 0) {
        updateProgress('force-killing');
        for (const group of remainingAfterTerm.values()) {
          const members = await revalidateGroupForSignal(group, expectedCwd, managerPgid);
          if (members.length === 0) { markGroupExited(terminated, group.pgid, 'SIGKILL'); continue; }
          try { process.kill(-group.pgid, 'SIGKILL'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ProcessOperationError(`无法强制终止进程组 ${group.pgid}`, 'TAKEOVER_KILL_FAILED', 'force-killing', terminated, error instanceof Error ? error.message : undefined);
          }
          appendSignalAudit(terminated, members, group.pgid, 'SIGKILL');
        }
        const remainingAfterKill = await waitForGroupsToExit([...remainingAfterTerm.values()], expectedCwd, managerPgid, 2000, terminated, 'SIGKILL');
        if (remainingAfterKill.size > 0 || !await waitForPortToClose(project.port, 2000, () => this.inspectAllListeners(project.port))) {
          throw new ProcessOperationError(`端口 ${project.port} 未在强制终止后释放`, 'TAKEOVER_PORT_NOT_RELEASED', 'force-killing', terminated, '仍有监听进程；未验证归属的进程不会被自动终止，请手动处理。');
        }
      } else if (!await waitForPortToClose(project.port, 2000, () => this.inspectAllListeners(project.port))) {
        throw new ProcessOperationError(`端口 ${project.port} 未在优雅终止后释放`, 'TAKEOVER_PORT_NOT_RELEASED', 'waiting', terminated, '原始进程组已结束，但仍有未确认归属的监听进程；未执行自动终止。');
      }

      updateProgress('starting');
      await this.startUnlocked(project);
      await this.waitForTakeoverStart(project);
      startupConfirmed = true;
      updateProgress('completed');
      this.takeoverProgress.delete(project.id);
      this.emitChange();
      return this.status(project);
    } catch (error) {
      if (!removedRules.length || startupConfirmed) throw error;
      restoreSummary = await this.restorePortProxies(removedRules);
      const original = error instanceof ProcessOperationError
        ? error
        : new ProcessOperationError(error instanceof Error ? error.message : '接管后操作失败', 'TAKEOVER_FAILED', 'operation', terminated);
      const audit = original.terminated.length > 0 ? original.terminated : terminated;
      const isStarting = original.phase === 'starting' || original.code === 'START_FAILED';
      const message = isStarting
        ? `接管后启动失败：${error instanceof Error ? error.message : '未知错误'}；外部服务已终止`
        : original.message;
      const code = isStarting ? 'TAKEOVER_START_FAILED' : original.code;
      const diagnostic = appendRestoreDiagnostic(original.diagnostic, restoreSummary);
      throw new ProcessOperationError(message, code, original.phase, audit, diagnostic, restoreSummary.restored, restoreSummary.restoreFailed, restoreSummary.results);
    }
  }

  private async restorePortProxies(rules: PortProxyRule[]): Promise<RestoreSummary> {
    const results: PortProxyRestoreResult[] = [];
    for (const rule of rules) {
      try {
        await this.windows.restorePortProxy(rule);
        results.push({ ruleKey: rule.ruleKey, restored: true });
      } catch (error) {
        results.push({ ruleKey: rule.ruleKey, restored: false, error: error instanceof Error ? error.message : '恢复失败' });
      }
    }
    return {
      restored: results.length > 0 && results.every((result) => result.restored),
      restoreFailed: results.some((result) => !result.restored),
      results
    };
  }

  logs(projectId: string): LogEntry[] { return this.processes.get(projectId)?.logs.list() ?? []; }

  private async inspectAllListeners(port: number): Promise<ListeningProcessSnapshot[]> {
    const [linux, windows] = await Promise.all([
      inspectListeningProcesses(port),
      this.windows.inspect(port)
    ]);
    return [...linux, ...windows] as ListeningProcessSnapshot[];
  }

  private async legacySnapshot(project: ProjectConfig, port: number, pid?: number): Promise<TakeoverSnapshot> {
    if (port !== project.port || !Number.isInteger(pid)) throw new ProcessOperationError('接管必须确认完整监听快照', 'TAKEOVER_INVALID_SNAPSHOT', 'validate');
    const listeners = await this.inspectAllListeners(port);
    return { port, listeners: listeners.filter((listener) => listener.pid === pid) };
  }

  private async serialize<T>(project: ProjectConfig, operation: Operation<T>): Promise<T> {
    const key = `${project.id}:${project.port ?? ''}`;
    const previous = this.operationLocks.get(key);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.operationLocks.set(key, current);
    try { return await current; }
    finally { if (this.operationLocks.get(key) === current) this.operationLocks.delete(key); }
  }

  private attachOutput(projectId: string, record: ManagedProcess, stream: 'stdout' | 'stderr'): void {
    record.child[stream]?.setEncoding('utf8');
    record.child[stream]?.on('data', (data: string) => {
      const entries = record.logs.append(stream, data);
      for (const entry of entries) this.emit('log', projectId, entry);
    });
  }

  private finish(projectId: string, record: ManagedProcess, exitCode: number | null, error?: string): void {
    if (this.processes.get(projectId) !== record) return;
    record.exitCode = record.stopping ? 0 : exitCode;
    record.error = record.stopping ? undefined : error;
    record.logs.append('system', record.stopping ? '服务已停止' : (error ?? `服务已退出，退出码 ${exitCode ?? 'signal'}`));
    this.emitChange();
  }

  private async listenerBelongsTo(groupLeader: number, listeners: ListeningProcessSnapshot[]): Promise<boolean> {
    if (!listeners.length) return true;
    const groupId = await processGroupId(groupLeader);
    return Boolean(groupId && listeners.every((listener) => listener.visibility === 'visible' && listener.pgid === groupId));
  }

  private async preflight(project: ProjectConfig): Promise<void> {
    await access(project.cwd, constants.R_OK | constants.X_OK).catch(() => { throw new Error(`工作目录不可访问: ${project.cwd}`); });
    const executable = project.packageManager === 'pnpm' ? 'pnpm' : project.packageManager === 'yarn' ? 'yarn' : 'npm';
    const checks = await Promise.all(['node', executable].map(async (command) => {
      const process = spawn('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
      return new Promise<boolean>((resolve) => process.once('exit', (code) => resolve(code === 0)));
    }));
    if (!checks[0]) throw new Error('未找到 Node.js；请安装 Node 20 或配置 nvm');
    if (!checks[1]) throw new Error(`未找到 ${executable}；请安装或在配置中改用可用包管理器`);
  }

  private async waitForTakeoverStart(project: ProjectConfig): Promise<void> {
    if (!project.port) throw new Error('项目未配置端口');
    const record = this.processes.get(project.id);
    if (!record) throw new Error('服务进程记录未创建');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (record.exitCode !== undefined) throw new Error(`服务进程已退出，退出码 ${record.exitCode ?? 'signal'}`);
      const groupId = await processGroupId(record.pid);
      const listeners = await inspectListeningProcesses(project.port);
      if (groupId && listeners.some((listener) => listener.pgid === groupId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`服务启动后未监听端口 ${project.port}`);
  }

  private requireWeb(project: ProjectConfig): asserts project is ProjectConfig & Required<Pick<ProjectConfig, 'command' | 'packageManager' | 'port'>> {
    if (project.kind !== 'web' || !project.command || !project.packageManager || !project.port) throw new Error(project.unsupportedReason ?? '该项目暂不支持服务控制');
  }

  private emitChange(): void { this.emit('change'); }
}

function isWithinProject(cwd: string | undefined, expectedCwd: string): boolean {
  return Boolean(cwd && (cwd === expectedCwd || cwd.startsWith(`${expectedCwd}/`)));
}

function appendRestoreDiagnostic(diagnostic: string | undefined, summary: RestoreSummary | undefined): string | undefined {
  if (!summary) return diagnostic;
  const failures = summary.results.filter((result) => !result.restored);
  const recovery = summary.restored
    ? '原 Windows portproxy 规则已恢复。'
    : `原 Windows portproxy 规则恢复失败：${failures.map((result) => `${result.ruleKey}: ${result.error ?? '未知错误'}`).join('; ')}`;
  return diagnostic ? `${diagnostic}；${recovery}` : recovery;
}

function comparableSnapshot(listener: ListeningProcessSnapshot | TakeoverSnapshot['listeners'][number]): string {
  return [
    listener.pid,
    listener.startedAt ?? '',
    listener.cwd ?? '',
    listener.command ?? listener.commandSummary ?? '',
    listener.pgid ?? '',
    listener.side ?? '',
    listener.source ?? '',
    listener.processName ?? '',
    listener.serviceName ?? '',
    listener.visibility ?? '',
    listener.manageable === undefined ? '' : String(listener.manageable),
    listener.groupComplete === undefined ? '' : String(listener.groupComplete),
    listener.rule?.ruleKey ?? '',
    listener.rule?.family ?? '',
    listener.rule?.listenAddress ?? '',
    listener.rule?.listenPort ?? '',
    listener.rule?.connectAddress ?? '',
    listener.rule?.connectPort ?? '',
    ...(listener.groupPids ?? []).slice().sort((a, b) => a - b)
  ].join('|');
}

function sameWindowsCandidate(a: WindowsListenerCandidate, b: WindowsListenerCandidate): boolean {
  return comparableSnapshot(a as ListeningProcessSnapshot) === comparableSnapshot(b as ListeningProcessSnapshot)
    && a.source === b.source
    && (a.source !== 'windows-portproxy' || a.rule?.ruleKey === b.rule?.ruleKey);
}

function sameForceSnapshot(confirmed: TakeoverSnapshot['listeners'], observed: ListeningProcessSnapshot[]): boolean {
  if (confirmed.length !== observed.length) return false;
  const sort = (items: Array<TakeoverSnapshot['listeners'][number] | ListeningProcessSnapshot>) => items.map((item) => comparableSnapshot(item)).sort();
  const expected = sort(confirmed);
  const current = sort(observed);
  return expected.every((value, index) => value === current[index]);
}

async function validateSnapshot(snapshot: TakeoverSnapshot, current: ListeningProcessSnapshot[], port: number, expectedCwd: string, managerPgid?: number): Promise<ValidatedTakeover> {
  if (snapshot.port !== port) throw new ProcessOperationError('确认端口与项目配置不一致', 'TAKEOVER_INVALID_SNAPSHOT', 'validate');
  if (!snapshot.listeners.length) throw new ProcessOperationError('未确认任何监听进程；请刷新后重试', 'TAKEOVER_STALE', 'validate');
  const confirmed = [...snapshot.listeners].sort((a, b) => a.pid - b.pid);
  const observed = [...current].sort((a, b) => a.pid - b.pid);
  if (confirmed.length !== observed.length || confirmed.some((item, index) => comparableSnapshot(item) !== comparableSnapshot(observed[index]))) throw new ProcessOperationError('端口监听状态已变化，请刷新后重新确认', 'TAKEOVER_STALE', 'validate');
  const groups = new Map<number, VerifiedGroup>();
  const windows: VerifiedWindowsCandidate[] = [];
  for (const listener of observed) {
    if (listener.side === 'windows' || listener.source === 'windows-process' || listener.source === 'windows-portproxy') {
      const candidate = listener as WindowsListenerCandidate;
      if (candidate.source === 'windows-portproxy') {
        if (candidate.rule && !isSupportedPortProxyFamily(candidate.rule.family)) {
          throw new ProcessOperationError(`拒绝接管 Windows 端口转发规则：不支持 family ${candidate.rule.family}`, 'TAKEOVER_UNSAFE_WINDOWS_RULE', 'validate', [], '当前仅支持 v4tov4、v6tov4、v4tov6、v6tov6；未识别的 family 不会自动删除。');
        }
        if (!candidate.rule || candidate.rule.listenPort !== port || !candidate.manageable) {
          throw new ProcessOperationError(`拒绝接管 Windows 端口转发规则：规则元数据不完整`, 'TAKEOVER_UNSAFE_WINDOWS_RULE', 'validate', [], '只能删除用户明确确认且与项目端口完全匹配的 portproxy 规则。');
        }
      } else {
        if (!candidate.manageable || !candidate.pid || !candidate.startedAt || candidate.command === undefined || candidate.cwd === undefined || candidate.visibility !== 'visible') {
          throw new ProcessOperationError(`拒绝接管 Windows PID ${candidate.pid}：${candidate.rejectionReason ?? '进程身份无法确认'}`, 'TAKEOVER_UNSAFE_WINDOWS_PROCESS', 'validate', [], '系统服务、svchost、无法确认服务归属或无法完整读取的 Windows 进程不会被自动终止；请刷新后重试或手动处理。');
        }
      }
      windows.push({ candidate });
      continue;
    }
    if (listener.visibility !== 'visible' || !listener.groupComplete || !listener.pgid || !listener.groupPids?.length) throw new ProcessOperationError(`拒绝接管 PID ${listener.pid}：进程组成员或工作目录无法完整确认`, 'TAKEOVER_UNSAFE_GROUP', 'validate', [], '检测到不可见或不完整的进程组；请手动停止服务后重试。');
    if (!isWithinProject(listener.cwd, expectedCwd)) throw new ProcessOperationError(`拒绝接管 PID ${listener.pid}：其工作目录无法确认属于 ${expectedCwd}`, 'TAKEOVER_CROSS_DIRECTORY', 'validate', [], '检测到跨目录进程，未执行任何终止操作。');
    if (listener.groupPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 1)) throw new ProcessOperationError(`拒绝接管 PID ${listener.pid}：进程组成员清单不完整`, 'TAKEOVER_UNSAFE_GROUP', 'validate');
    if (listener.pgid === managerPgid || listener.groupPids.includes(process.pid)) throw new ProcessOperationError(`拒绝接管进程组 ${listener.pgid ?? '未知'}：目标包含管理器自身进程`, 'TAKEOVER_SELF_GROUP', 'validate', [], '接管目标与当前管理器进程组重叠，未执行任何终止操作。');
    if (!groups.has(listener.pgid)) groups.set(listener.pgid, { pgid: listener.pgid, members: [] });
  }
  // Re-read every member, not only the process that owns the listening socket.
  // A child with an inaccessible or cross-project cwd makes the whole group
  // unsafe to terminate.
  for (const group of groups.values()) {
    const listener = observed.find((candidate) => candidate.pgid === group.pgid)!;
    const memberPids = [...new Set(listener.groupPids ?? [])];
    const members = await Promise.all(memberPids.map((pid) => inspectProcess(pid)));
    if (members.some((member) => !member || !member.startedAt || !isWithinProject(member.cwd, expectedCwd) || member.pgid !== group.pgid)) {
      throw new ProcessOperationError(`拒绝接管进程组 ${group.pgid}：存在无法确认归属的成员`, 'TAKEOVER_CROSS_DIRECTORY', 'validate', [], '检测到跨目录或不可见进程组成员，未执行任何终止操作。');
    }
    group.members = members.filter((member): member is ProcessSnapshot => Boolean(member));
  }
  return { groups: [...groups.values()], windows };
}

async function revalidateGroupForSignal(group: VerifiedGroup, expectedCwd: string, managerPgid?: number): Promise<ProcessSnapshot[]> {
  if (group.pgid === managerPgid || group.members.some((member) => member.pid === process.pid)) throw new ProcessOperationError(`拒绝接管进程组 ${group.pgid}：目标包含管理器自身进程`, 'TAKEOVER_SELF_GROUP', 'validate', [], '接管目标与当前管理器进程组重叠。');
  const scan = await scanProcessGroup(group.pgid);
  if (!scan.complete) throw new ProcessOperationError(`拒绝向进程组 ${group.pgid} 发送信号：进程组扫描不完整`, 'TAKEOVER_UNSAFE_GROUP', 'validate', [], '无法完整读取 /proc 进程组成员，未执行自动终止。');
  const members = await Promise.all(scan.pids.map((pid) => inspectProcess(pid)));
  if (members.some((member) => !member || !member.startedAt || member.pgid !== group.pgid || !isWithinProject(member.cwd, expectedCwd))) throw new ProcessOperationError(`拒绝向进程组 ${group.pgid} 发送信号：存在未知或跨目录成员`, 'TAKEOVER_UNSAFE_GROUP', 'validate', [], '进程组成员归属无法完整确认，未执行自动终止。');
  const visibleMembers = members.filter((member): member is ProcessSnapshot => Boolean(member));
  if (visibleMembers.some((member) => member.pid === process.pid) || group.pgid === managerPgid) throw new ProcessOperationError(`拒绝接管进程组 ${group.pgid}：目标包含管理器自身进程`, 'TAKEOVER_SELF_GROUP', 'validate', [], '接管目标与当前管理器进程组重叠。');
  const originalStillAlive = group.members.some((original) => visibleMembers.some((member) => member.pid === original.pid && member.startedAt === original.startedAt && member.pgid === group.pgid));
  return originalStillAlive ? visibleMembers : [];
}

async function waitForGroupsToExit(groups: VerifiedGroup[], expectedCwd: string, managerPgid: number | undefined, timeoutMs: number, audit: TerminatedProcess[], signal: 'SIGTERM' | 'SIGKILL'): Promise<Map<number, VerifiedGroup>> {
  const pending = new Map(groups.map((group) => [group.pgid, group]));
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [pgid, group] of pending) {
      try {
        const members = await revalidateGroupForSignal(group, expectedCwd, managerPgid);
        if (members.length === 0) { markGroupExited(audit, pgid, signal); pending.delete(pgid); }
      } catch {
        // A transient /proc race is retried until the timeout. The final
        // revalidation below turns persistent uncertainty into a safe refusal.
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const [pgid, group] of [...pending]) {
    const members = await revalidateGroupForSignal(group, expectedCwd, managerPgid);
    if (members.length === 0) { markGroupExited(audit, pgid, signal); pending.delete(pgid); }
    else markGroupStillAlive(audit, pgid, signal);
  }
  return pending;
}

function appendSignalAudit(audit: TerminatedProcess[], members: ProcessSnapshot[], pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const member of members) audit.push({ pid: member.pid, pgid, startedAt: member.startedAt, signal, outcome: 'attempted' });
}

function markGroupExited(audit: TerminatedProcess[], pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const entry of audit) if (entry.pgid === pgid && entry.signal === signal) entry.outcome = 'confirmed-exited';
}

function markGroupStillAlive(audit: TerminatedProcess[], pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  for (const entry of audit) if (entry.pgid === pgid && entry.signal === signal && entry.outcome === 'attempted') entry.outcome = 'still-alive';
}

async function terminateManagedProcessGroup(pid: number): Promise<void> {
  const groupId = await processGroupId(pid);
  if (!groupId) throw new Error(`无法安全确定 PID ${pid} 的进程组`);
  try { process.kill(-groupId, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function waitForManagedProcessToExit(record: ManagedProcess): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (record.exitCode !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`受管进程 ${record.pid} 未在三秒内停止`);
}

async function waitForPortToClose(port: number, timeoutMs: number, inspect: () => Promise<unknown[]> = () => inspectListeningProcesses(port)): Promise<boolean> {
  const attempts = Math.ceil(timeoutMs / 100);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await inspect()).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (await inspect()).length === 0;
}
