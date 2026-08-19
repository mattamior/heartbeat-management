import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PortProxyRule } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export interface WindowsCommandResult {
  stdout: string;
  stderr?: string;
}

/**
 * The Windows bridge is deliberately injectable.  The Linux/WSL process must
 * never guess that a port belongs to Windows, and tests must not need to
 * mutate a real portproxy table or display a UAC prompt.
 */
export interface WindowsCommandExecutor {
  run(file: string, args: string[]): Promise<WindowsCommandResult>;
}

export interface WindowsProcessRecord {
  pid: number;
  processName?: string;
  startedAt?: string;
  cwd?: string;
  command?: string;
  commandSummary?: string;
  serviceName?: string;
  /** Whether Win32_Service lookup completed.  Unknown is never manageable. */
  serviceLookup?: 'known' | 'none' | 'unavailable';
  kind?: 'user' | 'service' | 'system-host' | 'unknown';
}

export interface WindowsListenerCandidate extends WindowsProcessRecord {
  side: 'windows';
  source: 'windows-process' | 'windows-portproxy';
  manageable: boolean;
  elevationRequired?: boolean;
  rejectionReason?: string;
  rule?: PortProxyRule;
  visibility: 'visible' | 'unavailable';
  groupComplete: false;
}

export interface WindowsPortManagerOptions {
  executor?: WindowsCommandExecutor;
  /** Set true in tests to exercise the bridge on Linux. */
  enabled?: boolean;
  powershell?: string;
  netsh?: string;
}

const defaultExecutor: WindowsCommandExecutor = {
  async run(file, args) {
    const result = await execFileAsync(file, args, { windowsHide: true });
    return { stdout: result.stdout, stderr: result.stderr };
  }
};

/**
 * Read and mutate only the exact Windows resources needed for one port.  A
 * portproxy rule is represented as a candidate with pid 0 by the caller; it
 * is a rule, never a process and must not be terminated via svchost.
 */
export class WindowsPortManager {
  private readonly executor: WindowsCommandExecutor;
  private readonly enabled: boolean;
  private readonly powershell: string;
  private readonly netsh: string;

  constructor(options: WindowsPortManagerOptions = {}) {
    this.executor = options.executor ?? defaultExecutor;
    // WSL runs Node on Linux while the target resources live in Windows.  The
    // commands are probed lazily and failures are treated as "not visible";
    // disabling this on non-Windows would make WSL portproxy management
    // impossible.
    this.enabled = options.enabled ?? true;
    this.powershell = options.powershell ?? 'powershell.exe';
    this.netsh = options.netsh ?? 'netsh.exe';
  }

  async inspect(port: number): Promise<WindowsListenerCandidate[]> {
    if (!this.enabled) return [];
    const [rules, processes] = await Promise.all([
      this.listPortProxyRules(port),
      this.listWindowsProcesses(port)
    ]);
    const ruleCandidates = rules.map((rule) => ({
      pid: 0,
      side: 'windows' as const,
      source: 'windows-portproxy' as const,
      manageable: true,
      visibility: 'visible' as const,
      groupComplete: false as const,
      rule,
      command: `netsh interface portproxy ${rule.listenAddress}:${rule.listenPort} -> ${rule.connectAddress}:${rule.connectPort}`,
      commandSummary: `portproxy ${rule.listenAddress}:${rule.listenPort} -> ${rule.connectAddress}:${rule.connectPort}`
    }));
    const processCandidates = [...new Map(processes.map((record) => [record.pid, record])).values()].map((record) => this.toCandidate(record));
    return [...ruleCandidates, ...processCandidates];
  }

  async listPortProxyRules(port: number): Promise<PortProxyRule[]> {
    const families = ['v4tov4', 'v6tov4', 'v4tov6', 'v6tov6'] as const;
    const results = await Promise.all(families.map(async (family) => {
      const output = await this.executor.run(this.netsh, ['interface', 'portproxy', 'show', family]).catch(() => undefined);
      return output ? parsePortProxyRules(output.stdout, port, family) : [];
    }));
    return results.flat();
  }

