import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const MAX_README_BYTES = 256 * 1024;
const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm'] as const;

export type PackageManager = typeof PACKAGE_MANAGERS[number];

export interface ProjectSuggestion {
  directory: string;
  id: string;
  name: string;
  command?: string;
  packageManager?: PackageManager;
  port?: number;
  url?: string;
  readmePath?: string;
  missing: Array<'启动命令' | '包管理器' | '端口' | '访问链接'>;
}

export async function inspectProjectDirectory(candidate: string): Promise<ProjectSuggestion> {
  const directory = resolve(candidate);
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error(`项目目录不是文件夹: ${candidate}`);

  const entries = await readdir(directory, { withFileTypes: true });
  const readmeEntry = entries.find((entry) => entry.isFile() && /^readme(?:\.[a-z0-9_-]+)*$/i.test(entry.name));
  const readmePath = readmeEntry ? join(directory, readmeEntry.name) : undefined;
  const readme = readmePath ? await readTextPrefix(readmePath) : '';
  const fallbackManager = packageManagerFromFiles(entries.map((entry) => entry.name));
  const command = findCommand(readme);
  const packageManager = command?.packageManager ?? fallbackManager;
  const url = findLocalUrl(readme);
  const port = url?.port ?? findPort(command?.text ?? '') ?? findPort(readme);
  const accessUrl = url?.url ?? (port ? `http://127.0.0.1:${port}` : undefined);
  const missing: ProjectSuggestion['missing'] = [];
  if (!command) missing.push('启动命令');
  if (!packageManager) missing.push('包管理器');
  if (!port) missing.push('端口');
  if (!accessUrl) missing.push('访问链接');

  return {
    directory,
    id: toProjectId(basename(directory)),
    name: findProjectName(readme) ?? basename(directory),
    command: command?.text,
    packageManager,
    port,
    url: accessUrl,
    readmePath,
    missing,
  };
}

async function readTextPrefix(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_README_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function findProjectName(readme: string): string | undefined {
  const heading = readme.match(/^\s*#\s+(.+?)\s*$/m)?.[1];
  if (!heading) return undefined;
  const name = heading.replace(/[`*_]/g, '').trim();
  return name || undefined;
}

function findCommand(readme: string): { text: string; packageManager: PackageManager } | undefined {
  const matches = [...readme.matchAll(/\b(npm\s+(?:run\s+)?(?:dev|start|serve)|pnpm\s+(?:run\s+)?(?:dev|start|serve)|yarn\s+(?:run\s+)?(?:dev|start|serve))\b[^\r\n`]*/gi)];
  if (matches.length === 0) return undefined;
  const values = matches.map((match) => match[0].trim());
  const text = values.find((value) => /\bdev\b/i.test(value)) ?? values[0];
  const packageManager = PACKAGE_MANAGERS.find((manager) => new RegExp(`^${manager}\\b`, 'i').test(text));
  return packageManager ? { text, packageManager } : undefined;
}

function findLocalUrl(readme: string): { url: string; port?: number } | undefined {
  const match = readme.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{1,5}))?(?:\/[^\s`'"<>()\]}]*)?/i);
  if (!match) return undefined;
  const url = match[0];
  const port = parsePort(match[1]);
  return { url, port };
}

function findPort(text: string): number | undefined {
  const option = text.match(/--(?:port|p)\s*(?:=\s*)?(\d{1,5})\b/i)?.[1];
  const labelled = text.match(/(?:\bport\b|端口)\s*(?:为|是|:|：|=)?\s*(\d{1,5})\b/i)?.[1];
  return parsePort(option ?? labelled);
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function packageManagerFromFiles(files: string[]): PackageManager | undefined {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json')) return 'npm';
  return undefined;
}

function toProjectId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return id || 'project';
}
