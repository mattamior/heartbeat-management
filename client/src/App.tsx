import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  Project,
  ProjectConfig,
  ProjectStatusKind,
  getLogs,
  getProjects,
  parseStreamEvent,
  runProjectAction,
  updateProject,
} from './api';

const STATUS_META: Record<string, { label: string; tone: string }> = {
  'managed-running': { label: '面板管理中', tone: 'success' },
  'external-running': { label: '外部进程运行中', tone: 'warning' },
  stopped: { label: '已停止', tone: 'muted' },
  failed: { label: '启动失败', tone: 'danger' },
  'port-conflict': { label: '端口冲突', tone: 'danger' },
  unsupported: { label: '暂不支持', tone: 'muted' },
};

type Filter = 'all' | 'managed-running' | 'external-running' | 'stopped' | 'failed' | 'port-conflict' | 'unsupported';
type Notice = { tone: 'error' | 'info'; text: string } | null;

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
  const invokeAction = useCallback(async (project: Project, action: 'start' | 'stop' | 'restart' | 'takeover') => {
    try {
      const updated = await runProjectAction(project, action);
      applyProject(updated);
      setNotice({ tone: 'info', text: `${project.config.name}：操作已提交` });
    } catch (error) {
      setNotice({ tone: 'error', text: `${project.config.name}：${describeError(error)}` });
    }
  }, [applyProject]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-heading">
            <img className="brand-mark" src="/brand/heartbeat-mark.svg" alt="Heartbeat 标志" width="42" height="42" />
            <div>
              <p className="eyebrow">127.0.0.1 · LOCAL ONLY</p>
              <h1>Heartbeat</h1>
            </div>
          </div>
          <p className="subtitle">本地开发服务控制台 · Local Dev Service Control</p>
        </div>
        <div className="header-actions">
          <span className={`connection ${connection}`}><i />{connection === 'connected' ? '实时同步中' : connection === 'connecting' ? '正在连接' : '实时连接断开'}</span>
          <button className="button secondary" onClick={() => void refresh()} disabled={loading}>刷新状态</button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.tone}`} role="alert">{notice.text}<button onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div>}

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

function ProjectCard({ project, onAction, onSaved, onError }: { project: Project; onAction: (project: Project, action: 'start' | 'stop' | 'restart' | 'takeover') => Promise<void>; onSaved: (project: Project) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const meta = getStatusMeta(project.status.kind);
  const supported = project.config.supported !== false && project.status.kind !== 'unsupported';
  const running = project.status.kind === 'managed-running';
  const external = project.status.kind === 'external-running' || project.status.kind === 'port-conflict';
  const managedConflict = project.status.kind === 'port-conflict'
    && Boolean(project.status.managedPid ?? project.status.startedAt);
  const canTakeover = project.status.kind === 'external-running'
    || (project.status.kind === 'port-conflict' && !managedConflict);

  const action = async (kind: 'start' | 'stop' | 'restart' | 'takeover') => {
    setBusy(true);
    try { await onAction(project, kind); } finally { setBusy(false); }
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
      <div><dt>端口</dt><dd>{project.config.port ?? '—'}{project.status.pid ? ` · PID ${project.status.pid}` : ''}</dd></div>
      <div><dt>包管理器</dt><dd>{project.config.packageManager || '—'}</dd></div>
      {project.status.message && <div className="detail-wide"><dt>提示</dt><dd>{project.status.message}</dd></div>}
      {managedConflict && <div className="detail-wide"><dt>操作建议</dt><dd>此项目仍有受管服务记录，请先停止受管服务，再处理端口占用。</dd></div>}
      {!supported && <div className="detail-wide"><dt>原因</dt><dd>{project.config.unsupportedReason || '此项目暂不支持通过面板控制。'}</dd></div>}
    </dl>
    <div className="card-actions">
      <button className="button primary" disabled={!supported || busy || running || external} onClick={() => void action('start')}>启动</button>
      <button className="button secondary" disabled={!supported || busy || (!running && !managedConflict)} onClick={() => void action('stop')}>停止</button>
      <button className="button secondary" disabled={!supported || busy || external} onClick={() => void action('restart')}>重启</button>
      {canTakeover && <button className="button warning" disabled={!supported || busy} onClick={() => setTakeoverOpen(true)}>接管服务</button>}
      {project.config.url && <a className="button link" href={project.config.url} target="_blank" rel="noreferrer">打开链接 ↗</a>}
    </div>
    <div className="card-footer">
      <button className="text-button" onClick={() => void toggleLogs()}>{logsOpen ? '收起日志' : '查看日志'}</button>
      <button className="text-button" disabled={!supported} onClick={() => setEditing((open) => !open)}>{editing ? '取消编辑' : '编辑配置'}</button>
    </div>
    {logsOpen && <LogPanel projectId={project.config.id} initialLogs={logs} />}
    {editing && <ConfigEditor project={project} onSaved={(updated) => { onSaved(updated); setEditing(false); }} onCancel={() => setEditing(false)} onError={onError} />}
    {takeoverOpen && <TakeoverDialog project={project} onCancel={() => setTakeoverOpen(false)} onConfirm={async () => { setTakeoverOpen(false); await action('takeover'); }} />}
  </article>;
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

function TakeoverDialog({ project, onCancel, onConfirm }: { project: Project; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="takeover-title">
    <h3 id="takeover-title">确认接管服务？</h3>
    <p>将结束占用 {project.config.port ?? '该'} 端口的外部进程{project.status.pid ? `（PID ${project.status.pid}）` : ''}，然后由本面板重新启动 <strong>{project.config.name}</strong>。</p>
    <p className="dialog-note">请确认没有其他工作依赖该进程。</p>
    <div className="dialog-actions"><button className="button secondary" disabled={submitting} onClick={onCancel}>取消</button><button className="button danger" disabled={submitting} onClick={async () => { setSubmitting(true); try { await onConfirm(); } finally { setSubmitting(false); } }}>{submitting ? '正在接管…' : '确认接管'}</button></div>
  </section></div>;
}

function describeError(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '发生未知错误，请稍后重试。';
}