  async removePortProxy(rule: PortProxyRule): Promise<void> {
    if (!isSupportedPortProxyFamily(rule.family)) throw new Error(`不支持管理 Windows portproxy family: ${rule.family}`);
    // The read-back and delete intentionally live in one script.  This keeps
    // the identity check adjacent to the destructive command, including when
    // the script is retried through an elevated PowerShell process.
    const script = this.portProxyDeleteScript(rule);
    await this.runPowerShellScript(script);
  }

  async restorePortProxy(rule: PortProxyRule): Promise<void> {
    if (!isSupportedPortProxyFamily(rule.family)) throw new Error(`不支持恢复 Windows portproxy family: ${rule.family}`);
    await this.runNetsh([
      'interface', 'portproxy', 'add', rule.family,
      `listenaddress=${rule.listenAddress}`, `listenport=${String(rule.listenPort)}`,
      `connectaddress=${rule.connectAddress}`, `connectport=${String(rule.connectPort)}`
    ]);
  }

  /** Request UAC elevation and terminate only this confirmed user PID. */
  async terminateProcess(candidate: WindowsListenerCandidate): Promise<void> {
    if (candidate.source !== 'windows-process' || !candidate.pid || !candidate.manageable || (candidate.serviceLookup !== 'known' && candidate.serviceLookup !== 'none')) {
      throw new Error(candidate.rejectionReason ?? '该 Windows 占用不可安全接管');
    }
    if (!candidate.startedAt || !candidate.command || !candidate.cwd) {
      throw new Error('Windows 进程身份信息不完整，拒绝终止');
    }
    const script = this.windowsProcessTerminateScript(candidate);
    await this.runPowerShellScript(script);
  }

  private windowsProcessTerminateScript(candidate: WindowsListenerCandidate): string {
    const expectedPid = String(candidate.pid);
    const expectedStartedAt = psQuote(candidate.startedAt ?? '');
    const expectedCommand = psQuote(candidate.command ?? '');
    const expectedPath = psQuote(candidate.cwd ?? '');
    const expectedName = psQuote(candidate.processName ?? '');
    return [
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${expectedPid}' -ErrorAction Stop`,
      `if(-not $p){throw 'Windows 进程不存在'}`,
      `$actualStarted=if($p.CreationDate){$p.CreationDate.ToString('o')}else{''}`,
      `if($actualStarted -cne ${expectedStartedAt}){throw 'Windows 进程启动时间已变化'}`,
      `$actualCommand=[string]$p.CommandLine`,
      `if($actualCommand -cne ${expectedCommand}){throw 'Windows 进程命令已变化'}`,
      `$actualPath=[string]$p.ExecutablePath`,
      `if($actualPath -cne ${expectedPath}){throw 'Windows 进程路径已变化'}`,
      `$actualName=[string]$p.Name`,
      `if(${expectedName} -and ($actualName -cne ${expectedName})){throw 'Windows 进程名称已变化'}`,
      `try{$services=@(Get-CimInstance Win32_Service -Filter 'ProcessId = ${expectedPid}' -ErrorAction Stop)}catch{throw '无法确认 Windows 服务关联状态'}`,
      `if($services.Count -gt 0){throw 'Windows 进程已关联系统服务，不可自动终止'}`,
      "$n=$actualName.ToLowerInvariant()",
      "if ($n -in @('svchost.exe','svchost','services.exe','services','system','wininit.exe','lsass.exe','csrss.exe','smss.exe','winlogon.exe')) { throw '系统宿主进程不可自动终止' }",
      `Stop-Process -Id ${expectedPid} -Force -ErrorAction Stop`
    ].join('; ');
  }

