import { useEffect, useState } from 'react';
import {
  takeCapture, dropCapture, saveBug, type PendingCapture, type Severity, type BugStatus,
} from '@/lib/db';
import { Mic, Square, Info, Terminal, Network, Footprints } from 'lucide-react';
import Annotator from '@/components/Annotator';
import { Select, SEVERITY_TONE } from '@/components/Select';
import { useVoice, fmtDuration } from '@/components/useVoice';
import SpeechBlockedNotice from '@/components/SpeechBlockedNotice';
import { fileBugIfEnabled } from '@/components/GitHubAction';
import { fmtDate } from '@/components/ui';

type Tab = 'info' | 'console' | 'network' | 'steps';

const TABS: { id: Tab; label: string; Icon: typeof Info }[] = [
  { id: 'info', label: 'Info', Icon: Info },
  { id: 'console', label: 'Console', Icon: Terminal },
  { id: 'network', label: 'Network', Icon: Network },
  { id: 'steps', label: 'Steps', Icon: Footprints },
];

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const STATUSES: BugStatus[] = ['open', 'in_progress', 'fixed', 'closed', 'ignored'];

const post = (action: string, issue?: { number: number; url: string } | null) =>
  window.parent.postMessage({ __bugreporter: 'editor', action, issue }, '*');
const close = () => post('close');

