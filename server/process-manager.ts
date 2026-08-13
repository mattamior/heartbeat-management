import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { LogEntry, ProjectConfig, ProjectStatus } from '../shared/types.js';
import { LogBuffer } from './log-buffer.js';
import { assertPortCanBind, findListeningPids, processGroupId } from './ports.js';

interface ManagedProcess {
  child: ChildProcess;
  pid: number;
  startedAt: string;
  exitCode?: number | null;
  error?: string;
  stopping?: boolean;
  logs: LogBuffer;
}

export class ProjectProcessManager extends EventEmitter {
  private readonly processes = new Map<string, ManagedProcess>();

  async status(project: ProjectConfig): Promise<ProjectStatus> {
    if (project.kind === 'unsupported') return { state: 'unsupported', portPids: [], error: project.unsupportedReason };
    const record = this.processes.get(project.id);
    const portPids = project.port ? await findListeningPids(project.port) : [];
    if (record && record.exitCode === undefined) {
      const ownGroup = await this.listenerBelongsTo(record.pid, portPids);
      return {
        state: portPids.length > 0 && !ownGroup ? 'conflict' : 'managed',
        pid: portPids[0] ?? record.pid,
        startedAt: record.startedAt,
        portPids,
        error: portPids.length > 0 && !ownGroup ? `端口 ${project.port} 被非受管进程占用` : undefined
      };
    }
    if (portPids.length > 0) return { state: 'external', pid: portPids[0], portPids, error: `端口 ${project.port} 正由外部进程监听` };
    if (record?.exitCode !== undefined && record.exitCode !== 0) {
      return { state: 'failed', pid: record.pid, startedAt: record.startedAt, exitCode: record.exitCode, portPids, error: record.error };
    }
    return { state: 'stopped', portPids, exitCode: record?.exitCode };
  }

  async start(project: ProjectConfig): Promise<ProjectStatus> {
    this.requireWeb(project);
    const current = await this.status(project);
    if (current.state === 'managed') return current;
    if (current.portPids.length > 0) throw new Error(`端口 ${project.port} 正被 PID ${current.portPids.join(', ')} 占用；请先接管或停止它`);
    await assertPortCanBind(project.port);
    await this.preflight(project);
    const logs = new LogBuffer();
    const command = [
      'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; elif [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi',
      `exec ${project.command}`
    ].join('; ');
    const child = spawn('bash', ['-lc', command], {
      cwd: project.cwd,
      env: { ...process.env, ...project.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!child.pid) throw new Error('无法创建服务进程');
    const record: ManagedProcess = { child, pid: child.pid, startedAt: new Date().toISOString(), logs };
    this.processes.set(project.id, record);
    this.attachOutput(project.id, record, 'stdout');
    this.attachOutput(project.id, record, 'stderr');
    child.once('error', (error) => this.finish(project.id, record, null, error.message));
    child.once('exit', (code) => this.finish(project.id, record, code, code === 0 ? undefined : `服务退出，退出码 ${code ?? 'signal'}`));
    this.emitChange();
    return this.status(project);
  }

  async stop(project: ProjectConfig): Promise<ProjectStatus> {
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

  async restart(project: ProjectConfig): Promise<ProjectStatus> {
    await this.stop(project);
    return this.start(project);
  }

  async takeover(project: ProjectConfig, confirmPort: number, confirmPid: number): Promise<ProjectStatus> {
    this.requireWeb(project);
    if (confirmPort !== project.port) throw new Error('确认端口与项目配置不一致');
    const pids = await findListeningPids(confirmPort);
    if (!pids.includes(confirmPid)) throw new Error('确认 PID 不再监听指定端口；请刷新后重试');
    const own = this.processes.get(project.id);
    if (own && own.exitCode === undefined) throw new Error('项目已有受管进程，不能接管外部进程');
    const expectedCwd = await realpath(project.cwd).catch(() => { throw new Error(`无法验证项目工作目录: ${project.cwd}`); });
    const listenerCwd = await realpath(`/proc/${confirmPid}/cwd`).catch(() => undefined);
    if (listenerCwd !== expectedCwd) {
      throw new Error(`拒绝接管 PID ${confirmPid}：其工作目录无法确认属于 ${project.cwd}`);
    }
    try { process.kill(confirmPid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await waitForPortToClose(confirmPort);
    return this.start(project);
  }

  logs(projectId: string): LogEntry[] { return this.processes.get(projectId)?.logs.list() ?? []; }

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

  private async listenerBelongsTo(groupLeader: number, listenerPids: number[]): Promise<boolean> {
    if (!listenerPids.length) return true;
    const groups = await Promise.all(listenerPids.map(processGroupId));
    return groups.some((group) => group === groupLeader);
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

  private requireWeb(project: ProjectConfig): asserts project is ProjectConfig & Required<Pick<ProjectConfig, 'command' | 'packageManager' | 'port'>> {
    if (project.kind !== 'web' || !project.command || !project.packageManager || !project.port) throw new Error(project.unsupportedReason ?? '该项目暂不支持服务控制');
  }

  private emitChange(): void { this.emit('change'); }
}

async function terminateManagedProcessGroup(pid: number): Promise<void> {
  const groupId = await processGroupId(pid);
  if (!groupId) throw new Error(`无法安全确定 PID ${pid} 的进程组`);
  try { process.kill(-groupId, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForManagedProcessToExit(record: ManagedProcess): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (record.exitCode !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`受管进程 ${record.pid} 未在三秒内停止`);
}

async function waitForPortToClose(port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await findListeningPids(port)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`端口 ${port} 未在两秒内释放`);
}
