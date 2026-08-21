import { spawn } from 'node:child_process';
import type { PackageManager } from '../shared/types.js';

export interface RuntimeProbeResult {
  nodePath?: string;
  packageManagerPath?: string;
  diagnostic: string;
}

export async function probeRuntime(packageManager: PackageManager | undefined): Promise<RuntimeProbeResult> {
  const executable = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
  const script = `${runtimeBootstrap(executable)}; for heartbeat_command in node ${executable}; do heartbeat_path="$(command -v \"$heartbeat_command\" 2>/dev/null || true)"; [ -n "$heartbeat_path" ] && printf '%s=%s\\n' "$heartbeat_command" "$heartbeat_path"; done`;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => resolve({ diagnostic: `无法启动运行时检测 shell: ${error.message}` }));
    child.once('close', (code) => {
      const paths = new Map(stdout.split('\n').flatMap((line) => {
        const separator = line.indexOf('=');
        return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
      }));
      const diagnostic = [
        '运行时检查：bash -lc（必要时加载 nvm）',
        `node: ${paths.get('node') ?? '未找到'}`,
        `${executable}: ${paths.get(executable) ?? '未找到'}`,
        code === 0 ? undefined : `shell 退出码：${code ?? 'signal'}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n');
      resolve({ nodePath: paths.get('node'), packageManagerPath: paths.get(executable), diagnostic });
    });
  });
}

function runtimeBootstrap(executable: 'npm' | 'pnpm' | 'yarn'): string {
  return `if ! command -v node >/dev/null 2>&1 || ! command -v ${executable} >/dev/null 2>&1; then if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; elif [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; fi`;
}
