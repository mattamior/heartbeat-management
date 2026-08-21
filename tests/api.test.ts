import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectConfig } from '../shared/types.js';
import { buildApp } from '../server/app.js';
import { ProjectProcessManager } from '../server/process-manager.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function app(): Promise<FastifyInstance> {
  const folder = await mkdtemp(join(tmpdir(), 'heartbeat-api-'));
  const instance = await buildApp({ configFile: join(folder, 'projects.json'), staticDir: join(folder, 'no-static') });
  apps.push(instance);
  return instance;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function appWithTemporaryService(): Promise<{ server: FastifyInstance; manager: ProjectProcessManager; project: ProjectConfig }> {
  const folder = await mkdtemp(join(tmpdir(), 'heartbeat-api-service-'));
  const port = await unusedPort();
  const project: ProjectConfig = {
    id: 'temporary-service',
    name: 'Temporary Service',
    kind: 'web',
    cwd: process.cwd(),
    command: `node -e "require('node:http').createServer((_, response) => response.end('ok')).listen(${port}, '127.0.0.1')"`,
    packageManager: 'npm',
    port,
    url: `http://127.0.0.1:${port}`
  };
  const configFile = join(folder, 'projects.json');
  await writeFile(configFile, `${JSON.stringify([project])}\n`);
  const manager = new ProjectProcessManager();
  const server = await buildApp({ configFile, manager, staticDir: join(folder, 'no-static') });
  apps.push(server);
  return { server, manager, project };
}

describe('HTTP API', () => {
  it('starts empty and persists a manually added project', async () => {
    const server = await app();
    const listed = await server.inject('/api/projects');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().projects).toEqual([]);
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-api-project-'));
    const created = await server.inject({ method: 'POST', url: '/api/projects', payload: { id: 'manual-project', name: 'Manual Project', kind: 'web', cwd: directory, command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3000' } });
    expect(created.statusCode).toBe(200);
    const updated = await server.inject({ method: 'PUT', url: '/api/projects/manual-project', payload: { name: 'Renamed Project' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Renamed Project');
  });

  it('rejects an invalid directory update and requires explicit takeover confirmation', async () => {
    const { server, project } = await appWithTemporaryService();
    const invalid = await server.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: { cwd: '/tmp/nope' } });
    expect(invalid.statusCode).toBe(400);
    const takeover = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/takeover`, payload: {} });
    expect(takeover.statusCode).toBe(400);
    expect(takeover.json().message).toContain('confirm: true');
  });

  it('accepts start, stop, and restart requests with an empty JSON body', async () => {
    const { server, manager, project } = await appWithTemporaryService();
    try {
      for (const action of ['start', 'stop', 'restart'] as const) {
        const response = await server.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/${action}`,
          headers: { 'content-type': 'application/json' }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveProperty('status');
      }
    } finally {
      await manager.stop(project).catch(() => undefined);
    }
  });
});
