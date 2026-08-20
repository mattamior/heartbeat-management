import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../server/config.js';
import { inspectProjectDirectory } from '../server/project-inspection.js';

describe('project inspection', () => {
  it('fills a project configuration from its top-level README', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-readme-'));
    await writeFile(join(directory, 'README.md'), `# Demo Service

Run \`pnpm dev -- --port 4317\` and open http://localhost:4317.
`);
    await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    await expect(inspectProjectDirectory(directory)).resolves.toMatchObject({
      directory,
      name: 'Demo Service',
      command: 'pnpm dev -- --port 4317',
      packageManager: 'pnpm',
      port: 4317,
      url: 'http://localhost:4317',
      missing: [],
    });
  });

  it('allows a selected project directory outside the historical fixed root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heartbeat-anywhere-'));
    const configFile = join(await mkdtemp(join(tmpdir(), 'heartbeat-config-')), 'projects.json');
    const store = new ProjectStore(configFile);

    await expect(store.create({
      id: 'outside-root',
      name: 'Outside Root',
      kind: 'web',
      cwd: directory,
      command: 'npm run dev',
      packageManager: 'npm',
      port: 4317,
      url: 'http://127.0.0.1:4317',
    })).resolves.toMatchObject({ cwd: await realpath(directory) });
  });
});
