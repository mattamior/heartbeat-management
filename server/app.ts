import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { ProjectConfig } from '../shared/types.js';
import { ProjectStore } from './config.js';
import { inspectProjectDirectory } from './project-inspection.js';
import { ProcessOperationError, ProjectProcessManager, RuntimePreflightError, type ExtendedProjectStatus, type TakeoverSnapshot } from './process-manager.js';

export interface AppOptions {
  configFile?: string;
  store?: ProjectStore;
  manager?: ProjectProcessManager;
  staticDir?: string;
}

const execFileAsync = promisify(execFile);

interface CommandFailure extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
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
    if (error instanceof ProcessOperationError) {
      const statusCode = error.code.startsWith('TAKEOVER_') && !error.code.endsWith('START_FAILED') ? 409 : 400;
      const terminatedPids = error.terminated.map(({ pid }) => pid);
      const failure = {
        code: error.code,
        phase: error.phase,
        operation: 'takeover',
        terminated: error.terminated,
        terminatedPids,
        diagnostic: error.diagnostic,
        diagnostics: error.diagnostic,
        restored: error.restored,
        restoreFailed: error.restoreFailed,
        restoreResults: error.restoreResults
      };
      reply.code(statusCode).send({
        message,
        code: error.code,
        phase: error.phase,
        terminated: error.terminated,
        terminatedPids,
        diagnostic: error.diagnostic,
        diagnostics: error.diagnostic,
        restored: error.restored,
        restoreFailed: error.restoreFailed,
        restoreResults: error.restoreResults,
        failure,
        details: failure,
        refreshRequired: error.code === 'TAKEOVER_STALE'
      });
      return;
    }
    if (error instanceof RuntimePreflightError) {
      reply.code(400).send({ message, code: 'RUNTIME_UNAVAILABLE', diagnostics: error.diagnostic });
      return;
    }
    reply.code(validation ? 400 : 400).send({ message });
  });

  const views = async (): Promise<Array<ProjectConfig & { status: ExtendedProjectStatus }>> => Promise.all((await store.read()).map(async (project) => ({ ...project, status: await manager.status(project) })));
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
  app.post('/api/project-directory-picker', async () => ({ directory: await chooseProjectDirectory() }));
  app.post<{ Body: { directory?: unknown } }>('/api/project-inspection', async (request) => {
    if (typeof request.body?.directory !== 'string' || !request.body.directory.trim()) throw new Error('请选择项目目录');
    return inspectProjectDirectory(request.body.directory);
  });
  app.post<{ Body: unknown }>('/api/projects', async (request) => {
    const project = await store.create(request.body);
    const view = { ...project, status: await manager.status(project) };
    await broadcast('status', await views());
    return view;
  });
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
  app.post<{ Params: { id: string }; Body: { confirm?: boolean; force?: boolean; confirmPort?: number; acknowledgement?: string; snapshot?: unknown } }>('/api/projects/:id/takeover', async (request) => {
    const project = await projectById(request.params.id);
    if (request.body?.confirm !== true) throw new Error('接管必须确认 confirm: true 和完整 snapshot');
    const snapshot = parseTakeoverSnapshot(request.body.snapshot);
    if (request.body.force === true) {
      if (request.body.confirmPort !== project.port || request.body.acknowledgement !== String(project.port)) {
        throw new Error('强制释放端口必须确认当前项目端口');
      }
      return { status: await manager.forceTakeover(project, snapshot) };
    }
    return { status: await manager.takeover(project, snapshot) };
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
    const staticRoot = resolve(staticDir);
    app.get('/*', async (request, reply) => {
      // Keep the SPA fallback, but serve a real public/build file first. This
      // also covers files added after static route enumeration in production.
      let pathname: string;
      try {
        pathname = decodeURIComponent((request.raw.url ?? '/').split('?', 1)[0]);
      } catch {
        pathname = '/';
      }

      if (pathname.startsWith('/') && !pathname.includes('\0') && !pathname.includes('\\')) {
        const candidate = resolve(staticRoot, `.${pathname}`);
        const relativePath = relative(staticRoot, candidate);
        const escapesRoot = relativePath === '..'
          || relativePath.startsWith(`..${sep}`)
          || isAbsolute(relativePath);
        if (!escapesRoot) {
          try {
            if (statSync(candidate).isFile()) return reply.sendFile(relativePath, staticRoot);
          } catch {
            // A missing or unreadable path is a client-side route.
          }
        }
      }

      return reply.sendFile('index.html', staticRoot);
    });
  }
  return app;
}

