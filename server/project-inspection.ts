import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const MAX_README_BYTES = 256 * 1024;
const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm'] as const;
const SCRIPT_PRIORITIES = ['dev', 'start', 'serve'] as const;

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

interface PackageManifest {
  scripts: Record<string, string>;
}

interface CommandSuggestion {
  text: string;
  packageManager: PackageManager;
  script?: string;
}

export async function inspectProjectDirectory(candidate: string): Promise<ProjectSuggestion> {
  const directory = resolve(candidate);
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error(`项目目录不是文件夹: ${candidate}`);

  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const packageManager = packageManagerFromFiles(files);
  const manifest = files.includes('package.json') ? await readPackageManifest(join(directory, 'package.json')) : undefined;
  const packageCommand = manifest && packageManager ? commandFromPackageScripts(manifest, packageManager) : undefined;
  const readmeEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'readme.md');
  const readmePath = readmeEntry ? join(directory, readmeEntry.name) : undefined;
  const readme = readmePath ? await readTextPrefix(readmePath) : '';
  const readmeCommand = findCommand(readme);
  const command = packageCommand ?? readmeCommand;
  const resolvedManager = command?.packageManager ?? packageManager;
  const scriptText = packageCommand?.script ?? '';
  const scriptUrl = findLocalUrl(scriptText);
  const readmeUrl = findLocalUrl(readme);
  const scriptPort = scriptUrl?.port ?? findPort(scriptText);
  const port = scriptPort ?? readmeUrl?.port ?? findPort(command?.text ?? '') ?? findPort(readme);
  const host = findHost(scriptText);
  const accessUrl = scriptUrl?.url ?? (scriptPort ? toLocalUrl(host, scriptPort) : undefined) ?? readmeUrl?.url ?? (port ? toLocalUrl(undefined, port) : undefined);
  const missing: ProjectSuggestion['missing'] = [];
  if (!command) missing.push('启动命令');
  if (!resolvedManager) missing.push('包管理器');
  if (!port) missing.push('端口');
  if (!accessUrl) missing.push('访问链接');

  return {
    directory,
    id: toProjectId(basename(directory)),
    name: toDisplayName(basename(directory)),
    command: command?.text,
    packageManager: resolvedManager,
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

async function readPackageManifest(path: string): Promise<PackageManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readTextPrefix(path));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return { scripts: {} };
    return {
      scripts: Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    };
  } catch {
    return undefined;
  }
}

function commandFromPackageScripts(manifest: PackageManifest, packageManager: PackageManager): CommandSuggestion | undefined {
  const script = SCRIPT_PRIORITIES.find((candidate) => Boolean(manifest.scripts[candidate]?.trim()));
  if (!script) return undefined;
  return {
    text: commandForScript(packageManager, script),
    packageManager,
    script: manifest.scripts[script],
  };
}

function commandForScript(packageManager: PackageManager, script: string): string {
  if (packageManager === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
  return `${packageManager} ${script}`;
}

function findCommand(readme: string): CommandSuggestion | undefined {
  const matches = [...readme.matchAll(/\b(npm\s+(?:run\s+)?(?:dev|start|serve)|pnpm\s+(?:run\s+)?(?:dev|start|serve)|yarn\s+(?:run\s+)?(?:dev|start|serve))\b[^\r\n`]*/gi)];
  if (matches.length === 0) return undefined;
  const values = matches.map((match) => match[0].trim());
  const text = values.find((value) => /\bdev\b/i.test(value)) ?? values[0];
  const packageManager = PACKAGE_MANAGERS.find((manager) => new RegExp(`^${manager}\\b`, 'i').test(text));
  return packageManager ? { text, packageManager } : undefined;
}

function findLocalUrl(text: string): { url: string; port?: number } | undefined {
  const match = text.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{1,5}))?(?:\/[^\s`'"<>()\]}]*)?/i);
  if (!match) return undefined;
  const url = match[0];
  const port = parsePort(match[1]);
  return { url, port };
}

function findHost(text: string): string | undefined {
  const match = text.match(/(?:^|\s)HOST\s*=\s*(['"]?)([A-Za-z0-9.-]+)\1(?:\s|$)/i);
  if (!match) return undefined;
  const host = match[2].toLowerCase();
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

function toLocalUrl(host: string | undefined, port: number): string {
  return `http://${host ?? '127.0.0.1'}:${port}`;
}

function findPort(text: string): number | undefined {
  const option = text.match(/--(?:port|p)\s*(?:=\s*)?(\d{1,5})\b/i)?.[1];
  const environment = text.match(/(?:^|\s)PORT\s*=\s*['"]?(\d{1,5})\b/i)?.[1];
  const labelled = text.match(/(?:\bport\b|端口)\s*(?:为|是|:|：|=)?\s*(\d{1,5})\b/i)?.[1];
  return parsePort(option ?? environment ?? labelled);
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function packageManagerFromFiles(files: string[]): PackageManager | undefined {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('package-lock.json') || files.includes('npm-shrinkwrap.json')) return 'npm';
  return undefined;
}

function toDisplayName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'Project';
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ');
}

function toProjectId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return id || 'project';
}
