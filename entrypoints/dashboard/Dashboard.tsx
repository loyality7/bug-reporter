import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, bugLabel, deleteBug, deleteSession, finishSession, type Bug, type BugStatus, type Severity } from '@/lib/db';
import { Image, Mic, Terminal, Network, Search } from 'lucide-react';
import { Button, useBlobUrl, fmtDate, fmtBytes, Badge, EmptyState } from '@/components/ui';
import { Select } from '@/components/Select';
import Transcribe from '@/components/Transcribe';
import GitHubAction from '@/components/GitHubAction';
import ExportPanel from './ExportPanel';
import GitHubPanel from './GitHubPanel';
import StoragePanel from './StoragePanel';

const STATUSES: BugStatus[] = ['open', 'in_progress', 'fixed', 'closed', 'ignored'];
const STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open', in_progress: 'In Progress', fixed: 'Fixed', closed: 'Closed', ignored: 'Ignored',
};
type Tab = 'sheet' | 'document' | 'export' | 'github' | 'storage';

const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
const STATUS_FILTER_OPTIONS = [
  { value: 'all' as const, label: 'All statuses' },
  ...STATUS_OPTIONS,
];

const SEVERITY_TONE = {
  low: 'neutral', medium: 'info', high: 'warn', critical: 'danger',
} as const satisfies Record<Severity, 'neutral' | 'info' | 'warn' | 'danger'>;