async function chooseProjectDirectory(): Promise<string | undefined> {
  if (process.platform !== 'darwin') throw new Error('当前系统暂不支持原生目录选择器；请手动填写项目目录。');
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'], { timeout: 120_000 });
    const directory = stdout.trim();
    return directory || undefined;
  } catch (error) {
    const detail = error as CommandFailure;
    if (detail.killed || detail.signal || detail.code === 1) return undefined;
    throw new Error('无法打开系统目录选择器');
  }
}

function parseTakeoverSnapshot(value: unknown): TakeoverSnapshot {
  if (!value || typeof value !== 'object') throw new Error('接管必须提供完整 snapshot');
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.port) || !Array.isArray(record.listeners)) throw new Error('接管 snapshot 必须包含 port 和 listeners');
  const listeners = record.listeners.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('接管 snapshot 包含无效监听进程');
    const listener = value as Record<string, unknown>;
    if (!Number.isInteger(listener.pid) || typeof listener.visibility !== 'string') throw new Error('接管 snapshot 包含无效监听进程');
    if (listener.startedAt !== undefined && typeof listener.startedAt !== 'string') throw new Error('接管 snapshot 包含无效启动时间');
    if (listener.cwd !== undefined && typeof listener.cwd !== 'string') throw new Error('接管 snapshot 包含无效工作目录');
    if (listener.command !== undefined && typeof listener.command !== 'string') throw new Error('接管 snapshot 包含无效命令摘要');
    if (listener.commandSummary !== undefined && typeof listener.commandSummary !== 'string') throw new Error('接管 snapshot 包含无效命令摘要');
    if (listener.pgid !== undefined && !Number.isInteger(listener.pgid)) throw new Error('接管 snapshot 包含无效进程组');
    if (listener.groupPids !== undefined && (!Array.isArray(listener.groupPids) || listener.groupPids.some((pid) => !Number.isInteger(pid)))) throw new Error('接管 snapshot 包含无效进程组成员');
    if (listener.groupComplete !== undefined && typeof listener.groupComplete !== 'boolean') throw new Error('接管 snapshot 包含无效进程组状态');
    if (listener.visibility !== 'visible' && listener.visibility !== 'unavailable') throw new Error('接管 snapshot 包含无效可见性');
    if (listener.side !== undefined && listener.side !== 'wsl' && listener.side !== 'windows') throw new Error('接管 snapshot 包含无效占用侧');
    if (listener.source !== undefined && typeof listener.source !== 'string') throw new Error('接管 snapshot 包含无效占用来源');
    if (listener.manageable !== undefined && typeof listener.manageable !== 'boolean') throw new Error('接管 snapshot 包含无效可管理标记');
    if (listener.elevationRequired !== undefined && typeof listener.elevationRequired !== 'boolean') throw new Error('接管 snapshot 包含无效权限标记');
    if (listener.processName !== undefined && typeof listener.processName !== 'string') throw new Error('接管 snapshot 包含无效进程名');
    if (listener.serviceName !== undefined && typeof listener.serviceName !== 'string') throw new Error('接管 snapshot 包含无效服务名');
    if (listener.serviceLookup !== undefined && listener.serviceLookup !== 'known' && listener.serviceLookup !== 'none' && listener.serviceLookup !== 'unavailable') throw new Error('接管 snapshot 包含无效服务识别状态');
    if (listener.rule !== undefined) {
      if (!listener.rule || typeof listener.rule !== 'object') throw new Error('接管 snapshot 包含无效 Windows 端口规则');
      const rule = listener.rule as Record<string, unknown>;
      if (typeof rule.family !== 'string' || typeof rule.listenAddress !== 'string' || !Number.isInteger(rule.listenPort) || typeof rule.connectAddress !== 'string' || !Number.isInteger(rule.connectPort) || typeof rule.ruleKey !== 'string') throw new Error('接管 snapshot 包含不完整 Windows 端口规则');
    }
    return listener as TakeoverSnapshot['listeners'][number];
  });
  return { port: record.port as number, listeners };
}
