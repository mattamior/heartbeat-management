import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortCanBind, findListeningPids, inspectProcess, parseProcTcpListeningInodes, processGroupId, processGroupMembers } from '../server/ports.js';
import { parsePortProxyRules, WindowsPortManager, type WindowsCommandExecutor } from '../server/windows-ports.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listeningPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  return address.port;
}

describe('assertPortCanBind', () => {
  it('rejects a port that cannot be bound even before a child process is launched', async () => {
    await expect(assertPortCanBind(await listeningPort())).rejects.toThrow('无法绑定');
  });

  it('exposes address-in-use as a typed bind failure', async () => {
    const port = await listeningPort();
    await expect(assertPortCanBind(port)).rejects.toMatchObject({
      name: 'PortBindError',
      code: 'PORT_IN_USE',
      systemCode: 'EADDRINUSE',
      port
    });
  });

  it('finds a Linux listener without depending on lsof', async () => {
    const port = await listeningPort();
    const pids = await findListeningPids(port);
    expect(pids.length).toBeGreaterThan(0);
  });

  it('uses the real /proc/net/tcp inode field in the fallback scanner', () => {
    const contents = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:687B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 246813579 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:687C 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000 0 999999999 1 0000000000000000 100 0 0 10 0'
    ].join('\n');
    expect(parseProcTcpListeningInodes(contents, Number.parseInt('687B', 16))).toEqual(new Set(['246813579']));
  });
});

describe.runIf(process.platform === 'darwin')('macOS process inspection', () => {
  it('reads the listener identity fields needed to recognize a managed child', async () => {
    const snapshot = await inspectProcess(process.pid);
    expect(snapshot).toMatchObject({
      pid: process.pid,
      cwd: process.cwd(),
      visibility: 'visible'
    });
    expect(snapshot?.startedAt).toBeTruthy();
    expect(snapshot?.pgid).toBeGreaterThan(1);
    expect(snapshot?.command).toContain('node');
  });

  it('scans the process group reported by ps', async () => {
    const pgid = await processGroupId(process.pid);
    expect(pgid).toBeTruthy();
    expect(await processGroupMembers(pgid!)).toContain(process.pid);
  });
});

