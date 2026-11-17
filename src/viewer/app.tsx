import { marked, type Tokens } from 'marked';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AtlasEntityRecord, AtlasFlowRecord, AtlasGraph, AtlasSurfaceRecord } from '../atlas/atlas-artifacts';
import type { AtlasRunState } from '../atlas/atlas-runner';
import type { AtlasQueryResult } from '../atlas/atlas-search';
import type { SurfaceVerificationMap } from '../atlas/verifications';
import type { QaRunRecord } from '../qa/types';

interface ProjectInfo {
  name: string;
  projectDir: string;
  atlas: { published: boolean; manifest: { generatedAt?: string; runId?: string } | null };
  atlasRun: AtlasRunState | null;
  askEnabled: boolean;
  csrfToken: string;
}

interface RunSummary {
  id: string; url: string; goal: string; status: string; verdict?: string; summary?: string;
  provider: string; createdAt: string; finishedAt?: string; findingCount: number;
}

// ---------------------------------------------------------------- helpers

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as any)?.error || `HTTP ${response.status}`);
  return body as T;
}

const atlasFileUrl = (relPath: string) => `/api/atlas/file?relPath=${encodeURIComponent(relPath)}`;
const runShotUrl = (runId: string, path: string) =>
  `/api/qa/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(path.replace(/\\/g, '/').split('/screenshots/').slice(1).join('/screenshots/'))}`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