  private portProxyDeleteScript(rule: PortProxyRule): string {
    const family = psQuote(rule.family);
    const listenAddress = psQuote(rule.listenAddress);
    const listenPort = String(rule.listenPort);
    const connectAddress = psQuote(rule.connectAddress);
    const connectPort = String(rule.connectPort);
    return [
      `$family=${family}`,
      `$lines=@(& ${psQuote(this.netsh)} interface portproxy show $family)`,
      "if($LASTEXITCODE -ne 0){throw 'Windows portproxy 删除前读回失败'}",
      `$found=$false`,
      'foreach($line in $lines){$parts=($line.ToString().Trim() -split "\\s+"); if($parts.Count -ge 4 -and $parts[1] -match "^\\d+$" -and $parts[3] -match "^\\d+$" -and $parts[0] -ceq ' + listenAddress + ' -and [int]$parts[1] -eq ' + listenPort + ' -and $parts[2] -ceq ' + connectAddress + ' -and [int]$parts[3] -eq ' + connectPort + '){$found=$true; break}}',
      "if(-not $found){throw 'Windows portproxy 规则已变化或不存在' }",
      `& ${psQuote(this.netsh)} interface portproxy delete $family listenaddress=${listenAddress} listenport=${listenPort}`,
      "if($LASTEXITCODE -ne 0){throw 'Windows portproxy 删除失败'}",
      `$after=@(& ${psQuote(this.netsh)} interface portproxy show $family)`,
      "if($LASTEXITCODE -ne 0){throw 'Windows portproxy 删除后读回失败'}",
      '$stillThere=$false',
      'foreach($line in $after){$parts=($line.ToString().Trim() -split "\\s+"); if($parts.Count -ge 4 -and $parts[1] -match "^\\d+$" -and $parts[3] -match "^\\d+$" -and $parts[0] -ceq ' + listenAddress + ' -and [int]$parts[1] -eq ' + listenPort + ' -and $parts[2] -ceq ' + connectAddress + ' -and [int]$parts[3] -eq ' + connectPort + '){$stillThere=$true; break}}',
      "if($stillThere){throw 'Windows portproxy 删除后规则仍存在'}"
    ].join('; ');
  }

