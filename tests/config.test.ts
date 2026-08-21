import { mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSiblingProjectPath, ProjectStore, projectSchema } from '../server/config.js';

describe('project configuration boundary', () => {
  it('accepts an existing manually selected project directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-project-'));
    expect(assertSiblingProjectPath(directory)).toBe(realpathSync(directory));
  });

  it('validates web projects and rejects unsafe environment keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-project-'));
    expect(() => projectSchema.parse({ id: 'ok', name: 'OK', kind: 'web', cwd: directory, command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3000', env: { 'BAD-KEY': 'x' } })).toThrow();
    expect(() => projectSchema.parse({ id: 'ok', name: 'OK', kind: 'web', cwd: directory, command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3001' })).toThrow('状态检测端口');
  });

  it('writes the configuration atomically and preserves project identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-store-'));
    const file = join(directory, 'projects.json');
    const store = new ProjectStore(file);
    expect(await store.read()).toEqual([]);
    const projectDirectory = await mkdtemp(join(tmpdir(), 'heartbeat-project-'));
    await store.create({ id: 'manual-project', name: 'Manual Project', kind: 'web', cwd: projectDirectory, command: 'npm run dev', packageManager: 'npm', port: 3000, url: 'http://127.0.0.1:3000' });
    const changed = await store.update('manual-project', { name: 'Renamed Project' });
    expect(changed.name).toBe('Renamed Project');
    expect(JSON.parse(await readFile(file, 'utf8')).find((project: { id: string }) => project.id === 'manual-project').name).toBe('Renamed Project');
  });
});