export default function Dashboard() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('session');
  // Capture cards link here with ?tab=github when no repo is connected yet.
  const requestedTab = params.get('tab') as Tab | null;
  const sessions = useLiveQuery(() => db.sessions.orderBy('startedAt').reverse().toArray(), []);
  const [picked, setPicked] = useState<string | null>(requested);
  const [tab, setTab] = useState<Tab>(
    requestedTab && ['sheet', 'document', 'export', 'github', 'storage'].includes(requestedTab)
      ? requestedTab
      : 'sheet',
  );

  const sessionId = picked ?? sessions?.[0]?.id ?? null;
  const session = sessions?.find((s) => s.id === sessionId);

  if (!sessions) return <Center>Loading…</Center>;
  if (sessions.length === 0)
    return <Center>No sessions yet. Start one from the extension popup.</Center>;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 pb-3 pt-4">
          <select
            value={sessionId ?? ''}
            onChange={(e) => setPicked(e.target.value)}
            className="h-9 max-w-[280px] rounded-md border border-neutral-300 bg-white px-2.5 text-sm font-medium outline-none transition-colors focus:border-neutral-900"
          >
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {session && (
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              {fmtDate(session.startedAt)}
              {session.endedAt ? (
                <>— {fmtDate(session.endedAt)}</>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Active
                </span>
              )}
            </span>
          )}
          <div className="ml-auto flex gap-2">
            {session && !session.endedAt && (
              <Button variant="secondary" size="sm" onClick={() => finishSession(session.id)}>Finish session</Button>
            )}
            {session && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  if (confirm(`Delete "${session.name}" and all its bugs and evidence? This cannot be undone.`)) {
                    deleteSession(session.id);
                    setPicked(null);
                  }
                }}
              >
                Delete session
              </Button>
            )}
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 px-6">
          {(['sheet', 'document', 'export', 'github', 'storage'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-sm capitalize transition-colors ${
                tab === t ? 'border-neutral-900 font-medium text-neutral-900' : 'border-transparent text-neutral-500 hover:text-neutral-900'
              }`}
            >
              {t === 'github' ? 'GitHub' : t}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {sessionId && tab === 'sheet' && <SheetView sessionId={sessionId} />}
        {sessionId && tab === 'document' && <DocumentView sessionId={sessionId} />}
        {sessionId && tab === 'export' && <ExportPanel sessionId={sessionId} />}
        {sessionId && tab === 'github' && <GitHubPanel sessionId={sessionId} />}
        {tab === 'storage' && <StoragePanel onDeleted={() => setPicked(null)} />}
      </main>
    </div>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-neutral-50 text-sm text-neutral-500">{children}</div>
);

function useBugs(sessionId: string) {
  return useLiveQuery(
    async () => (await db.bugs.where('sessionId').equals(sessionId).toArray()).sort((a, b) => a.seq - b.seq),
    [sessionId],
  );
}

/**
 * Renders only the rows near the viewport. A session with hundreds of bugs would otherwise
 * mount hundreds of components, each running its own evidence query.
 */
const ROW_HEIGHT = 41;
const OVERSCAN = 8;

function useWindowedRows(count: number, containerRef: React.RefObject<HTMLDivElement | null>) {
  const [range, setRange] = useState({ start: 0, end: 40 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const first = Math.floor(el.scrollTop / ROW_HEIGHT);
      const visible = Math.ceil(el.clientHeight / ROW_HEIGHT);
      setRange({
        start: Math.max(0, first - OVERSCAN),
        end: Math.min(count, first + visible + OVERSCAN),
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { el.removeEventListener('scroll', update); observer.disconnect(); };
  }, [count, containerRef]);

  return range;
}

function SheetView({ sessionId }: { sessionId: string }) {
  const bugs = useBugs(sessionId);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BugStatus | 'all'>('all');
  const [open, setOpen] = useState<Bug | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (bugs ?? []).filter(
      (b) =>
        (status === 'all' || b.status === status) &&
        (!needle || `${bugLabel(b.seq)} ${b.title} ${b.description} ${b.url}`.toLowerCase().includes(needle)),
    );
  }, [bugs, q, status]);

  const visible = useWindowedRows(rows.length, scroller);

  if (!bugs) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (bugs.length === 0)
    return <EmptyState title="No bugs captured yet" hint="Open the extension and capture one to see it here." />;

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <div className="relative">
          <Search size={14} strokeWidth={2} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bugs"
            className="h-9 w-64 rounded-md border border-neutral-300 bg-white pl-8 pr-3 text-sm placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-900"
          />
        </div>
        <Select
          ariaLabel="Filter by status"
          className="w-40"
          value={status}
          options={STATUS_FILTER_OPTIONS}
          onChange={setStatus}
        />
        <span className="ml-auto text-xs tabular-nums text-neutral-500">{rows.length} of {bugs.length}</span>
      </div>

      <div ref={scroller} className="max-h-[70vh] overflow-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 border-b border-neutral-200 bg-neutral-50 text-left text-[11px] uppercase tracking-wider text-neutral-500">
            <tr>
              {['ID', 'Title', 'Page', 'Time', 'Evidence', 'Severity', 'Status', ''].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.start > 0 && <tr style={{ height: visible.start * ROW_HEIGHT }} />}
            {rows.slice(visible.start, visible.end).map((b) => (
              <Row key={b.id} bug={b} onOpen={() => setOpen(b)} />
            ))}
            {visible.end < rows.length && <tr style={{ height: (rows.length - visible.end) * ROW_HEIGHT }} />}
          </tbody>
        </table>
      </div>

      {open && <BugModal bug={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Row({ bug, onOpen }: { bug: Bug; onOpen: () => void }) {
  const kinds = useLiveQuery(
    async () => (await db.evidence.where('bugId').equals(bug.id).toArray()).map((e) => e.kind),
    [bug.id],
  ) ?? [];
  return (
    <tr className="border-t border-neutral-100 transition-colors hover:bg-neutral-50">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{bugLabel(bug.seq)}</td>
      <td className="max-w-xs px-3 py-2">
        <button onClick={onOpen} className="block w-full truncate text-left font-medium text-neutral-900 hover:underline">
          {bug.title || <span className="font-normal text-neutral-400">Untitled</span>}
        </button>
      </td>
      <td className="max-w-[220px] truncate px-3 py-2 text-xs text-neutral-500">{bug.url}</td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">{new Date(bug.createdAt).toLocaleTimeString()}</td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5 text-neutral-400">
          {kinds.includes('screenshot') && <Image size={14} strokeWidth={2} aria-label="Screenshot" />}
          {kinds.includes('audio') && (
            <Mic size={14} strokeWidth={2} className="text-amber-600" aria-label="Voice note not yet transcribed" />
          )}
          {bug.console.some((c) => c.level === 'error') && (
            <Terminal size={14} strokeWidth={2} className="text-red-500" aria-label="Console errors" />
          )}
          {bug.network.some((n) => n.failed) && (
            <Network size={14} strokeWidth={2} className="text-red-500" aria-label="Failed requests" />
          )}
        </span>
      </td>
      <td className="px-3 py-2">
        <span className="capitalize"><Badge tone={SEVERITY_TONE[bug.severity]}>{bug.severity}</Badge></span>
      </td>
      <td className="px-3 py-2">
        <Select
          ariaLabel="Status"
          className="w-32"
          value={bug.status}
          options={STATUS_OPTIONS}
          onChange={(v) => db.bugs.update(bug.id, { status: v })}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={() => confirm(`Delete ${bugLabel(bug.seq)}?`) && deleteBug(bug.id)}
          className="rounded px-1.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

const envBlock = (bug: Bug) =>
  [
    `User agent: ${bug.context.userAgent}`,
    `Platform:   ${bug.context.platform}`,
    `Screen:     ${bug.context.screen.width}x${bug.context.screen.height}`,
    `Viewport:   ${bug.context.viewport.width}x${bug.context.viewport.height} @${bug.context.devicePixelRatio}x`,
  ].join('\n');

function BugModal({ bug, onClose }: { bug: Bug; onClose: () => void }) {
  const shot = useLiveQuery(
    () => db.evidence.where('bugId').equals(bug.id).and((e) => e.kind === 'screenshot').first(),
    [bug.id],
  );
  const url = useBlobUrl(shot?.blob);
  const [title, setTitle] = useState(bug.title);
  const [description, setDescription] = useState(bug.description);

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/40 p-8" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg bg-white p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <span className="font-mono text-xs text-neutral-500">{bugLabel(bug.seq)}</span>
          <button onClick={onClose} className="text-sm text-neutral-500 hover:text-neutral-900">Close</button>
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => db.bugs.update(bug.id, { title: title.trim() })}
          placeholder="Title"
          className="mt-2 w-full border-b border-transparent text-lg font-semibold outline-none hover:border-neutral-200 focus:border-neutral-900"
        />
        <p className="mt-1 break-all text-xs text-neutral-500">{bug.url}</p>

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => db.bugs.update(bug.id, { description: description.trim() })}
          rows={4}
          placeholder="Description"
          className="mt-3 w-full resize-y rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />

        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt="Screenshot" className="mt-3 w-full rounded-md border border-neutral-200" />
          </a>
        )}
        {shot && <p className="mt-1 text-xs text-neutral-500">{shot.mimeType} · {fmtBytes(shot.size)}</p>}

        <VoiceNote bugId={bug.id} />

        <div className="mt-4 border-t border-neutral-200 pt-3">
          <GitHubAction bugId={bug.id} />
        </div>

        <pre className="mt-3 overflow-x-auto rounded-md bg-neutral-50 p-3 text-xs text-neutral-700">
          {`Captured:   ${fmtDate(bug.createdAt)}\nPage title: ${bug.pageTitle}\n${envBlock(bug)}`}
        </pre>
      </div>
    </div>
  );
}

/**
 * Voice note recorded with the bug. Audio only exists when dictation failed at capture
 * time, so offer a second attempt — exports and GitHub issues carry text, not sound.
 */
function VoiceNote({ bugId }: { bugId: string }) {
  const audio = useLiveQuery(
    () => db.evidence.where('bugId').equals(bugId).and((e) => e.kind === 'audio').first(),
    [bugId],
  );
  const url = useBlobUrl(audio?.blob);
  if (!url || !audio) return null;
  return (
    <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-xs font-medium text-neutral-700">Voice note</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        {fmtBytes(audio.size)} · not yet in the description, so exports and issues will not include it.
      </p>
      <audio src={url} controls className="mt-2 h-9 w-full" />
      <Transcribe bugId={bugId} audio={audio.blob} />
    </div>
  );
}

/** Console errors, failed requests and steps — the evidence a developer needs to reproduce. */
function EvidenceBlocks({ bug }: { bug: Bug }) {
  const errors = bug.console.filter((c) => c.level === 'error' || c.level === 'warn');
  const failed = bug.network.filter((n) => n.failed);
  if (!errors.length && !failed.length && !bug.steps.length) return null;

  return (
    <div className="mt-3 space-y-2 text-xs">
      {errors.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-neutral-600">Console ({errors.length})</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-neutral-50 p-2 text-neutral-700">
            {errors.map((c) => `[${c.level}] ${c.message}`).join('\n')}
          </pre>
        </details>
      )}
      {failed.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-neutral-600">Failed requests ({failed.length})</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-neutral-50 p-2 text-neutral-700">
            {failed.map((n) => `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.durationMs}ms)`).join('\n')}
          </pre>
        </details>
      )}
      {bug.steps.length > 0 && (
        <details>
          <summary className="cursor-pointer text-neutral-600">Steps ({bug.steps.length})</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-neutral-50 p-2 text-neutral-700">
            {bug.steps.slice(-20).map((s) => `${new Date(s.timestamp).toLocaleTimeString()} ${s.type}: ${s.detail}`).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

function DocumentView({ sessionId }: { sessionId: string }) {
  // Wrapped so a missing session is distinguishable from a pending query.
  const found = useLiveQuery(async () => ({ session: await db.sessions.get(sessionId) }), [sessionId]);
  const bugs = useBugs(sessionId);
  if (!found || !bugs) return <p className="text-sm text-neutral-500">Loading…</p>;
  const session = found.session;
  if (!session) return <p className="text-sm text-neutral-500">Session not found.</p>;

  return (
    <article className="mx-auto max-w-3xl rounded-xl border border-neutral-200 bg-white px-12 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Testing session — {session.name}</h1>
      <p className="mt-3 text-sm leading-relaxed text-neutral-500">
        <strong>Started:</strong> {fmtDate(session.startedAt)}<br />
        <strong>Ended:</strong> {session.endedAt ? fmtDate(session.endedAt) : 'In progress'}<br />
        <strong>Total Bugs:</strong> {bugs.length}
      </p>
      {bugs.length === 0 && <p className="mt-8 text-sm text-neutral-500">No bugs captured yet.</p>}
      {bugs.map((b) => <DocBug key={b.id} bug={b} />)}
    </article>
  );
}

function DocBug({ bug }: { bug: Bug }) {
  const shot = useLiveQuery(
    () => db.evidence.where('bugId').equals(bug.id).and((e) => e.kind === 'screenshot').first(),
    [bug.id],
  );
  const url = useBlobUrl(shot?.blob);
  return (
    <section className="mt-10 border-t border-neutral-200 pt-8">
      <h2 className="text-lg font-semibold tracking-tight">{bugLabel(bug.seq)} — {bug.title || 'Untitled'}</h2>
      <p className="mt-1 break-all text-xs text-neutral-500">
        {bug.url} · {STATUS_LABEL[bug.status]} · {fmtDate(bug.createdAt)}
      </p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
        {bug.description || <span className="text-neutral-400">No description</span>}
      </p>
      {url && <img src={url} alt="" className="mt-3 rounded-md border border-neutral-200" />}
      <VoiceNote bugId={bug.id} />
      <pre className="mt-3 overflow-x-auto rounded-md bg-neutral-50 p-3 text-xs text-neutral-600">{envBlock(bug)}</pre>
      <EvidenceBlocks bug={bug} />
    </section>
  );
}
