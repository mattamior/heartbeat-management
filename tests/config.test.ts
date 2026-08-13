import { mkdtemp, readFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSiblingProjectPath, ProjectStore, projectSchema } from '../server/config.js';

describe('project configuration boundary', () => {
  it('probes BBG Admin on the port declared by its development script', async () => {
    const defaults = JSON.parse(await readFile(new URL('../data/projects.defaults.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;
    const admin = defaults.find((project) => project.id === 'bbg-admin');
    expect(admin).toMatchObject({
      command: 'npm exec --yes pnpm@10.22.0 -- dev',
      port: 26731,
      url: 'http://127.0.0.1:26731'
    });
  });

  it('only accepts direct children of the projects root', () => {
    expect(assertSiblingProjectPath('/home/bbg/bbg-projects/bbg-admin')).toBe('/home/bbg/bbg-projects/bbg-admin');
    expect(() => assertSiblingProjectPath('/home/bbg/bbg-projects/bbg-admin/nested')).toThrow('不存在');
    expect(() => assertSiblingProjectPath('/tmp/other')).toThrow('不存在');
  });

  it('rejects a direct-child symlink that escapes the projects root', async () => {
    const link = `/home/bbg/bbg-projects/.heartbeat-symlink-${process.pid}-${Date.now()}`;
    await symlink('/tmp', link);
    try {
      expect(() => assertSiblingProjectPath(link)).toThrow('直接子目录');
    } finally {
      await unlink(link);
    }
  });

  it('validates web projects and rejects unsafe environment keys', () => {
    expect(() => projectSchema.parse({ id: 'ok', name: 'OK', kind: 'web', cwd: '/home/bbg/bbg-projects/ok', command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3000', env: { 'BAD-KEY': 'x' } })).toThrow();
    expect(() => projectSchema.parse({ id: 'ok', name: 'OK', kind: 'web', cwd: '/home/bbg/bbg-projects/ok', command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3001' })).toThrow('状态检测端口');
  });

  it('writes the configuration atomically and preserves project identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-store-'));
    const file = join(directory, 'projects.json');
    const store = new ProjectStore(file);
    const projects = await store.read();
    const changed = await store.update('bbg-admin', { name: 'Renamed Admin' });
    expect(changed.name).toBe('Renamed Admin');
    expect(JSON.parse(await readFile(file, 'utf8')).find((project: { id: string }) => project.id === 'bbg-admin').name).toBe('Renamed Admin');
    expect(projects).toHaveLength(10);
  });
});
