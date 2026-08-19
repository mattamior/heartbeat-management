import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  Project,
  ProjectConfig,
  ProjectStatusKind,
  ProcessSnapshot,
  getLogs,
  getProjects,
  parseStreamEvent,
  processSnapshotKey,
  runProjectAction,
  updateProject,
} from './api';

const STATUS_META: Record<string, { label: string; tone: string }> = {
  'managed-running': { label: '面板管理中', tone: 'success' },
  'external-running': { label: '外部进程运行中', tone: 'warning' },
  stopped: { label: '已停止', tone: 'muted' },
  failed: { label: '启动失败', tone: 'danger' },
  'port-conflict': { label: '端口冲突', tone: 'danger' },
  'takeover-in-progress': { label: '接管进行中', tone: 'warning' },
  unsupported: { label: '暂不支持', tone: 'muted' },
};

type Filter = 'all' | 'managed-running' | 'external-running' | 'stopped' | 'failed' | 'port-conflict' | 'unsupported';
type ProjectAction = 'start' | 'stop' | 'restart' | 'takeover' | 'force-takeover';
type NoticeDetails = {
  diagnostics?: string;
  refreshRequired?: boolean;
  permissionRequired?: boolean;
  permissionDenied?: boolean;
  requiresElevation?: boolean;
  elevationRequired?: boolean;
  managementReason?: string;
  rejectionReason?: string;
  restored?: boolean;
  restoreFailed?: boolean;
  restore?: import('./api').RestoreResult;
  restoreResults?: import('./api').RestoreResultItem[];
  releaseTimedOut?: boolean;
};
type Notice = { tone: 'error' | 'info'; text: string } & NoticeDetails | null;

function getStatusMeta(kind: ProjectStatusKind) {
  return STATUS_META[kind] ?? { label: kind || '状态未知', tone: 'muted' };
}

function configToEnvText(env?: Record<string, string>) {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`环境变量格式错误：${line}`);
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function mergeProject(projects: Project[], next: Project): Project[] {
  const index = projects.findIndex((item) => item.config.id === next.config.id);
  if (index < 0) return [...projects, next];
  return projects.map((item) => (item.config.id === next.config.id ? next : item));
}

