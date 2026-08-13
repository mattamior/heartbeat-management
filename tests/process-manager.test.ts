import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../shared/types.js';
import { ProjectProcessManager } from '../server/process-manager.js';
import { findListeningPids } from '../server/ports.js';

const managers: Array<{ manager: ProjectProcessManager; project: ProjectConfig }> = [];
const externalProcesses: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(async ({ manager, project }) => { await manager.stop(project).catch(() => undefined); }));
  for (const child of externalProcesses.splice(0)) {
    if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Process was already taken over. */ }
  }
});

function projectFor(cwd: string, port: number): ProjectConfig {
  return {
    id: `test-service-${port}`, name: 'Test Service', kind: 'web', cwd,
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

  it('only takes over a single external listener whose resolved cwd matches the project', async () => {
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
    await manager.takeover(project, port, external.pid!);
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
    await expect(manager.takeover(project, port, external.pid!)).rejects.toThrow('拒绝接管');
    expect(await findListeningPids(port)).toContain(external.pid);
  });
});
