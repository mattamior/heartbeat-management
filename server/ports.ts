import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function findListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`]);
    const pids = [...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
    if (pids.length > 0) return uniquePids(pids.join('\n'));
  } catch {
    // `ss` is not installed in every WSL distribution. Fall through to /proc.
  }
  return findListeningPidsFromProc(port);
}

async function findListeningPidsFromProc(port: number): Promise<number[]> {
  const listeningInodes = new Set<string>();
  const expectedPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const contents = await readFile(file, 'utf8').catch(() => '');
    for (const line of contents.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1]?.endsWith(`:${expectedPort}`) && fields[3] === '0A' && fields[9]) listeningInodes.add(fields[9]);
    }
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
      throw new Error(`端口 ${port} 无法绑定；它可能被 Windows 主机服务或端口保留占用`);
    }
    throw new Error(`端口 ${port} 无法绑定：${detail.message}`);
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