function hasInvisiblePortHint(message?: string): boolean {
  return Boolean(message && /不可见|Windows|主机服务|端口保留|无法安全自动接管/i.test(message));
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await getProjects());
      setNotice(null);
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const stream = new EventSource('/api/events');
    const receive = (event: MessageEvent) => {
      const parsed = parseStreamEvent(event.type, event.data);
      if (!parsed) return;
      if (parsed.projects) setProjects(parsed.projects);
      else if (parsed.project) setProjects((current) => mergeProject(current, parsed.project!));
    };
    const connect = () => setConnection('connected');
    const disconnect = () => setConnection('disconnected');
    stream.addEventListener('open', connect);
    stream.addEventListener('error', disconnect);
    for (const type of ['project', 'status', 'log', 'message']) stream.addEventListener(type, receive);
    return () => stream.close();
  }, []);

  const filteredProjects = useMemo(
    () => projects.filter((project) => filter === 'all' || project.status.kind === filter),
    [filter, projects],
  );

  const applyProject = useCallback((project: Project) => setProjects((current) => mergeProject(current, project)), []);
  const invokeAction = useCallback(async (project: Project, action: ProjectAction) => {
    try {
      const updated = await runProjectAction(project, action);
      applyProject(updated);
      const failure = updated.status.failure;
      if ((action === 'takeover' || action === 'force-takeover') && (updated.status.kind === 'failed' || failure)) {
        setNotice({
          tone: 'error',
          text: `${project.config.name}：${describeStatusFailure(updated)}${failure ? describeRecovery(failure) : ''}`,
          diagnostics: updated.status.diagnostics ?? failure?.diagnostics,
        });
      } else {
        setNotice({ tone: 'info', text: `${project.config.name}：操作已提交` });
      }
    } catch (error) {
      setNotice({ tone: 'error', text: `${project.config.name}：${describeError(error)}`, ...errorDetails(error) });
    }
  }, [applyProject]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-heading">
            <img className="brand-mark" src="/brand/heartbeat-mark-reversed.svg" alt="Heartbeat 标志" width="72" height="72" />
            <div>
              <p className="eyebrow">127.0.0.1 · LOCAL ONLY</p>
              <h1>Heartbeat</h1>
              <p className="subtitle">本地开发服务控制台 · Local Dev Service Control</p>
            </div>
          </div>
        </div>
        <div className="header-actions">
          <span className={`connection ${connection}`}><i />{connection === 'connected' ? '实时同步中' : connection === 'connecting' ? '正在连接' : '实时连接断开'}</span>
          <button className="button secondary" onClick={() => void refresh()} disabled={loading}>刷新状态</button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.tone}`} role="alert">
        <div className="notice-content">
          <div>{notice.text}</div>
          {notice.diagnostics && <pre className="diagnostic-panel" aria-label="可复制诊断">{notice.diagnostics}</pre>}
        </div>
        <div className="notice-actions">
          {notice.diagnostics && <button className="text-button" onClick={() => void copyText(notice.diagnostics!)}>复制诊断</button>}
          {notice.refreshRequired && <button className="text-button" onClick={() => void refresh()}>重新读取状态</button>}
          <button onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
        </div>
      </div>}

      <section className="filter-bar" aria-label="项目状态筛选">
        {(['all', 'managed-running', 'external-running', 'stopped', 'failed', 'port-conflict', 'unsupported'] as Filter[]).map((item) => (
          <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
            {item === 'all' ? `全部 ${projects.length}` : `${getStatusMeta(item).label} ${projects.filter((p) => p.status.kind === item).length}`}
          </button>
        ))}
      </section>

      {loading ? <div className="empty">正在读取项目服务状态…</div> : filteredProjects.length === 0 ? <div className="empty">没有匹配的项目。</div> : (
        <section className="project-grid">
          {filteredProjects.map((project) => <ProjectCard key={project.config.id} project={project} onAction={invokeAction} onSaved={applyProject} onError={(text) => setNotice({ tone: 'error', text })} />)}
        </section>
      )}
    </main>
  );
}

function ProjectCard({ project, onAction, onSaved, onError }: { project: Project; onAction: (project: Project, action: ProjectAction) => Promise<void>; onSaved: (project: Project) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [takeoverSnapshot, setTakeoverSnapshot] = useState<ProcessSnapshot[] | null>(null);
  const meta = getStatusMeta(project.status.kind);
  const supported = project.config.supported !== false && project.config.kind !== 'unsupported' && project.status.kind !== 'unsupported';
  const running = project.status.kind === 'managed-running';
  const external = project.status.kind === 'external-running' || project.status.kind === 'port-conflict';
  const inProgress = Boolean(project.status.operation) || project.status.kind === 'takeover-in-progress';
  const hasTakeoverCandidates = project.status.listeners.length > 0;
  const managedConflict = project.status.kind === 'port-conflict'
    && Boolean(project.status.managedPid ?? project.status.startedAt);
  const canTakeover = supported && !inProgress && !managedConflict
    && (external || project.status.invisiblePort || project.status.listeners.some(isWindowsCandidate))
    && hasTakeoverCandidates;
  const canForceTakeover = supported && !inProgress && !managedConflict && external && hasTakeoverCandidates && Number.isInteger(project.config.port);

  const action = async (kind: ProjectAction, confirmedSnapshot?: ProcessSnapshot[]) => {
    setBusy(true);
    try {
      const actionProject = confirmedSnapshot
        ? { ...project, status: { ...project.status, listeners: confirmedSnapshot } }
        : project;
      await onAction(actionProject, kind);
    } finally { setBusy(false); }
  };
  const toggleLogs = async () => {
    const nextOpen = !logsOpen;
    setLogsOpen(nextOpen);
    if (!nextOpen) return;
    try { setLogs(await getLogs(project.config.id)); } catch (error) { onError(`${project.config.name}：${describeError(error)}`); }
  };

  return <article className={`project-card status-${meta.tone}`}>
    <div className="card-heading">
      <div><h2>{project.config.name}</h2><p className="directory" title={project.config.directory}>{project.config.directory}</p></div>
      <span className={`status-chip ${meta.tone}`}>{meta.label}</span>
    </div>
    <dl className="project-details">
      <div><dt>端口</dt><dd>{project.config.port ?? '—'}{project.status.portPids.length > 0 ? ` · ${project.status.portPids.length} 个监听进程` : project.status.pid ? ` · PID ${project.status.pid}` : ''}</dd></div>
      <div><dt>包管理器</dt><dd>{project.config.packageManager || '—'}</dd></div>
      {project.status.message && <div className="detail-wide"><dt>提示</dt><dd>{project.status.message}</dd></div>}
      {inProgress && <div className="detail-wide operation-detail"><dt>当前操作</dt><dd>{operationLabel(project.status.operation)}</dd></div>}
      {hasTakeoverCandidates && <div className="detail-wide"><dt>端口监听候选</dt><dd><ListenerList listeners={project.status.listeners} /></dd></div>}
      {project.status.invisiblePort && project.status.listeners.length === 0 && !hasInvisiblePortHint(project.status.message) && <div className="detail-wide invisible-warning"><dt>占用来源不可见</dt><dd>当前运行环境无法读取占用方的进程信息。可能是 Windows 主机服务、端口转发或端口保留；请刷新状态，或由有权限的系统操作释放端口。</dd></div>}
      {project.status.listeners.length > 0 && new Set(project.status.listeners.map((listener) => listener.pgid).filter((pgid): pgid is number => typeof pgid === 'number')).size > 1 && <div className="detail-wide takeover-warning"><dt>接管提示</dt><dd>检测到多个进程组；接管会在服务端重新核验所有候选，任何未知或跨目录成员都会安全拒绝。</dd></div>}
      {managedConflict && <div className="detail-wide"><dt>操作建议</dt><dd>此项目仍有受管服务记录，请先停止受管服务，再处理端口占用。</dd></div>}
      {project.status.failure && <div className="detail-wide takeover-failure"><dt>接管结果</dt><dd>{describeStatusFailure(project)}{project.status.failure.terminatedPids?.length ? ` 已终止 PID：${project.status.failure.terminatedPids.join(', ')}` : ''}{describeRecovery(project.status.failure)}{(project.status.diagnostics ?? project.status.failure.diagnostics) && <pre className="diagnostic-panel">{project.status.diagnostics ?? project.status.failure.diagnostics}</pre>}</dd></div>}
      {!supported && <div className="detail-wide"><dt>原因</dt><dd>{project.config.unsupportedReason || '此项目暂不支持通过面板控制。'}</dd></div>}
    </dl>
    <div className="card-actions">
      <button className="button primary" disabled={!supported || busy || inProgress || running || external} onClick={() => void action('start')}>启动</button>
      <button className="button secondary" disabled={!supported || busy || inProgress || (!running && !managedConflict)} onClick={() => void action('stop')}>停止</button>
      <button className="button secondary" disabled={!supported || busy || inProgress || external} onClick={() => void action('restart')}>重启</button>
      {canTakeover && <button className="button warning" disabled={busy || inProgress} onClick={() => { setTakeoverSnapshot(project.status.listeners); setTakeoverOpen(true); }}>接管服务</button>}
      {canForceTakeover && <button className="button danger" disabled={busy || inProgress} onClick={() => { setTakeoverSnapshot(project.status.listeners); setForceOpen(true); }}>强制释放端口</button>}
      {project.config.url && <a className="button link" href={project.config.url} target="_blank" rel="noreferrer">打开链接 ↗</a>}
    </div>
    <div className="card-footer">
      <button className="text-button" onClick={() => void toggleLogs()}>{logsOpen ? '收起日志' : '查看日志'}</button>
      <button className="text-button" disabled={!supported} onClick={() => setEditing((open) => !open)}>{editing ? '取消编辑' : '编辑配置'}</button>
    </div>
    {logsOpen && <LogPanel projectId={project.config.id} initialLogs={logs} />}
    {editing && <ConfigEditor project={project} onSaved={(updated) => { onSaved(updated); setEditing(false); }} onCancel={() => setEditing(false)} onError={onError} />}
    {takeoverOpen && takeoverSnapshot && <TakeoverDialog project={project} snapshot={takeoverSnapshot} onCancel={() => { setTakeoverOpen(false); setTakeoverSnapshot(null); }} onConfirm={async () => { const snapshot = takeoverSnapshot; setTakeoverOpen(false); setTakeoverSnapshot(null); await action('takeover', snapshot); }} />}
    {forceOpen && takeoverSnapshot && <ForceTakeoverDialog project={project} snapshot={takeoverSnapshot} onCancel={() => { setForceOpen(false); setTakeoverSnapshot(null); }} onConfirm={async () => { const snapshot = takeoverSnapshot; setForceOpen(false); setTakeoverSnapshot(null); await action('force-takeover', snapshot); }} />}
  </article>;
}

function ListenerList({ listeners }: { listeners: ProcessSnapshot[] }) {
  return <ul className="listener-list">
    {listeners.map((listener) => <li key={processSnapshotKey(listener)}>
      <div className="listener-heading"><strong>{listenerLabel(listener)}</strong><span>{listenerSideLabel(listener)}{listener.pgid ? ` · 进程组 ${listener.pgid}` : ''}{listener.groupPids?.length ? ` · 成员 ${listener.groupPids.join(', ')}` : ''}</span></div>
      {isPortProxy(listener)
        ? <>
          <div className="listener-mapping" title={mappingText(listener)}>{formatPortProxy(listener)}</div>
          {portProxyRuleLabel(listener) && <div className="listener-meta">规则：{portProxyRuleLabel(listener)}</div>}
        </>
        : <>
          <div className="listener-meta">启动：{listener.startedAt ?? '不可见'} · 目录：{listener.cwd ?? '不可见'}</div>
          <div className="listener-command" title={listener.command ?? listener.commandSummary ?? ruleText(listener)}>{listener.command ?? listener.commandSummary ?? listener.processName ?? '命令摘要不可见'}</div>
        </>}
      {(listener.manageable === false || listener.managementReason || listener.rejectionReason) && <div className="listener-unavailable">{listener.managementReason ?? listener.rejectionReason ?? '该占用方受系统保护，不能由面板自动管理'}</div>}
      {(listener.requiresElevation || listener.elevationRequired) && <div className="listener-elevation">确认后将请求 Windows 管理员权限（UAC）</div>}
      {listener.visibility === 'unavailable' && <div className="listener-unavailable">身份信息不可见，禁止自动接管</div>}
      {!isPortProxy(listener) && listener.groupComplete === false && <div className="listener-unavailable">进程组成员不完整，禁止自动接管</div>}
    </li>)}
  </ul>;
}

function isPortProxy(listener: ProcessSnapshot): boolean {
  return listener.kind === 'portproxy'
    || listener.kind === 'port-proxy'
    || listener.source === 'windows-portproxy'
    || Boolean((listener.mapping || listener.rule) && (listener.pid === undefined || listener.pid === 0));
}

function isWindowsCandidate(listener: ProcessSnapshot): boolean {
  return listener.side === 'windows' || isPortProxy(listener);
}

function isWindowsProcess(listener: ProcessSnapshot): boolean {
  return isWindowsCandidate(listener) && !isPortProxy(listener);
}

function listenerLabel(listener: ProcessSnapshot): string {
  if (isPortProxy(listener)) return 'Windows portproxy';
  return listener.pid ? `${isWindowsProcess(listener) ? 'Windows 进程' : 'PID'} ${listener.pid}` : '进程 PID 不可见';
}

function listenerSideLabel(listener: ProcessSnapshot): string {
  if (isPortProxy(listener)) return 'Windows 主机 · 端口转发规则';
  if (isWindowsProcess(listener)) return 'Windows 主机';
  return listener.side === 'unknown' ? '来源未知' : 'WSL';
}

function formatPortProxy(listener: ProcessSnapshot): string {
  if (typeof listener.mapping === 'string' && listener.mapping) return listener.mapping;
  if (typeof listener.rule === 'string' && listener.rule) return listener.rule;
  const rule = listener.rule && typeof listener.rule === 'object' ? listener.rule : undefined;
  const mapping = listener.mapping && typeof listener.mapping === 'object' ? listener.mapping : undefined;
  const left = `${rule?.listenAddress ?? mapping?.listenAddress ?? listener.listenAddress ?? '0.0.0.0'}:${rule?.listenPort ?? mapping?.listenPort ?? listener.listenPort ?? '未知'}`;
  const right = `${rule?.connectAddress ?? mapping?.connectAddress ?? listener.connectAddress ?? '127.0.0.1'}:${rule?.connectPort ?? mapping?.connectPort ?? listener.connectPort ?? '未知'}`;
  return `${left} → ${right}`;
}

function mappingText(listener: ProcessSnapshot): string | undefined {
  if (typeof listener.mapping === 'string') return listener.mapping;
  if (listener.mapping) return JSON.stringify(listener.mapping);
  return ruleText(listener);
}

function portProxyRuleLabel(listener: ProcessSnapshot): string | undefined {
  const rule = listener.rule && typeof listener.rule === 'object' ? listener.rule : undefined;
  const mapping = listener.mapping && typeof listener.mapping === 'object' ? listener.mapping : undefined;
  const ruleKey = (typeof rule?.ruleKey === 'string' ? rule.ruleKey : undefined)
    ?? (typeof mapping?.ruleKey === 'string' ? mapping.ruleKey : undefined)
    ?? listener.ruleKey;
  if (!ruleKey) return undefined;
  const family = (typeof rule?.family === 'string' ? rule.family : undefined)
    ?? (typeof mapping?.family === 'string' ? mapping.family : undefined);
  return family ? `${ruleKey} · ${family}` : ruleKey;
}

function ruleText(listener: ProcessSnapshot): string | undefined {
  if (typeof listener.rule === 'string') return listener.rule;
  if (listener.rule) return JSON.stringify(listener.rule);
  return undefined;
}

function takeoverSummary(project: Project, targets: { hasWindowsProcess: boolean; hasPortProxy: boolean; hasWslProcess: boolean }): string {
  const targetKinds = [
    targets.hasWslProcess ? '已核验的 WSL 进程组' : '',
    targets.hasWindowsProcess ? 'Windows 进程' : '',
    targets.hasPortProxy ? 'Windows portproxy 规则' : '',
  ].filter(Boolean).join('、');
  return `将把占用 ${project.config.port ?? '该'} 端口的 ${targetKinds || '全部已列出占用方'} 交给面板管理，然后重新启动 ${project.config.name}。`;
}

function LogPanel({ projectId, initialLogs }: { projectId: string; initialLogs: string[] }) {
  const [logs, setLogs] = useState(initialLogs);
  useEffect(() => setLogs(initialLogs), [initialLogs]);
  useEffect(() => {
    const stream = new EventSource('/api/events');
    const receive = (event: MessageEvent) => {
      const parsed = parseStreamEvent(event.type, event.data);
      if (parsed?.event === 'log' && parsed.projectId === projectId && parsed.log) setLogs((current) => [...current.slice(-499), parsed.log!]);
    };
    stream.addEventListener('log', receive);
    stream.addEventListener('message', receive);
    return () => stream.close();
  }, [projectId]);
  return <pre className="log-panel" aria-label="服务日志">{logs.length ? logs.join('\n') : '暂无日志'}</pre>;
}

function ConfigEditor({ project, onSaved, onCancel, onError }: { project: Project; onSaved: (project: Project) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [form, setForm] = useState({ ...project.config, port: project.config.port?.toString() ?? '', envText: configToEnvText(project.config.env) });
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const port = form.port.trim() === '' ? undefined : Number(form.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) { onError('端口必须在 1 到 65535 之间。'); return; }
    setSaving(true);
    try {
      const config: Omit<ProjectConfig, 'id'> = { name: form.name.trim(), directory: form.directory.trim(), startCommand: form.startCommand.trim(), packageManager: form.packageManager.trim(), port, url: (form.url ?? '').trim() || undefined, env: parseEnv(form.envText), supported: form.supported, unsupportedReason: form.unsupportedReason?.trim() || undefined };
      onSaved(await updateProject(project.config.id, config));
    } catch (error) { onError(`保存配置失败：${describeError(error)}`); } finally { setSaving(false); }
  };
  return <form className="config-editor" onSubmit={(event) => void submit(event)}>
    <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label>目录<input required value={form.directory} onChange={(event) => setForm({ ...form, directory: event.target.value })} /></label>
    <label>启动命令<input required value={form.startCommand} onChange={(event) => setForm({ ...form, startCommand: event.target.value })} /></label>
    <div className="form-row"><label>包管理器<input required value={form.packageManager} onChange={(event) => setForm({ ...form, packageManager: event.target.value })} /></label><label>端口<input inputMode="numeric" value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} /></label></div>
    <label>访问链接<input type="url" value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
    <label>环境变量（每行 KEY=VALUE）<textarea value={form.envText} onChange={(event) => setForm({ ...form, envText: event.target.value })} rows={3} /></label>
    <div className="editor-actions"><button type="button" className="button secondary" onClick={onCancel}>取消</button><button className="button primary" disabled={saving}>{saving ? '正在保存…' : '保存配置'}</button></div>
  </form>;
}

function TakeoverDialog({ project, snapshot, onCancel, onConfirm }: { project: Project; snapshot: ProcessSnapshot[]; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const completeSnapshot = snapshot.length > 0 && snapshot.every(isCompleteSnapshot);
  const processGroups = new Set(snapshot.map((listener) => listener.pgid).filter((pgid): pgid is number => typeof pgid === 'number'));
  const multipleGroups = processGroups.size > 1;
  const hasWindowsProcess = snapshot.some((listener) => isWindowsProcess(listener));
  const hasPortProxy = snapshot.some(isPortProxy);
  const hasWslProcess = snapshot.some((listener) => !isWindowsCandidate(listener));
  const hasProtectedTarget = snapshot.some((listener) => listener.manageable === false || listener.managementReason || listener.rejectionReason);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="takeover-title">
    <h3 id="takeover-title">确认接管服务？</h3>
    <p>{takeoverSummary(project, { hasWindowsProcess, hasPortProxy, hasWslProcess })}</p>
    <div className="takeover-snapshot"><ListenerList listeners={snapshot} /></div>
    {multipleGroups && <p className="dialog-warning">检测到多个进程组。服务端会在加锁后重新核验全部成员；只要存在未知、跨目录或不可见成员，就会拒绝接管。</p>}
    {hasWindowsProcess && <p className="dialog-warning">Windows 进程需要管理员权限。点击确认后，服务端会发起 Windows UAC 请求；若取消或拒绝授权，接管不会终止该进程。</p>}
    {hasPortProxy && <p className="dialog-warning">Windows portproxy 是端口转发规则，不会结束承载它的 svchost.exe。确认后只删除本端口对应的转发规则；若面板启动失败，服务端会尝试恢复原规则。</p>}
    {hasProtectedTarget && <p className="dialog-warning">列表中包含受保护或不可管理的占用方。为避免误操作，必须先刷新状态或由系统管理员手动处理。</p>}
    {!completeSnapshot && <p className="dialog-warning">存在无法完整读取的进程身份信息（启动时间、工作目录、命令或进程组）。为避免终止未知进程，必须刷新状态后再确认。</p>}
    {hasWslProcess && <p className="dialog-note">WSL 进程先发送 SIGTERM，最多等待 3 秒；仍未退出时才会对已验证进程组发送 SIGKILL。外部进程一旦终止，启动失败时不会自动恢复。</p>}
    <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={submitting || !completeSnapshot} /> 我已检查上述全部占用方，并确认可以按上面的方式交给面板管理</label>
    <div className="dialog-actions"><button className="button secondary" disabled={submitting} onClick={onCancel}>取消</button><button className="button danger" disabled={submitting || !completeSnapshot || !confirmed} onClick={async () => { setSubmitting(true); try { await onConfirm(); } finally { setSubmitting(false); } }}>{submitting ? '正在接管…' : '确认接管并重启'}</button></div>
  </section></div>;
}

function ForceTakeoverDialog({ project, snapshot, onCancel, onConfirm }: { project: Project; snapshot: ProcessSnapshot[]; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [portText, setPortText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const port = String(project.config.port ?? '');
  const canSubmit = confirmed && portText.trim() === port;
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="force-takeover-title">
    <h3 id="force-takeover-title">强制释放端口 {port}？</h3>
    <p className="dialog-warning">这是危险操作：它会终止当前占用该端口的监听 PID，即使进程组成员不完整或不属于此项目。该操作无法恢复被终止的进程。</p>
    <div className="takeover-snapshot"><ListenerList listeners={snapshot} /></div>
    <p className="dialog-note">Linux 侧只终止监听 PID，不会结束整个进程组。Windows 普通进程会请求 UAC；portproxy 只删除精确规则，不会结束 svchost。系统服务和身份不可见的占用仍会被拒绝。</p>
    <label className="force-port-confirm">输入端口 <strong>{port}</strong> 以确认<input inputMode="numeric" value={portText} onChange={(event) => setPortText(event.target.value)} disabled={submitting} aria-label="确认强制释放端口" /></label>
    <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={submitting} /> 我理解这会终止任意当前监听者，并确认继续</label>
    <div className="dialog-actions"><button className="button secondary" disabled={submitting} onClick={onCancel}>取消</button><button className="button danger" disabled={submitting || !canSubmit} onClick={async () => { setSubmitting(true); try { await onConfirm(); } finally { setSubmitting(false); } }}>{submitting ? '正在强制释放…' : '强制释放并启动'}</button></div>
  </section></div>;
}

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    const details = error.details;
    const phase = details.phase ? `（阶段：${details.phase}）` : '';
    const terminated = details.terminatedPids?.length ? ` 已终止 PID：${details.terminatedPids.join(', ')}` : '';
    const permission = details.permissionDenied
      ? ' Windows 管理员权限请求已取消或被拒绝。'
      : details.permissionRequired || details.requiresElevation || details.elevationRequired ? ' 需要 Windows 管理员权限，请在系统提示中允许。' : '';
    const release = details.releaseTimedOut ? ' 端口在等待窗口内仍未释放。' : '';
    const reasonText = details.managementReason ?? details.rejectionReason;
    const reason = reasonText ? ` 原因：${reasonText}。` : '';
    return `${error.message}${phase}${terminated}${permission}${release}${reason}${describeRestore(details.restore, details.restored, details.restoreFailed, details.restoreResults)}`;
  }
  if (error instanceof Error) return error.message;
  return '发生未知错误，请稍后重试。';
}

function errorDetails(error: unknown): NoticeDetails {
  if (!(error instanceof ApiError)) return {};
  return {
    diagnostics: error.details.diagnostics,
    refreshRequired: error.details.refreshRequired,
    permissionRequired: error.details.permissionRequired,
    permissionDenied: error.details.permissionDenied,
    requiresElevation: error.details.requiresElevation,
    elevationRequired: error.details.elevationRequired,
    managementReason: error.details.managementReason,
    rejectionReason: error.details.rejectionReason,
    restored: error.details.restored,
    restoreFailed: error.details.restoreFailed,
    restore: error.details.restore,
    restoreResults: error.details.restoreResults,
    releaseTimedOut: error.details.releaseTimedOut,
  };
}

function isCompleteSnapshot(snapshot: ProcessSnapshot): boolean {
  if (snapshot.manageable === false || snapshot.visibility === 'unavailable') return false;
  if (isPortProxy(snapshot)) return Boolean(
    hasPortProxyIdentity(snapshot),
  );
  if (isWindowsProcess(snapshot)) return Boolean(
    (snapshot.kind !== 'service' || snapshot.manageable === true)
      && snapshot.pid && snapshot.pid > 1
      && (snapshot.command || snapshot.commandSummary || snapshot.processName)
      && (snapshot.visibility === undefined || snapshot.visibility === 'visible'),
  );
  return Boolean(snapshot.pid && snapshot.pid > 1
    && snapshot.startedAt
    && snapshot.cwd
    && (snapshot.command || snapshot.commandSummary)
    && snapshot.pgid
    && (snapshot.visibility === undefined || snapshot.visibility === 'visible')
    && snapshot.groupComplete !== false);
}

function hasPortProxyIdentity(snapshot: ProcessSnapshot): boolean {
  const rule = snapshot.rule && typeof snapshot.rule === 'object' ? snapshot.rule : undefined;
  if (rule && rule.family && rule.listenAddress && Number.isSafeInteger(rule.listenPort)
    && rule.connectAddress && Number.isSafeInteger(rule.connectPort) && rule.ruleKey) return true;
  const mapping = snapshot.mapping && typeof snapshot.mapping === 'object' ? snapshot.mapping : undefined;
  if (!mapping) return false;
  return Boolean(
    mapping.family
      && mapping.listenAddress
      && Number.isSafeInteger(mapping.listenPort)
      && mapping.connectAddress
      && Number.isSafeInteger(mapping.connectPort)
      && typeof mapping.ruleKey === 'string'
      && mapping.ruleKey,
  );
}

function operationLabel(operation?: string): string {
  if (operation === 'takeover') return '强制接管进行中，请勿重复操作…';
  if (operation === 'start') return '启动进行中…';
  if (operation === 'stop') return '停止进行中…';
  if (operation === 'restart') return '重启进行中…';
  return '操作进行中，请稍候…';
}

function describeStatusFailure(project: Project): string {
  const failure = project.status.failure;
  const phase = failure?.phase ? `（阶段：${failure.phase}）` : '';
  return failure?.message ?? project.status.message ?? `操作失败${phase}`;
}

function describeRecovery(failure: NonNullable<Project['status']['failure']>): string {
  if (failure.permissionDenied) return ' Windows 管理员权限请求已取消或被拒绝，未执行 Windows 侧终止。';
  if (failure.permissionRequired || failure.requiresElevation || failure.elevationRequired) return ' 此操作需要 Windows 管理员权限，请在系统提示中允许后重试。';
  if (failure.releaseTimedOut) return ' 端口释放超时，未继续启动服务。';
  const reasonText = failure.managementReason ?? failure.rejectionReason;
  const reason = reasonText ? ` 原因：${reasonText}。` : '';
  return `${reason}${describeRestore(failure.restore, failure.restored, failure.restoreFailed, failure.restoreResults)}`;
}

function describeRestore(
  restore?: import('./api').RestoreResult,
  restored?: boolean,
  restoreFailed?: boolean,
  restoreResults?: import('./api').RestoreResultItem[],
): string {
  const resultText = restoreResults?.length ? ` 逐条结果：${restoreResults.map((result) => `${result.restored ? '已恢复' : '恢复失败'} ${result.ruleKey}${result.error ? `（${result.error}）` : ''}`).join('；')}。` : '';
  if (restore?.success === false || restore?.succeeded === false || restore?.failed || restore?.status === 'failed' || restore?.status === 'restore-failed' || restoreFailed || restoreResults?.some((result) => !result.restored)) {
    const detail = restore?.error ?? restore?.message;
    return ` 原 Windows 转发规则恢复失败${detail ? `：${detail}` : ''}，请根据诊断手动核对。${resultText}`;
  }
  if (restore?.success === true || restore?.succeeded === true || restore?.status === 'success' || restore?.status === 'restored' || restored || restoreResults?.every((result) => result.restored)) {
    const count = restore?.ruleKeys?.length ? `（${restore.ruleKeys.length} 条规则）` : '';
    return ` 原 Windows 转发规则已恢复${count}。${resultText}`;
  }
  if (restore?.message || restore?.error || resultText) return ` Windows 转发规则恢复结果：${restore?.error ?? restore?.message ?? ''}${resultText}`;
  return '';
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access is optional in local HTTP contexts; selecting remains possible.
  }
}