  /** Run a script directly, then repeat the exact encoded script through UAC. */
  private async runPowerShellScript(script: string): Promise<void> {
    // Force terminating failure semantics even for PowerShell cmdlets whose
    // default errors are non-terminating; neither direct nor elevated paths
    // may report a failed mutation as successful.
    const guardedScript = `try { ${script} } catch { Write-Error $_; exit 1 }`;
    const encoded = Buffer.from(guardedScript, 'utf16le').toString('base64');
    try {
      await this.executor.run(this.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    } catch (error) {
      const elevate = this.uacWrapper(this.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
      try {
        await this.executor.run(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', elevate]);
      } catch (elevatedError) {
        // Preserve the elevated command's cancellation/ExitCode failure so
        // callers never mistake a declined UAC prompt for a successful action.
        throw elevatedError instanceof Error ? elevatedError : error;
      }
    }
  }

  private async runNetsh(args: string[]): Promise<void> {
    try {
      await this.executor.run(this.netsh, args);
    } catch (error) {
      // `netsh` returns access denied when the WSL process is not elevated.
      // Retry the exact same argument vector through a UAC request; no broad
      // shell command or wildcard is used.
      const elevate = this.uacWrapper(this.netsh, args);
      try {
        await this.executor.run(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', elevate]);
      } catch (elevatedError) {
        throw elevatedError instanceof Error ? elevatedError : error;
      }
    }
  }

  private uacWrapper(file: string, args: string[]): string {
    const argumentList = args.map((arg) => psQuote(arg)).join(',');
    return [
      'try {',
      `$child=Start-Process -FilePath ${psQuote(file)} -Verb RunAs -Wait -PassThru -ArgumentList ${argumentList} -ErrorAction Stop`,
      "if($null -eq $child){throw 'Windows 管理员权限请求未返回进程' }",
      "if($child.ExitCode -ne 0){throw ('Windows 提升命令失败，ExitCode=' + $child.ExitCode)}",
      '} catch { Write-Error $_; exit 1 }'
    ].join(' ');
  }

  private async listWindowsProcesses(port: number): Promise<WindowsProcessRecord[]> {
    const script = [
      `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
      '$out=@($c | ForEach-Object {',
      '$p=Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $_.OwningProcess) -ErrorAction SilentlyContinue',
      '$svcLookup="unavailable"; $svc=$null; try { $svc=Get-CimInstance Win32_Service -Filter ("ProcessId = {0}" -f $_.OwningProcess) -ErrorAction Stop | Select-Object -First 1; $svcLookup=if($svc){"known"}else{"none"} } catch {}',
      '[pscustomobject]@{pid=[int]$_.OwningProcess; processName=$p.Name; startedAt=$(if($p.CreationDate){$p.CreationDate.ToString("o")}); cwd=$p.ExecutablePath; command=$p.CommandLine; serviceName=$svc.Name; serviceLookup=$svcLookup}',
      '}); $out | ConvertTo-Json -Compress'
    ].join(' ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const output = await this.executor.run(this.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]).catch(() => undefined);
    if (!output?.stdout.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(output.stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row) => normalizeWindowsProcess(row));
    } catch {
      return [];
    }
  }

  private toCandidate(record: WindowsProcessRecord): WindowsListenerCandidate {
    const processName = record.processName?.toLowerCase() ?? '';
    const systemHost = ['svchost.exe', 'svchost', 'services.exe', 'services', 'system', 'wininit.exe', 'lsass.exe', 'csrss.exe', 'smss.exe', 'winlogon.exe'].includes(processName);
    const service = Boolean(record.serviceName) || record.kind === 'service';
    const identityComplete = Boolean(record.startedAt && record.command !== undefined && record.cwd !== undefined);
    const serviceLookupFailed = record.serviceLookup !== 'known' && record.serviceLookup !== 'none';
    const manageable = Number.isSafeInteger(record.pid) && record.pid > 0 && !systemHost && !service && !serviceLookupFailed && identityComplete;
    const rejectionReason = manageable ? undefined
      : systemHost ? `Windows 系统宿主进程 ${record.processName ?? record.pid} 不可自动终止；请管理对应端口转发规则或手动处理。`
        : service ? 'Windows 服务进程不可自动终止；请管理对应服务或端口转发规则。'
          : serviceLookupFailed ? '无法确认 Windows 进程是否由系统服务承载，拒绝自动终止；请刷新后重试或手动处理。'
            : 'Windows 进程身份信息不完整（启动时间、命令或路径），拒绝自动终止。';
    return {
      ...record,
      side: 'windows',
      source: 'windows-process',
      manageable,
      elevationRequired: manageable,
      rejectionReason,
      // `cwd` carries Win32_Process.ExecutablePath for the Windows side.  The
      // elevated termination script compares this path, command line, and
      // creation time again immediately before sending Stop-Process.
      visibility: record.command || record.processName ? 'visible' : 'unavailable',
      groupComplete: false
    };
  }
}

function normalizeWindowsProcess(value: unknown): WindowsProcessRecord[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  const pid = Number(row.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  return [{
    pid,
    processName: typeof row.processName === 'string' ? row.processName : undefined,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : undefined,
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
    command: typeof row.command === 'string' ? row.command : undefined,
    commandSummary: typeof row.command === 'string' ? row.command.slice(0, 240) : undefined,
    serviceName: typeof row.serviceName === 'string' && row.serviceName.length > 0 ? row.serviceName : undefined,
    serviceLookup: row.serviceLookup === 'known' || row.serviceLookup === 'none' || row.serviceLookup === 'unavailable'
      ? row.serviceLookup
      : 'unavailable',
    kind: typeof row.serviceName === 'string' && row.serviceName.length > 0 ? 'service' : undefined
  }];
}

export type SupportedPortProxyFamily = 'v4tov4' | 'v6tov4' | 'v4tov6' | 'v6tov6';

export function isSupportedPortProxyFamily(family: string): family is SupportedPortProxyFamily {
  return family === 'v4tov4' || family === 'v6tov4' || family === 'v4tov6' || family === 'v6tov6';
}

export function parsePortProxyRules(output: string, port?: number, family: SupportedPortProxyFamily = 'v4tov4'): PortProxyRule[] {
  const rules: PortProxyRule[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+$/.test(fields[1] ?? '') || !/^\d+$/.test(fields[3] ?? '')) continue;
    const listenPort = Number(fields[1]);
    const connectPort = Number(fields[3]);
    if (!Number.isSafeInteger(listenPort) || !Number.isSafeInteger(connectPort) || (port !== undefined && listenPort !== port)) continue;
    rules.push({
      family,
      listenAddress: fields[0],
      listenPort,
      connectAddress: fields[2],
      connectPort,
      ruleKey: `${family}:${fields[0]}:${listenPort}`
    });
  }
  return rules;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