describe('WindowsPortManager', () => {
  it('parses only the requested portproxy rule and preserves exact rule identity', () => {
    const rules = parsePortProxyRules([
      'Listen on ipv4:             Connect to ipv4:',
      'Address         Port        Address         Port',
      '--------------- ----------  --------------- ----------',
      '0.0.0.0         26731       127.0.0.1       26731',
      '127.0.0.1       28000       127.0.0.1       28001'
    ].join('\n'), 26731);
    expect(rules).toEqual([{
      family: 'v4tov4', listenAddress: '0.0.0.0', listenPort: 26731,
      connectAddress: '127.0.0.1', connectPort: 26731,
      ruleKey: 'v4tov4:0.0.0.0:26731'
    }]);
  });

  it('exposes a manageable portproxy candidate without treating svchost as the target process', async () => {
    const executor: WindowsCommandExecutor = {
      async run(file, args) {
        if (file === 'netsh.exe' && args[3] === 'v4tov4') return { stdout: '0.0.0.0 26731 127.0.0.1 26731\n' };
        return { stdout: '' };
      }
    };
    const manager = new WindowsPortManager({ enabled: true, executor });
    const candidates = await manager.inspect(26731);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ side: 'windows', source: 'windows-portproxy', pid: 0, manageable: true });
    expect(candidates[0].rule?.ruleKey).toBe('v4tov4:0.0.0.0:26731');
  });

  it('marks svchost/system service listeners as non-manageable', async () => {
    const executor: WindowsCommandExecutor = {
      async run(file) {
        if (file === 'netsh.exe') return { stdout: '' };
        return { stdout: JSON.stringify({ pid: 3976, processName: 'svchost.exe', command: 'svchost.exe -k NetworkService', serviceName: 'iphlpsvc' }) };
      }
    };
    const manager = new WindowsPortManager({ enabled: true, executor });
    const candidates = await manager.inspect(26731);
    expect(candidates[0]).toMatchObject({ source: 'windows-process', pid: 3976, manageable: false, visibility: 'visible' });
    expect(candidates[0].rejectionReason).toContain('系统宿主进程');
  });

  it('uses exact rule mutation commands and a UAC-scoped PID command', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const executor: WindowsCommandExecutor = {
      async run(file, args) {
        calls.push({ file, args });
        if (file === 'netsh.exe') return { stdout: '' };
        return { stdout: '' };
      }
    };
    const manager = new WindowsPortManager({ enabled: true, executor });
    const rule = { family: 'v4tov4', listenAddress: '0.0.0.0', listenPort: 26731, connectAddress: '127.0.0.1', connectPort: 26731, ruleKey: 'v4tov4:0.0.0.0:26731' } as const;
    await manager.removePortProxy(rule);
    await manager.restorePortProxy(rule);
    await manager.terminateProcess({ pid: 4321, source: 'windows-process', side: 'windows', manageable: true, visibility: 'visible', groupComplete: false, startedAt: '2026-08-19T00:00:00.0000000Z', cwd: 'C:\\demo\\service.exe', command: 'service.exe --port 26731', processName: 'service.exe', serviceLookup: 'none' });
    expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const deleteScript = Buffer.from(calls[0].args[3], 'base64').toString('utf16le');
    expect(deleteScript).toContain('portproxy show $family');
    expect(deleteScript).toContain('Windows portproxy 规则已变化或不存在');
    expect(deleteScript).toContain('$after=@(');
    expect(deleteScript).toContain('$stillThere');
    expect(deleteScript).toContain('删除后规则仍存在');
    expect(deleteScript).toContain('0.0.0.0');
    expect(deleteScript).toContain('127.0.0.1');
    expect(calls[1].args).toEqual(['interface', 'portproxy', 'add', 'v4tov4', 'listenaddress=0.0.0.0', 'listenport=26731', 'connectaddress=127.0.0.1', 'connectport=26731']);
    expect(calls[2].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const terminateScript = Buffer.from(calls[2].args[3], 'base64').toString('utf16le');
    expect(terminateScript).toContain('Get-CimInstance Win32_Process');
    expect(terminateScript).toContain('Get-CimInstance Win32_Service');
    expect(terminateScript).toContain('已关联系统服务');
    expect(terminateScript).toContain('CreationDate');
    expect(terminateScript).toContain('actualCommand');
    expect(terminateScript).toContain('actualPath');
    expect(terminateScript).toContain('4321');
  });

  it('rejects a Windows process when service ownership lookup is unavailable', async () => {
    const executor: WindowsCommandExecutor = {
      async run(file) {
        if (file === 'netsh.exe') return { stdout: '' };
        return { stdout: JSON.stringify({ pid: 4321, processName: 'node.exe', startedAt: '2026-08-19T00:00:00.0000000Z', cwd: 'C:\\demo\\node.exe', command: 'node.exe server.js' }) };
      }
    };
    const manager = new WindowsPortManager({ enabled: true, executor });
    const [candidate] = await manager.inspect(26731);
    expect(candidate).toMatchObject({ manageable: false, visibility: 'visible' });
    expect(candidate.rejectionReason).toContain('系统服务承载');
  });

  it('reuses the identity-checking script when a UAC retry is required', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const executor: WindowsCommandExecutor = {
      async run(file, args) {
        calls.push({ file, args });
        if (args.includes('-EncodedCommand') && args[0] === '-NoProfile') throw new Error('access denied');
        return { stdout: '' };
      }
    };
    const manager = new WindowsPortManager({ enabled: true, executor });
    const candidate = { pid: 4321, source: 'windows-process' as const, side: 'windows' as const, manageable: true, visibility: 'visible' as const, groupComplete: false as const, startedAt: '2026-08-19T00:00:00.0000000Z', cwd: 'C:\\demo\\service.exe', command: 'service.exe --port 26731', processName: 'service.exe', serviceLookup: 'none' as const };
    await manager.terminateProcess(candidate);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[1].args[3]).toContain('-EncodedCommand');
    expect(calls[1].args[3]).toContain('-PassThru');
    expect(calls[1].args[3]).toContain('ExitCode');
    expect(calls[1].args[3]).not.toContain("-FilePath ''");
  });

  it('parses supported portproxy families and rejects unknown families for mutation', async () => {
    const rules = parsePortProxyRules(':: 26731 ::1 26731\n', 26731, 'v6tov6');
    expect(rules[0]).toMatchObject({ family: 'v6tov6', listenAddress: '::', connectAddress: '::1', ruleKey: 'v6tov6::::26731' });
    const manager = new WindowsPortManager({ enabled: true, executor: { run: async () => ({ stdout: '' }) } });
    await expect(manager.removePortProxy({ family: 'unknown', listenAddress: '0.0.0.0', listenPort: 26731, connectAddress: '127.0.0.1', connectPort: 26731, ruleKey: 'unknown:0.0.0.0:26731' })).rejects.toThrow('不支持管理');
  });
});
