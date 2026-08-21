import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ProjectConfig } from '../shared/types.js';

const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096));
const projectFieldsSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['web', 'unsupported']),
  cwd: z.string().min(1),
  command: z.string().trim().min(1).max(4000).optional(),
  packageManager: z.enum(['npm', 'yarn', 'pnpm']).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  url: z.string().url().max(2048).optional(),
  env: envSchema.optional(),
  unsupportedReason: z.string().trim().min(1).max(500).optional()
});

const baseProjectSchema = projectFieldsSchema.superRefine((project, ctx) => {
  if (project.kind === 'web' && (!project.command || !project.packageManager || !project.port || !project.url)) {
    ctx.addIssue({ code: 'custom', message: 'Web 项目必须包含 command、packageManager、port 和 url' });
  }
  if (project.kind === 'web' && project.port && project.url) {
    const url = new URL(project.url);
    const urlPort = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    if (urlPort !== project.port) ctx.addIssue({ code: 'custom', message: '状态检测端口必须与访问链接端口一致', path: ['url'] });
  }
  if (project.kind === 'unsupported' && !project.unsupportedReason) {
    ctx.addIssue({ code: 'custom', message: '暂不支持项目必须包含 unsupportedReason' });
  }
});

export const projectSchema = baseProjectSchema.transform((project) => ({
  ...project,
  cwd: assertProjectPath(project.cwd)
}));
export const projectUpdateSchema = projectFieldsSchema.omit({ id: true }).partial().strict();

export function assertProjectPath(candidate: string): string {
  let resolvedProject: string;
  try {
    resolvedProject = realpathSync(resolve(candidate));
  } catch {
    throw new Error(`工作目录不存在或无法解析: ${candidate}`);
  }
  return resolvedProject;
}

/** @deprecated Project directories are no longer limited to a fixed root. */
export const assertSiblingProjectPath = assertProjectPath;

export class ProjectStore {
  constructor(readonly configFile: string) {}

  async read(): Promise<ProjectConfig[]> {
    try {
      return this.parse(await readFile(this.configFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const projects: ProjectConfig[] = [];
      await this.write(projects);
      return projects;
    }
  }

  async update(id: string, patch: unknown): Promise<ProjectConfig> {
    const partial = projectUpdateSchema.parse(patch);
    const projects = await this.read();
    const index = projects.findIndex((project) => project.id === id);
    if (index < 0) throw new Error('项目不存在');
    const candidate = projectSchema.parse({ ...projects[index], ...partial, id });
    projects[index] = candidate;
    await this.write(projects);
    return candidate;
  }

  async create(input: unknown): Promise<ProjectConfig> {
    const candidate = projectSchema.parse(input);
    const projects = await this.read();
    if (projects.some((project) => project.id === candidate.id)) throw new Error(`项目 ID 已存在: ${candidate.id}`);
    projects.push(candidate);
    await this.write(projects);
    return candidate;
  }

  private parse(json: string): ProjectConfig[] {
    const parsed = z.array(projectSchema).parse(JSON.parse(json));
    const ids = new Set<string>();
    for (const project of parsed) {
      if (ids.has(project.id)) throw new Error(`重复项目 ID: ${project.id}`);
      ids.add(project.id);
    }
    return parsed;
  }

  private async write(projects: ProjectConfig[]): Promise<void> {
    await mkdir(dirname(this.configFile), { recursive: true });
    const tempFile = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
    await rename(tempFile, this.configFile);
  }
}
