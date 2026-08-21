import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../shared/types.js';
import { ProjectProcessManager } from '../server/process-manager.js';
import { findListeningPids, PortBindError } from '../server/ports.js';
import { WindowsPortManager, type WindowsCommandExecutor } from '../server/windows-ports.js';

const managers: Array<{ manager: ProjectProcessManager; project: ProjectConfig }> = [];
const externalProcesses: ChildProcess[] = [];
const inheritedProcesses: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(async ({ manager, project }) => { await manager.stop(project).catch(() => undefined); }));
  for (const child of externalProcesses.splice(0)) {
    if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Process was already taken over. */ }
  }
  for (const child of inheritedProcesses.splice(0)) child.kill('SIGTERM');
});

function projectFor(cwd: string, port: number): ProjectConfig {
  return {
    id: `test-service-${port}`, name: 'Test Service', kind: 'web', cwd: realpathSync(cwd),
    command: `node -e "require('node:http').createServer((_, res) => res.end('ok')).listen(${port}, '127.0.0.1')"`,
    packageManager: 'npm', port, url: `http://127.0.0.1:${port}`
  };
}

function launchExternal(cwd: string, port: number): ChildProcess {
  const child = spawn(process.execPath, ['-e', `require('node:http').createServer((_, res) => res.end('external')).listen(${port}, '127.0.0.1')`], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  externalProcesses.push(child);
  return child;
}

function launchExternalInManagerGroup(cwd: string, port: number): ChildProcess {
  const child = spawn(process.execPath, ['-e', `require('node:http').createServer((_, res) => res.end('inherited')).listen(${port}, '127.0.0.1')`], { cwd, stdio: 'ignore' });
  child.unref();
  inheritedProcesses.push(child);
  return child;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw lastError;
}

describe('ProjectProcessManager', () => {
  it('surfaces a manageable Windows portproxy candidate for the same project port', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-windows-portproxy-'));
    const project = projectFor(cwd, port);
    const executor: WindowsCommandExecutor = {
      async run(file, args) {
        if (file === 'netsh.exe' && args[3] === 'v4tov4') return { stdout: `0.0.0.0 ${port} 127.0.0.1 ${port}\n` };
        return { stdout: '' };
      }
    };
    const manager = new ProjectProcessManager({ windows: new WindowsPortManager({ enabled: true, executor }) });
    const status = await manager.status(project);
    expect(status).toMatchObject({ state: 'external', invisiblePort: true, portPids: [] });
    expect(status.candidates?.[0]).toMatchObject({ side: 'windows', source: 'windows-portproxy', manageable: true, pid: 0 });
  });

  it('reports invisible occupancy once when binding fails without visible listeners', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-invisible-port-'));
    const project = projectFor(cwd, port);
    const manager = new ProjectProcessManager({
      assertPortCanBind: async () => { throw new PortBindError(port, 'PORT_IN_USE', 'EADDRINUSE', `端口 ${port} 已被占用，无法绑定`); }
    });

    const status = await manager.status(project);
    expect(status).toMatchObject({ state: 'conflict', invisiblePort: true, portPids: [], listeners: [] });
    expect(status.error).toBeUndefined();
  });

  it('starts a detached process group, recognizes it as managed, and stops it', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-process-'));
    const project = projectFor(cwd, port);
    const manager = new ProjectProcessManager();
    managers.push({ manager, project });
    await manager.start(project);
    await eventually(async () => expect((await manager.status(project)).state).toBe('managed'));
    const restarted = await manager.restart(project);
    expect(restarted.state).toBe('managed');
    const stopped = await manager.stop(project);
    expect(['managed', 'stopped']).toContain(stopped.state);
    await eventually(async () => expect((await manager.status(project)).state).toBe('stopped'));
  });

  it('takes over a confirmed complete listener snapshot whose resolved cwd matches the project', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-takeover-'));
    const project = projectFor(cwd, port);
    const manager = new ProjectProcessManager();
    managers.push({ manager, project });
    const external = launchExternal(cwd, port);
    await eventually(async () => expect(await findListeningPids(port)).toContain(external.pid));
    const status = await manager.status(project);
    expect(status.state).toBe('external');
    expect(status.pid).toBe(external.pid);
    expect(status.listeners).toHaveLength(1);
    expect(status.listeners[0]).toMatchObject({ pid: external.pid, cwd: project.cwd, visibility: 'visible', groupComplete: true });
    await manager.takeover(project, { port, listeners: status.listeners });
    await eventually(async () => expect((await manager.status(project)).state).toBe('managed'));
  });

  it('refuses takeover when the external listener cwd does not belong to the project', async () => {
    const port = await unusedPort();
    const projectCwd = await mkdtemp(join(tmpdir(), 'heartbeat-project-'));
    const otherCwd = await mkdtemp(join(tmpdir(), 'heartbeat-other-'));
    const project = projectFor(projectCwd, port);
    const manager = new ProjectProcessManager();
    const external = launchExternal(otherCwd, port);
    await eventually(async () => expect(await findListeningPids(port)).toContain(external.pid));
    const status = await manager.status(project);
    await expect(manager.takeover(project, { port, listeners: status.listeners })).rejects.toThrow('拒绝接管');
    expect((await manager.status(project)).state).toBe('external');
    expect(await findListeningPids(port)).toContain(external.pid);
  });

  it('rejects a stale snapshot before sending a termination signal', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-stale-takeover-'));
    const project = projectFor(cwd, port);
    const manager = new ProjectProcessManager();
    managers.push({ manager, project });
    const external = launchExternal(cwd, port);
    await eventually(async () => expect(await findListeningPids(port)).toContain(external.pid));
    const status = await manager.status(project);
    expect(status.listeners).toHaveLength(1);
    const stale = { ...status.listeners[0], startedAt: `${status.listeners[0].startedAt}-stale` };
    await expect(manager.takeover(project, { port, listeners: [stale] })).rejects.toThrow('状态已变化');
    expect((await manager.status(project)).state).toBe('external');
    expect(await findListeningPids(port)).toContain(external.pid);
  });

  it('refuses a listener in the manager process group', async () => {
    const port = await unusedPort();
    const cwd = await mkdtemp(join(tmpdir(), 'heartbeat-self-group-'));
    const project = projectFor(cwd, port);
    const manager = new ProjectProcessManager();
    managers.push({ manager, project });
    const external = launchExternalInManagerGroup(cwd, port);
    await eventually(async () => expect(await findListeningPids(port)).toContain(external.pid));
    const status = await manager.status(project);
    await expect(manager.takeover(project, { port, listeners: status.listeners })).rejects.toThrow('管理器自身进程');
    expect((await manager.status(project)).state).toBe('external');
    expect(await findListeningPids(port)).toContain(external.pid);
  });
});
