import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProject, processSnapshotKey, runProjectAction } from './api';

afterEach(() => vi.restoreAllMocks());

describe('client takeover contract', () => {
  it('normalizes every listener identity and maps takeover progress to a busy state', () => {
    const project = normalizeProject({
      id: 'demo',
      name: 'Demo',
      kind: 'web',
      cwd: '/tmp/demo',
      port: 4317,
      state: 'taking-over',
      listeners: [{
        pid: 120,
        startedAt: '12345',
        cwd: '/tmp/demo',
        commandSummary: 'node server.js',
        pgid: 120,
        groupPids: [120, 121],
        groupComplete: true,
        visibility: 'visible',
      }],
      takeover: { phase: 'waiting', port: 4317, listeners: [], terminated: [{ pid: 120, pgid: 120, signal: 'SIGTERM' }] },
    });

    expect(project.status.kind).toBe('takeover-in-progress');
    expect(project.status.operation).toBe('takeover');
    expect(project.status.listeners[0]).toMatchObject({ pid: 120, pgid: 120, groupPids: [120, 121], visibility: 'visible' });
    expect(project.status.portPids).toEqual([120]);
    expect(project.status.takeover?.terminatedPids).toEqual([120]);
  });

  it('submits the reviewed port and complete listener snapshot', async () => {
    const project = normalizeProject({
      id: 'demo',
      name: 'Demo',
      kind: 'web',
      cwd: '/tmp/demo',
      command: 'npm run dev',
      packageManager: 'npm',
      port: 4317,
      state: 'external',
      listeners: [{
        pid: 120,
        startedAt: '12345',
        cwd: '/tmp/demo',
        command: 'node server.js',
        pgid: 120,
        groupPids: [120],
        groupComplete: true,
        visibility: 'visible',
      }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: { state: 'taking-over', portPids: [], listeners: [], takeover: { phase: 'starting', listeners: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await runProjectAction(project, 'takeover');

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      confirm: true,
      snapshot: { port: 4317, listeners: project.status.listeners },
    });
  });

  it('requires the server force flag and exact port acknowledgement for dangerous takeover', async () => {
    const project = normalizeProject({
      id: 'force-demo', name: 'Force Demo', kind: 'web', cwd: '/tmp/force-demo', port: 4317, state: 'external',
      listeners: [{ pid: 120, startedAt: '12345', cwd: '/elsewhere', command: 'node server.js', visibility: 'visible', groupComplete: false }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: { state: 'taking-over', listeners: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await runProjectAction(project, 'force-takeover');

    expect(fetchMock.mock.calls[0]?.[0]).toContain('/takeover');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      confirm: true, force: true, confirmPort: 4317, acknowledgement: '4317', snapshot: { port: 4317 },
    });
  });

  it('keeps Windows process and portproxy candidates even without a WSL PID', () => {
    const project = normalizeProject({
      id: 'windows-demo',
      name: 'Windows Demo',
      kind: 'web',
      cwd: '/tmp/windows-demo',
      port: 26731,
      state: 'conflict',
      windowsCandidates: [
        { side: 'windows', kind: 'process', pid: 3976, processName: 'node.exe', command: 'node server.js', manageable: true, requiresElevation: true },
        {
          side: 'windows',
          kind: 'portproxy',
          mapping: { listenAddress: '0.0.0.0', listenPort: 26731, connectAddress: '127.0.0.1', connectPort: 26731 },
          manageable: true,
        },
      ],
    });

    expect(project.status.listeners).toHaveLength(2);
    expect(project.status.listeners[0]).toMatchObject({ side: 'windows', kind: 'process', pid: 3976, requiresElevation: true });
    expect(project.status.listeners[1]).toMatchObject({ side: 'windows', kind: 'portproxy', mapping: { listenPort: 26731 } });
    expect(project.status.portPids).toEqual([3976]);
  });

  it('preserves the complete portproxy rule and stable rule key through state and takeover request', async () => {
    const rule = {
      family: 'v4tov4',
      listenAddress: '0.0.0.0',
      listenPort: 26731,
      connectAddress: '127.0.0.1',
      connectPort: 26731,
      ruleKey: 'v4tov4:0.0.0.0:26731',
    };
    const project = normalizeProject({
      id: 'portproxy-demo',
      name: 'Portproxy Demo',
      kind: 'web',
      cwd: '/tmp/demo',
      port: 26731,
      state: 'external',
      listeners: [{ pid: 0, side: 'windows', source: 'windows-portproxy', kind: 'portproxy', mapping: rule, rule }],
    });

    expect(project.status.listeners[0]?.rule).toEqual(rule);
    expect(project.status.listeners[0]?.ruleKey).toBe(rule.ruleKey);
    expect(processSnapshotKey(project.status.listeners[0]!)).toBe(`portproxy:rule:${rule.ruleKey}`);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: { state: 'taking-over', listeners: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await runProjectAction(project, 'takeover');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.snapshot.listeners[0].rule).toEqual(rule);
    expect(body.snapshot.listeners[0].mapping).toEqual(rule);
  });

  it('accepts elevation/rejection aliases and exposes structured restore failures', async () => {
    const project = normalizeProject({
      id: 'windows-demo',
      name: 'Windows Demo',
      kind: 'web',
      cwd: '/tmp/demo',
      port: 26731,
      state: 'external',
      windowsCandidates: [{
        side: 'windows', kind: 'process', pid: 3976, processName: 'node.exe',
        elevationRequired: true, rejectionReason: '需要管理员权限',
      }],
    });
    expect(project.status.listeners[0]).toMatchObject({
      requiresElevation: true,
      elevationRequired: true,
      managementReason: '需要管理员权限',
      rejectionReason: '需要管理员权限',
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      message: '接管后启动失败',
      restore: { status: 'failed', error: 'UAC denied', ruleKeys: ['rule-1'] },
      restoreResults: [
        { ruleKey: 'v6tov6:::26731', restored: true },
        { ruleKey: 'v6tov6:::26732', restored: false, error: 'access denied' },
      ],
    }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    await expect(runProjectAction(project, 'start')).rejects.toMatchObject({
      details: {
        restoreFailed: true,
        restore: { status: 'failed', error: 'UAC denied', ruleKeys: ['rule-1'] },
        restoreResults: [
          { ruleKey: 'v6tov6:::26731', restored: true },
          { ruleKey: 'v6tov6:::26732', restored: false, error: 'access denied' },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});
