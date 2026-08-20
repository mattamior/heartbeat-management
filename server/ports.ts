import { execFile } from 'node:child_process';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import type { ListenerSide, ListenerSource, PortProxyRule } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export type PortBindErrorCode = 'PORT_IN_USE' | 'PORT_BIND_FAILED';

/** A bind probe failed; callers can distinguish occupancy from other errors. */
export class PortBindError extends Error {
  constructor(
    public readonly port: number,
    public readonly code: PortBindErrorCode,
    public readonly systemCode: string | undefined,
    message: string
  ) {
    super(message);
    this.name = 'PortBindError';
  }
}

export interface ProcessSnapshot {
  pid: number;
  /** The kernel process start-time token; it is stable across PID reuse. */
  startedAt?: string;
  cwd?: string;
  command?: string;
  commandSummary?: string;
  pgid?: number;
  groupPids?: number[];
  visibility: 'visible' | 'unavailable';
  side?: ListenerSide;
  source?: ListenerSource | string;
  manageable?: boolean;
  elevationRequired?: boolean;
  processName?: string;
  serviceName?: string;
  serviceLookup?: 'known' | 'none' | 'unavailable' | string;
  rejectionReason?: string;
  rule?: PortProxyRule;
}

export interface ListeningProcessSnapshot extends ProcessSnapshot {
  groupComplete: boolean;
}

export interface ProcessGroupScan {
  pids: number[];
  complete: boolean;
}

export async function findListeningPids(port: number): Promise<number[]> {
  if (process.platform === 'darwin') return findListeningPidsFromLsof(port);
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`]);
    const pids = [...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
    if (pids.length > 0) return uniquePids(pids.join('\n'));
  } catch {
    // `ss` is not installed in every WSL distribution. Fall through to /proc.
  }
  return findListeningPidsFromProc(port);
}

/** macOS has no Linux /proc socket table, so query its built-in lsof instead. */
async function findListeningPidsFromLsof(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return uniquePids(stdout);
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    // lsof exits 1 when no process is listening; that is a normal status.
    if (detail.code === '1') return [];
    return [];
  }
}

/**
 * Return all listener candidates and enough process identity information for a
 * caller to make a safe, explicit takeover decision.  A process that disappears
 * while /proc is being read is retained as an unavailable candidate: silently
 * dropping it would make a takeover unsafe.
 */
export async function inspectListeningProcesses(port: number): Promise<ListeningProcessSnapshot[]> {
  const pids = await findListeningPids(port);
  return Promise.all(pids.map(async (pid) => {
    const process = await inspectProcess(pid);
    if (!process) return { pid, visibility: 'unavailable', groupComplete: false };
    const groupScan = process.pgid ? await scanProcessGroup(process.pgid) : { pids: [], complete: false };
    const groupPids = groupScan.pids;
    const groupMembers = await Promise.all(groupPids.map((member) => inspectProcess(member)));
    return {
      ...process,
      side: 'wsl',
      source: 'linux-process',
      manageable: true,
      visibility: process.startedAt && process.cwd && process.pgid ? 'visible' : 'unavailable',
      groupPids,
      groupComplete: Boolean(process.pgid && groupScan.complete && groupPids.length > 0 && groupMembers.every((member) => member?.cwd && member.pgid === process.pgid))
    };
  }));
}

export async function inspectProcess(pid: number): Promise<ProcessSnapshot | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    // After comm, fields[0] is state.  The process group and start time are
    // fields 3 and 20 in this zero-based tail respectively.
    const pgid = Number.parseInt(fields[2] ?? '', 10);
    const startedAt = fields[19];
    const cwd = await realpath(`/proc/${pid}/cwd`).catch(() => undefined);
    const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const command = (commandLine.includes('\0') ? commandLine.split('\0').filter(Boolean).join(' ') : commandLine).trim()
      .slice(0, 1000) || stat.slice(1, commandEnd).slice(0, 1000);
    return {
      pid,
      startedAt: startedAt || undefined,
      cwd,
      command,
      commandSummary: command,
      pgid: Number.isSafeInteger(pgid) && pgid > 1 ? pgid : undefined,
      visibility: 'visible'
    };
  } catch {
    return undefined;
  }
}

export async function processGroupMembers(pgid: number): Promise<number[]> {
  return (await scanProcessGroup(pgid)).pids;
}

/**
 * Scan /proc conservatively. A disappearing process, unreadable process
 * metadata, or an unreadable /proc directory is treated as incomplete rather
 * than omitted from a group that might later be signalled.
 */
export async function scanProcessGroup(pgid: number): Promise<ProcessGroupScan> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return { pids: [], complete: false };
  let entries;
  try { entries = await readdir('/proc', { withFileTypes: true }); }
  catch { return { pids: [], complete: false }; }
  const processEntries = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
  let complete = true;
  const members = await Promise.all(processEntries.map(async (entry) => {
    const process = await inspectProcess(Number.parseInt(entry.name, 10));
    if (!process) { complete = false; return undefined; }
    return process.pgid === pgid ? process.pid : undefined;
  }));
  return {
    pids: members.flatMap((pid) => typeof pid === 'number' ? [pid] : []).sort((a, b) => a - b),
    complete
  };
}

async function findListeningPidsFromProc(port: number): Promise<number[]> {
  const listeningInodes = new Set<string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const contents = await readFile(file, 'utf8').catch(() => '');
    for (const inode of parseProcTcpListeningInodes(contents, port)) listeningInodes.add(inode);
  }
  if (listeningInodes.size === 0) return [];

  const processEntries = await readdir('/proc', { withFileTypes: true }).catch(() => []);
  const pids = await Promise.all(processEntries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      const fdNames = await readdir(`/proc/${entry.name}/fd`).catch(() => []);
      for (const fdName of fdNames) {
        const target = await readlink(`/proc/${entry.name}/fd/${fdName}`).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && listeningInodes.has(inode)) return Number.parseInt(entry.name, 10);
      }
      return undefined;
    }));
  return pids.flatMap((pid) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? [pid] : []);
}

/** Parse the kernel's /proc/net/tcp table without relying on ss or lsof. */
export function parseProcTcpListeningInodes(contents: string, port: number): Set<string> {
  const listeningInodes = new Set<string>();
  const expectedPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const line of contents.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    // /proc/net/tcp's inode is field [9]. Field [11] is not the inode on
    // current kernels and made the fallback silently miss real listeners.
    if (fields[1]?.endsWith(`:${expectedPort}`) && fields[3] === '0A' && fields[9]) listeningInodes.add(fields[9]);
  }
  return listeningInodes;
}

/**
 * Linux listener inspection cannot see Windows services. In WSL, a Windows service can
 * reserve a port without appearing there, so verify that the target can bind
 * before reporting a launched process as managed.
 */
export async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port, exclusive: true });
    });
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    if (detail.code === 'EADDRINUSE') {
      throw new PortBindError(port, 'PORT_IN_USE', detail.code, `端口 ${port} 已被占用，无法绑定`);
    }
    throw new PortBindError(port, 'PORT_BIND_FAILED', detail.code, `端口 ${port} 无法绑定：${detail.message}`);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function processGroupId(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)]);
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch { return undefined; }
}

function uniquePids(output: string): number[] {
  return [...new Set(output.split(/\s+/).map((value) => Number.parseInt(value, 10)).filter((value) => Number.isSafeInteger(value) && value > 1))];
}