// Atlas and report Markdown is agent-written: raw HTML is escaped, unsafe
// link schemes are dropped, and relative shots/ images go through the API.
marked.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) { return escapeHtml(token.text); },
    link(token: Tokens.Link) {
      const clean = token.href.trim();
      const href = /^(https?:\/\/|#)/i.test(clean) || (!/[:\\\s]/.test(clean) && !clean.startsWith('//')) ? clean : '#';
      return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${this.parser.parseInline(token.tokens)}</a>`;
    },
    image(token: Tokens.Image) {
      const src = /^shots\//.test(token.href) ? atlasFileUrl(token.href)
        : /^https?:/i.test(token.href) ? token.href : '';
      return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}">` : escapeHtml(token.text);
    },
  },
});

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ago(iso?: string): string {
  if (!iso) return '-';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function matchesFilter(item: object, filter: string): boolean {
  if (!filter) return true;
  const haystack = JSON.stringify(item).toLowerCase();
  return filter.toLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

type Navigate = (id: string) => void;

function IdChip({ id, onNavigate }: { id: string; onNavigate: Navigate }) {
  return <button className="chip" onClick={() => onNavigate(id)}>{id}</button>;
}

// ---------------------------------------------------------------- atlas views

function Overview({ graph, project, verifications }: { graph: AtlasGraph; project: ProjectInfo; verifications: SurfaceVerificationMap }) {
  const verified = graph.surfaces.filter(s => s.status === 'verified').length;
  const gaps = graph.surfaces.filter(s => s.status === 'partial' || s.status === 'unverified').length;
  return (
    <>
      <div className="cards">
        <div className="card"><div className="num">{graph.surfaces.length}</div><div className="label">Surfaces</div></div>
        <div className="card"><div className="num">{graph.entities.length}</div><div className="label">Entities</div></div>
        <div className="card"><div className="num">{graph.flows?.length ?? 0}</div><div className="label">Flows</div></div>
        <div className="card"><div className="num status-verified">{verified}</div><div className="label">Verified surfaces</div></div>
        <div className="card"><div className="num status-partial">{gaps}</div><div className="label">Coverage gaps</div></div>
        <div className="card"><div className="num">{Object.keys(verifications).length}</div><div className="label">QA-verified</div></div>
      </div>
      <p className="meta">Generated {ago(graph.generatedAt)} by run <code>{graph.runId}</code>. Project: <code>{project.name}</code></p>
    </>
  );
}

function SurfaceDetailView({ surface, graph, verifications, onNavigate }: {
  surface: AtlasSurfaceRecord; graph: AtlasGraph; verifications: SurfaceVerificationMap; onNavigate: Navigate;
}) {
  const flows = graph.flows ?? [];
  const inbound = flows.filter(f => f.toSurfaceId === surface.id);
  const outbound = flows.filter(f => f.fromSurfaceId === surface.id);
  const qa = verifications[surface.id];
  return (
    <div className="detail">
      <h2>{surface.name} <span className={`badge status-${surface.status}`}>{surface.status.toUpperCase()}</span></h2>
      {surface.description && <p>{surface.description}</p>}
      <dl>
        <dt>ID</dt><dd><code>{surface.id}</code></dd>
        {surface.route && <><dt>Route</dt><dd><code>{surface.route}</code></dd></>}
        {surface.reach && <><dt>How to reach</dt><dd>{surface.reach}</dd></>}
        {!!surface.entityIds?.length && <><dt>Shows</dt><dd>{surface.entityIds.map(id => <IdChip key={id} id={id} onNavigate={onNavigate} />)}</dd></>}
        {!!surface.actions?.length && <><dt>Actions</dt><dd>{surface.actions.join('; ')}</dd></>}
        {!!surface.states?.length && <><dt>States</dt><dd>{surface.states.join('; ')}</dd></>}
        {!!surface.codeRefs?.length && <><dt>Code</dt><dd>{surface.codeRefs.map(ref => <div key={ref}><code>{ref}</code></div>)}</dd></>}
        {!!inbound.length && <><dt>Reached from</dt><dd>{inbound.map(f => <IdChip key={f.id} id={f.fromSurfaceId} onNavigate={onNavigate} />)}</dd></>}
        {!!outbound.length && <><dt>Leads to</dt><dd>{outbound.map(f => <IdChip key={f.id} id={f.toSurfaceId} onNavigate={onNavigate} />)}</dd></>}
        <dt>Last QA pass</dt><dd>{qa ? `${ago(qa.lastPassedAt)} (run ${qa.runId})` : 'never'}</dd>
      </dl>
      {(surface.screenshotRefs ?? []).map(ref => <img key={ref} className="shot" src={atlasFileUrl(ref)} alt={`${surface.name} screenshot`} />)}
    </div>
  );
}

function EntityDetailView({ entity, graph, onNavigate }: { entity: AtlasEntityRecord; graph: AtlasGraph; onNavigate: Navigate }) {
  const surfaces = graph.surfaces.filter(s => (s.entityIds ?? []).includes(entity.id));
  return (
    <div className="detail">
      <h2>{entity.name}</h2>
      {entity.description && <p>{entity.description}</p>}
      <dl>
        <dt>ID</dt><dd><code>{entity.id}</code></dd>
        {!!entity.fields?.length && <><dt>Fields</dt><dd>{entity.fields.map(f => <div key={f}><code>{f}</code></div>)}</dd></>}
        {!!entity.codeRefs?.length && <><dt>Code</dt><dd>{entity.codeRefs.map(ref => <div key={ref}><code>{ref}</code></div>)}</dd></>}
        <dt>Shown on</dt><dd>{surfaces.length ? surfaces.map(s => <IdChip key={s.id} id={s.id} onNavigate={onNavigate} />) : 'no surface lists this entity'}</dd>
      </dl>
    </div>
  );
}

function FlowDetailView({ flow, onNavigate }: { flow: AtlasFlowRecord; onNavigate: Navigate }) {
  return (
    <div className="detail">
      <h2>{flow.name}</h2>
      <dl>
        <dt>ID</dt><dd><code>{flow.id}</code></dd>
        <dt>From</dt><dd><IdChip id={flow.fromSurfaceId} onNavigate={onNavigate} /></dd>
        <dt>To</dt><dd><IdChip id={flow.toSurfaceId} onNavigate={onNavigate} /></dd>
        {flow.trigger && <><dt>Trigger</dt><dd>{flow.trigger}</dd></>}
      </dl>
    </div>
  );
}

function ListAndDetail<T extends { id: string; name: string }>({ items, selected, onSelect, sub, render }: {
  items: T[]; selected: string | null; onSelect: (id: string) => void; sub: (item: T) => string; render: (item: T) => ReactElement;
}) {
  const [filter, setFilter] = useState('');
  const visible = items.filter(item => matchesFilter(item, filter));
  const current = visible.find(item => item.id === selected) ?? visible[0];
  return (
    <div className="split">
      <div>
        <input className="search" aria-label="Filter records" placeholder="Filter..." value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="list">
          {visible.map(item => (
            <button key={item.id} className={`list-item ${current?.id === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
              <div>{item.name}</div><div className="sub">{sub(item)}</div>
            </button>
          ))}
          {visible.length === 0 && <div className="empty">Nothing matches.</div>}
        </div>
      </div>
      {current ? render(current) : <div className="detail empty">Nothing to show.</div>}
    </div>
  );
}

function QueryView({ project, onNavigate }: { project: ProjectInfo; onNavigate: Navigate }) {
  const [question, setQuestion] = useState('');
  const [local, setLocal] = useState<AtlasQueryResult | null>(null);
  const [answer, setAnswer] = useState<{ answer: string; citations: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runLocal = async () => {
    setError(null); setAnswer(null);
    try { setLocal(await getJson<AtlasQueryResult>(`/api/atlas/query?q=${encodeURIComponent(question)}`)); }
    catch (e) { setError((e as Error).message); }
  };
  const runAsk = async () => {
    setError(null); setBusy(true);
    try {
      const response = await fetch('/api/atlas/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-csrf': project.csrfToken }, body: JSON.stringify({ question }) });
      const body = await response.json();
      if (!response.ok) throw new Error([body.error, ...(body.validationErrors ?? [])].join(' / '));
      setAnswer(body);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="row">
        <input className="search" aria-label="Ask Atlas" style={{ marginBottom: 0 }} placeholder='e.g. "where is the note title shown?"' value={question}
          onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && question.trim()) void runLocal(); }} />
        <button className="btn primary" disabled={!question.trim()} onClick={runLocal}>Search atlas</button>
        <button className="btn" disabled={!question.trim() || busy || !project.askEnabled} onClick={runAsk}
          title={project.askEnabled ? 'Ask an LLM analyst (uses your provider)' : 'Start the viewer with --allow-ask to enable'}>
          {busy ? 'Asking...' : 'Ask LLM'}
        </button>
      </div>
      <p className="meta">Search is instant and offline. "Ask LLM" sends the question to your configured provider and only accepts answers that cite real atlas IDs.</p>
      {error && <p className="error">{error}</p>}
      {answer && <div className="detail"><Markdown text={answer.answer} /><div>{answer.citations.map(id => <IdChip key={id} id={id} onNavigate={onNavigate} />)}</div></div>}
      {local && !answer && <QueryResultView result={local} onNavigate={onNavigate} />}
    </div>
  );
}

function QueryResultView({ result, onNavigate }: { result: AtlasQueryResult; onNavigate: Navigate }) {
  if (result.intent === 'search') return <div className="empty">No surface, entity, or flow matched.</div>;
  return (
    <div className="detail">
      {result.intent === 'entity-surfaces' && <>
        <h2>{result.entity.name} is shown on {result.surfaces.length} surface{result.surfaces.length === 1 ? '' : 's'}</h2>
        {result.surfaces.map(s => <div key={s.id}><IdChip id={s.id} onNavigate={onNavigate} /> {s.name}{s.reach ? `: ${s.reach}` : ''}</div>)}
      </>}
      {result.intent === 'surface' && <>
        <h2>{result.detail.surface.name}</h2>
        <p>{result.detail.surface.reach ?? ''}</p>
        <IdChip id={result.detail.surface.id} onNavigate={onNavigate} />
        {result.detail.clickPath && result.detail.clickPath.length > 0 && (
          <p>Click path: {result.detail.clickPath.map(f => `${f.fromSurfaceId} -[${f.trigger ?? f.name}]-> ${f.toSurfaceId}`).join(', ')}</p>
        )}
      </>}
      {result.intent === 'flow' && <h2>{result.flow.name}</h2>}
      {result.matches.length > 1 && <><h3>Related</h3>{result.matches.slice(1, 8).map(m => <IdChip key={m.id} id={m.id} onNavigate={onNavigate} />)}</>}
    </div>
  );
}

// ---------------------------------------------------------------- QA runs

function RunsView() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => getJson<RunSummary[]>('/api/qa/runs').then(setRuns).catch(e => setError(e.message));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!runs) return <div className="empty">Loading...</div>;
  if (selected) return <RunDetail id={selected} onBack={() => setSelected(null)} />;
  if (runs.length === 0) return <div className="empty">No QA runs yet. Try: <code>bun run qa run --url http://localhost:4400 --goal "..."</code></div>;
  return (
    <table className="runs">
      <thead><tr><th>Verdict</th><th>Goal</th><th>Target</th><th>Findings</th><th>When</th></tr></thead>
      <tbody>
        {runs.map(run => (
          <tr key={run.id}>
            <td className={`badge verdict-${run.verdict ?? 'inconclusive'}`}>{(run.verdict ?? run.status).toUpperCase()}</td>
            <td><button className="run-link" onClick={() => setSelected(run.id)}>{run.goal.length > 120 ? `${run.goal.slice(0, 120)}...` : run.goal}</button><div className="meta">{run.summary}</div></td>
            <td><code>{run.url}</code></td>
            <td>{run.findingCount}</td>
            <td>{ago(run.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [run, setRun] = useState<QaRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getJson<QaRunRecord>(`/api/qa/runs/${encodeURIComponent(id)}`).then(setRun).catch(e => setError(e.message)); }, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!run) return <div className="empty">Loading...</div>;
  const screenshots = (run.evidence ?? []).filter(e => e.kind === 'screenshot' && e.ref);
  return (
    <div>
      <button className="btn" onClick={onBack}>Back to runs</button>
      {' '}<a className="btn" href={`/api/qa/runs/${encodeURIComponent(id)}/report`} download={`qa-${id}.md`}>Download report</a>
      <div className="detail" style={{ marginTop: 12 }}>
        <h2><span className={`verdict-${run.verdict ?? 'inconclusive'}`}>{(run.verdict ?? run.status).toUpperCase()}</span> {run.summary}</h2>
        <dl>
          <dt>Run</dt><dd><code>{run.id}</code></dd>
          <dt>Target</dt><dd><code>{run.url}</code></dd>
          <dt>Goal</dt><dd>{run.goal}</dd>
          {run.changeDescription && <><dt>Change</dt><dd>{run.changeDescription}</dd></>}
          <dt>Provider</dt><dd>{run.provider}{run.model ? ` (${run.model})` : ''}</dd>
          <dt>Status</dt><dd>{run.status}</dd>
          <dt>Reported tokens</dt><dd>{run.usage?.inputTokens ?? 'unknown'} input / {run.usage?.outputTokens ?? 'unknown'} output</dd>
          <dt>Reported cost</dt><dd>{run.usage?.costUsd === undefined ? 'unknown' : `$${run.usage.costUsd.toFixed(4)}`}</dd>
        </dl>
        {!!run.validationErrors?.length && <div className="banner">Harness validation:<ul>{run.validationErrors.map(e => <li key={e}>{e}</li>)}</ul></div>}
        {!!run.assertions?.length && <>
          <h3>Assertions</h3>
          {run.assertions.map(a => <div key={a.id}><span className={`badge verdict-${a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : a.status === 'warning' ? 'warnings' : 'inconclusive'}`}>{a.status}</span> {a.name}{a.observed ? `: ${a.observed}` : ''}</div>)}
        </>}
        {!!run.findings?.length && <>
          <h3>Findings</h3>
          {run.findings.map(f => <div key={f.id} style={{ marginBottom: 8 }}><strong>[{f.severity}] {f.title}</strong><div>{f.details}</div></div>)}
        </>}
        {!!screenshots.length && <>
          <h3>Screenshots</h3>
          <div className="gallery">{screenshots.map(s => (
            <figure key={s.id}><img className="shot" src={runShotUrl(run.id, s.ref!)} alt={s.label} /><figcaption>{s.label}</figcaption></figure>
          ))}</div>
        </>}
        {!!run.evidence?.length && <>
          <h3>Evidence details</h3>
          {run.evidence.filter(e => e.kind !== 'screenshot').map(e => <p key={e.id}><strong>{e.label}</strong>{e.detail ? `: ${e.detail}` : ''}</p>)}
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shell

const TABS = [
  ['overview', 'Overview'], ['surfaces', 'Surfaces'], ['entities', 'Entities'], ['flows', 'Flows'],
  ['gallery', 'Gallery'], ['document', 'Document'], ['query', 'Ask Atlas'], ['runs', 'QA runs'],
] as const;
type Tab = typeof TABS[number][0];

function AtlasRunBanner({ run }: { run: AtlasRunState }) {
  if (run.status === 'completed') return null;
  return (
    <div className="banner">
      <strong>Atlas run {run.id}: {run.status}</strong> ({run.phase}). {run.error ?? ''}
      {!!run.validationErrors?.length && <ul>{run.validationErrors.slice(0, 8).map(e => <li key={e}>{e}</li>)}</ul>}
    </div>
  );
}

function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [graph, setGraph] = useState<AtlasGraph | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [verifications, setVerifications] = useState<SurfaceVerificationMap>({});
  const [tab, setTab] = useState<Tab>('overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<ProjectInfo>('/api/project').then(async info => {
      setProject(info);
      if (!info.atlas.published) { setTab('runs'); return; }
      setGraph(await getJson<AtlasGraph>('/api/atlas/graph'));
      setVerifications(await getJson<SurfaceVerificationMap>('/api/atlas/verifications'));
      const md = await fetch(atlasFileUrl('atlas.md'));
      if (md.ok) setMarkdown(await md.text());
    }).catch(e => setError(e.message));
  }, []);

  const navigate: Navigate = id => {
    setSelected(id);
    setTab(id.startsWith('entity.') ? 'entities' : id.startsWith('flow.') ? 'flows' : 'surfaces');
  };

  if (error) return <main><p className="error">{error}</p></main>;
  if (!project) return <main className="empty">Loading...</main>;
  const tabs = graph ? TABS : TABS.filter(([key]) => key === 'runs');

  return (
    <div className="app">
      <header className="topbar">
        <h1>UI Atlas + QA</h1>
        <span className="meta">{project.name}</span>
        {graph && <span className="meta">{graph.surfaces.length} surfaces, {graph.entities.length} entities</span>}
      </header>
      <nav className="tabs">
        {tabs.map(([key, label]) => <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      <main>
        {project.atlasRun && <AtlasRunBanner run={project.atlasRun} />}
        {!graph && tab !== 'runs' && <div className="empty">No UI Atlas has been published for this project yet.</div>}
        {!graph && tab === 'runs' && <p className="meta">No UI Atlas has been published for this project yet. Build one with <code>bun run atlas build &lt;projectDir&gt; --url &lt;appUrl&gt;</code>.</p>}
        {graph && tab === 'overview' && <Overview graph={graph} project={project} verifications={verifications} />}
        {graph && tab === 'surfaces' && <ListAndDetail items={graph.surfaces} selected={selected} onSelect={setSelected}
          sub={s => `${s.id} | ${s.status}`} render={s => <SurfaceDetailView surface={s} graph={graph} verifications={verifications} onNavigate={navigate} />} />}
        {graph && tab === 'entities' && <ListAndDetail items={graph.entities} selected={selected} onSelect={setSelected}
          sub={e => e.id} render={e => <EntityDetailView entity={e} graph={graph} onNavigate={navigate} />} />}
        {graph && tab === 'flows' && <ListAndDetail items={graph.flows ?? []} selected={selected} onSelect={setSelected}
          sub={f => `${f.fromSurfaceId} -> ${f.toSurfaceId}`} render={f => <FlowDetailView flow={f} onNavigate={navigate} />} />}
        {graph && tab === 'gallery' && <div className="gallery">{graph.surfaces.flatMap(s => (s.screenshotRefs ?? []).map(ref => (
          <figure key={ref}><img className="shot" src={atlasFileUrl(ref)} alt={s.name} onClick={() => navigate(s.id)} /><figcaption>{s.name} ({s.id})</figcaption></figure>
        )))}</div>}
        {graph && tab === 'document' && (markdown ? <div className="detail"><Markdown text={markdown} /></div> : <div className="empty">atlas.md not found.</div>)}
        {graph && tab === 'query' && <QueryView project={project} onNavigate={navigate} />}
        {tab === 'runs' && <RunsView />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