export default function Editor() {
  const captureId = new URLSearchParams(location.search).get('capture');
  const [capture, setCapture] = useState<PendingCapture | null | undefined>(undefined);
  const [shot, setShot] = useState<Blob>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [status, setStatus] = useState<BugStatus>('open');
  const [tags, setTags] = useState('');
  const [tab, setTab] = useState<Tab>('info');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const voice = useVoice((text) => setDescription((d) => (d ? `${d} ${text}` : text)));

  useEffect(() => {
    if (!captureId) return setCapture(null);
    takeCapture(captureId).then((c) => {
      setCapture(c ?? null);
      setShot(c?.screenshot);
    });
  }, [captureId]);

  // Escape closes the overlay, like any modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') discard(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  async function discard() {
    if (captureId) await dropCapture(captureId);
    close();
  }

  async function save() {
    if (!capture || saving) return;
    setSaving(true);
    try {
      const bug = await saveBug(
        {
          sessionId: capture.sessionId,
          title: title.trim(),
          description: description.trim(),
          status,
          severity,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          url: capture.url,
          pageTitle: capture.pageTitle,
          context: capture.context,
          console: capture.console,
          network: capture.network,
          steps: capture.steps,
        },
        shot,
        voice.audio,
      );
      await dropCapture(capture.id);
      // Only files an issue when the user has switched that on; otherwise a no-op.
      const filed = await fileBugIfEnabled(bug.id);
      post('saved', filed);
    } catch (err) {
      setSaveError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (capture === undefined)
    return <Shell><p className="p-8 text-sm text-neutral-400">Loading capture…</p></Shell>;
  if (capture === null)
    return (
      <Shell>
        <div className="p-8">
          <p className="text-sm text-neutral-300">This capture has expired.</p>
          <button onClick={close} className="mt-3 rounded-md bg-neutral-700 px-3 py-2 text-sm text-white">Close</button>
        </div>
      </Shell>
    );

  const counts = {
    console: capture.console.filter((c) => c.level === 'error' || c.level === 'warn').length,
    network: capture.network.filter((n) => n.failed).length,
  };

  return (
    <Shell>
      <header className="flex shrink-0 items-center gap-4 border-b border-neutral-800 px-6 py-3">
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold tracking-tight text-neutral-100">New bug report</h1>
          <p className="truncate text-[11px] text-neutral-500">{capture.url}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={discard}
            className="h-9 rounded-md px-3 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            Discard
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="h-9 rounded-md bg-neutral-100 px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save bug'}
          </button>
          {saveError && <span className="self-center text-xs text-red-400">{saveError}</span>}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden px-6 pb-6 pt-5">
        {/* Left: annotatable screenshot + evidence tabs */}
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <div>
            {shot ? (
              <Annotator source={shot} dark onCancel={() => {}} onSave={setShot} inline />
            ) : (
              <p className="p-6 text-center text-sm text-neutral-500">No screenshot captured.</p>
            )}
          </div>

          <div>
            <nav className="flex gap-4 border-b border-neutral-800">
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 text-xs transition-colors ${
                    tab === id
                      ? 'border-neutral-100 font-medium text-neutral-100'
                      : 'border-transparent text-neutral-500 hover:text-neutral-200'
                  }`}
                >
                  <Icon size={13} strokeWidth={2} />
                  {label}
                  {id === 'console' && counts.console > 0 && <Badge n={counts.console} />}
                  {id === 'network' && counts.network > 0 && <Badge n={counts.network} />}
                </button>
              ))}
            </nav>
            <div className="max-h-72 overflow-y-auto py-4 text-xs">
              {tab === 'info' && <InfoTab capture={capture} />}
              {tab === 'console' && <ConsoleTab entries={capture.console} />}
              {tab === 'network' && <NetworkTab entries={capture.network} />}
              {tab === 'steps' && <StepsTab entries={capture.steps} />}
            </div>
          </div>
        </div>

        {/* Right: summary and details */}
        <aside className="flex w-[340px] shrink-0 flex-col gap-7 overflow-y-auto border-l border-neutral-800/70 pl-6">
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Summary</h2>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bug title"
              className="mt-3 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}
              rows={7}
              placeholder="What went wrong? Steps to reproduce?"
              className="mt-2 w-full resize-none rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm leading-relaxed text-neutral-100 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
            />

            {voice.supported && (
              <div className="mt-2">
                <button
                  onClick={voice.active ? voice.stop : voice.start}
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors ${
                    voice.active
                      ? 'border-red-500/60 bg-red-500/10 text-red-400'
                      : 'border-neutral-700 bg-neutral-950 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  {voice.active ? (
                    <>
                      <Square size={12} strokeWidth={2.5} fill="currentColor" />
                      Stop · {fmtDuration(voice.seconds)}
                      {voice.gotText && <span className="text-neutral-500">transcribing</span>}
                    </>
                  ) : (
                    <>
                      <Mic size={13} strokeWidth={2} />
                      Dictate description
                    </>
                  )}
                </button>
                {voice.audio && !voice.active && <VoicePlayback voice={voice} />}
                {voice.error && <p className="mt-1 text-[11px] text-amber-400">{voice.error}</p>}
                {voice.blocked && <SpeechBlockedNotice blocked={voice.blocked} dark />}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Details</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Select dark drop="down" ariaLabel="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
              <Select dark drop="down" ariaLabel="Severity" value={severity} options={SEVERITY_OPTIONS} onChange={setSeverity} />
            </div>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Tags, comma separated"
              className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
            />
          </section>
        </aside>
      </div>
    </Shell>
  );
}

function VoicePlayback({ voice }: { voice: ReturnType<typeof useVoice> }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!voice.audio) return setUrl(undefined);
    const u = URL.createObjectURL(voice.audio);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [voice.audio]);

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-neutral-900 p-1.5">
      <audio src={url} controls className="h-8 flex-1" />
      <button
        onClick={voice.discardAudio}
        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
      >
        Remove
      </button>
    </div>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200 antialiased dark-scroll">{children}</div>
);

const Badge = ({ n }: { n: number }) => (
  <span className="rounded-full bg-red-500/15 px-1.5 py-px text-[10px] font-medium tabular-nums text-red-400">{n}</span>
);

const label = (v: string) => {
  const words = v.replace('_', ' ');
  return words[0]!.toUpperCase() + words.slice(1);
};

const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: label(s) }));
const SEVERITY_OPTIONS = SEVERITIES.map((s) => ({ value: s, label: label(s), tone: SEVERITY_TONE[s] }));

const Empty = ({ what }: { what: string }) => (
  <p className="py-8 text-center text-neutral-500">No {what} recorded on this page.</p>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-4 border-b border-neutral-800/60 py-2 last:border-0">
    <span className="w-28 shrink-0 text-neutral-500">{label}</span>
    <span className="min-w-0 break-all text-neutral-200">{value}</span>
  </div>
);

function InfoTab({ capture }: { capture: PendingCapture }) {
  const c = capture.context;
  return (
    <div>
      <Row label="URL" value={capture.url} />
      <Row label="Page title" value={capture.pageTitle} />
      <Row label="Timestamp" value={fmtDate(capture.createdAt)} />
      <Row label="Platform" value={c.platform} />
      <Row label="Language" value={c.language} />
      <Row label="Network" value={c.online ? 'Online' : 'Offline'} />
      <Row label="Screen" value={`${c.screen.width} × ${c.screen.height}`} />
      <Row label="Viewport" value={`${c.viewport.width} × ${c.viewport.height} @${c.devicePixelRatio}x`} />
      <Row label="User agent" value={c.userAgent} />
    </div>
  );
}

const LEVEL_COLOR = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-sky-400', log: 'text-neutral-400' };

function ConsoleTab({ entries }: { entries: PendingCapture['console'] }) {
  const [level, setLevel] = useState<'all' | 'error' | 'warn' | 'info' | 'log'>('all');
  const [q, setQ] = useState('');
  if (entries.length === 0) return <Empty what="console output" />;

  const shown = entries.filter(
    (e) => (level === 'all' || e.level === level) && (!q || e.message.toLowerCase().includes(q.toLowerCase())),
  );
  const count = (l: string) => entries.filter((e) => e.level === l).length;

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {(['all', 'error', 'warn', 'info', 'log'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={`rounded-full px-2.5 py-1 text-[11px] capitalize transition-colors ${
              level === l ? 'bg-neutral-100 font-medium text-neutral-900' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
            }`}
          >
            {l}{l !== 'all' && count(l) > 0 ? ` ${count(l)}` : ''}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="ml-auto w-44 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
        />
      </div>
      {shown.length === 0 ? (
        <p className="py-3 text-center text-neutral-500">No matching entries.</p>
      ) : (
        <ConsoleList entries={shown} />
      )}
    </>
  );
}

function ConsoleList({ entries }: { entries: PendingCapture['console'] }) {
  return (
    <ul className="space-y-1 font-mono">
      {entries.map((e, i) => (
        <li key={i} className="flex gap-2 border-b border-neutral-800/60 py-1 last:border-0">
          <span className="shrink-0 text-neutral-600">{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className={`shrink-0 uppercase ${LEVEL_COLOR[e.level]}`}>{e.level}</span>
          <span className="min-w-0 break-all whitespace-pre-wrap text-neutral-300">{e.message}</span>
        </li>
      ))}
    </ul>
  );
}

function NetworkTab({ entries }: { entries: PendingCapture['network'] }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [q, setQ] = useState('');
  if (entries.length === 0) return <Empty what="network activity" />;

  const shown = entries.filter(
    (e) => (!failedOnly || e.failed) && (!q || e.url.toLowerCase().includes(q.toLowerCase())),
  );
  const failures = entries.filter((e) => e.failed).length;

  return (
    <>
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => setFailedOnly(false)}
          className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${!failedOnly ? 'bg-neutral-100 font-medium text-neutral-900' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'}`}
        >
          All {entries.length}
        </button>
        <button
          onClick={() => setFailedOnly(true)}
          className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${failedOnly ? 'bg-neutral-100 font-medium text-neutral-900' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'}`}
        >
          Failed {failures}
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="ml-auto w-44 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
        />
      </div>
      {shown.length === 0 ? <p className="py-3 text-center text-neutral-500">No matching requests.</p> : <NetworkList entries={shown} />}
    </>
  );
}

function NetworkList({ entries }: { entries: PendingCapture['network'] }) {
  return (
    <ul className="space-y-1 font-mono">
      {entries.map((e, i) => (
        <li key={i} className="flex gap-2 border-b border-neutral-800/60 py-1 last:border-0">
          <span className="shrink-0 text-neutral-500">{e.method}</span>
          <span className={`w-10 shrink-0 ${e.failed ? 'text-red-400' : 'text-emerald-400'}`}>{e.status || 'ERR'}</span>
          <span className="min-w-0 flex-1 truncate text-neutral-300">{e.url}</span>
          <span className="shrink-0 text-neutral-500">{e.durationMs}ms</span>
        </li>
      ))}
    </ul>
  );
}

function StepsTab({ entries }: { entries: PendingCapture['steps'] }) {
  if (entries.length === 0) return <Empty what="steps" />;
  return (
    <ul className="space-y-1">
      {entries.map((e, i) => (
        <li key={i} className="flex gap-2 border-b border-neutral-800/60 py-1 last:border-0">
          <span className="shrink-0 text-neutral-600">{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className="w-16 shrink-0 text-neutral-500">{e.type}</span>
          <span className="min-w-0 break-all text-neutral-300">{e.detail}</span>
        </li>
      ))}
    </ul>
  );
}
