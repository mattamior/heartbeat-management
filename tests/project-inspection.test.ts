import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../server/config.js';
import { inspectProjectDirectory } from '../server/project-inspection.js';

describe('project inspection', () => {
  it('fills a project configuration from its top-level README', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heartbeat-readme-'));
    const directory = join(parent, 'demo-service');
    await mkdir(directory);
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

  it('prefers package scripts and ignores auxiliary README files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heartbeat-inspection-'));
    const directory = join(parent, 'data-admin-frontend');
    await mkdir(directory);
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      scripts: { start: 'cross-env PORT=8000 HOST=local-data.bbgdata.com umi dev' },
    }));
    await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
    await writeFile(join(directory, 'README.md'), '# Template Name\n\nRun `npm start` on http://localhost:3000.\n');
    await writeFile(join(directory, 'README.AI.md'), '# README.AI.md\n\nRun `npm start` on http://localhost:8000.\n');
    await writeFile(join(directory, 'README.zh-CN.md'), '# 错误名称\n\n');

    await expect(inspectProjectDirectory(directory)).resolves.toMatchObject({
      directory,
      name: 'Data Admin Frontend',
      command: 'npm start',
      packageManager: 'npm',
      port: 8000,
      url: 'http://local-data.bbgdata.com:8000',
      readmePath: join(directory, 'README.md'),
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
