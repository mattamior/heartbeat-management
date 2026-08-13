import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { ProjectConfig, ProjectView } from '../shared/types.js';
import { ProjectStore } from './config.js';
import { ProjectProcessManager } from './process-manager.js';

export interface AppOptions {
  configFile?: string;
  store?: ProjectStore;
  manager?: ProjectProcessManager;
  staticDir?: string;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = body.toString();
    if (text.trim().length === 0) return done(null, undefined);
    try {
      return done(null, JSON.parse(text));
    } catch (error) {
      return done(error as Error, undefined);
    }
  });
  const store = options.store ?? new ProjectStore(options.configFile ?? join(process.cwd(), 'data', 'projects.json'));
  const manager = options.manager ?? new ProjectProcessManager();
  const staticDir = options.staticDir ?? join(process.cwd(), 'dist', 'client');
  const clients = new Set<NodeJS.WritableStream>();

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
    reply.header('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
  });
  app.options('*', async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, _request, reply) => {
    const validation = error instanceof ZodError;
    const message = error instanceof Error ? error.message : '请求失败';
    reply.code(validation ? 400 : 400).send({ message });
  });

  const views = async (): Promise<ProjectView[]> => Promise.all((await store.read()).map(async (project) => ({ ...project, status: await manager.status(project) })));
  const projectById = async (id: string): Promise<ProjectConfig> => {
    const project = (await store.read()).find((candidate) => candidate.id === id);
    if (!project) throw new Error('项目不存在');
    return project;
  };
  const broadcast = async (event: string, data: unknown): Promise<void> => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  };
  manager.on('change', () => { void views().then((value) => broadcast('status', value)); });
  manager.on('log', (projectId, entry) => { void broadcast('log', { projectId, entry }); });

  app.get('/api/projects', async () => ({ projects: await views() }));
  app.put<{ Params: { id: string }; Body: unknown }>('/api/projects/:id', async (request) => {
    const project = await store.update(request.params.id, request.body);
    return { ...project, status: await manager.status(project) };
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/logs', async (request) => {
    await projectById(request.params.id);
    return { entries: manager.logs(request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/start', async (request) => {
    const project = await projectById(request.params.id);
    return { status: await manager.start(project) };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/stop', async (request) => {
    const project = await projectById(request.params.id);
    return { status: await manager.stop(project) };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/restart', async (request) => {
    const project = await projectById(request.params.id);
    return { status: await manager.restart(project) };
  });
  app.post<{ Params: { id: string }; Body: { confirm?: boolean; confirmPort?: number; confirmPid?: number } }>('/api/projects/:id/takeover', async (request) => {
    const project = await projectById(request.params.id);
    const { confirmPort, confirmPid } = request.body ?? {};
    if (request.body?.confirm !== true || !Number.isInteger(confirmPort) || !Number.isInteger(confirmPid)) throw new Error('接管必须确认 confirm: true、confirmPort 和 confirmPid');
    return { status: await manager.takeover(project, confirmPort as number, confirmPid as number) };
  });
  app.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const client = reply.raw;
    clients.add(client);
    client.write(': connected\n\n');
    client.write(`event: status\ndata: ${JSON.stringify(await views())}\n\n`);
    const heartbeat = setInterval(() => client.write(': heartbeat\n\n'), 20_000);
    request.raw.once('close', () => { clearInterval(heartbeat); clients.delete(client); });
    reply.hijack();
  });

  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  }
  return app;
}
