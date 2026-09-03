import { useEffect, useRef, useState } from 'react';
import { takeCapture, dropCapture, saveBug, type PendingCapture, type Severity } from '@/lib/db';
import { Mic, Square, X, Maximize2, AlertCircle } from 'lucide-react';
import Annotator from '@/components/Annotator';
import { Select, SEVERITY_TONE } from '@/components/Select';
import { useVoice, fmtDuration } from '@/components/useVoice';
import SpeechBlockedNotice from '@/components/SpeechBlockedNotice';
import { fileBugIfEnabled } from '@/components/GitHubAction';

/**
 * Quick capture: a small card pinned over the page. Point with the pencil, say or type
 * what broke, log it. Escalates to the detailed editor without losing what was typed.
 */
const SEVERITY_OPTIONS = (['low', 'medium', 'high', 'critical'] as Severity[]).map((s) => ({
  value: s,
  label: s[0]!.toUpperCase() + s.slice(1),
  tone: SEVERITY_TONE[s],
}));

const post = (msg: object) => window.parent.postMessage({ __bugreporter: 'quick', ...msg }, '*');

export default function Quick() {
  const captureId = new URLSearchParams(location.search).get('capture');
  const [capture, setCapture] = useState<PendingCapture | null | undefined>(undefined);
  const [shot, setShot] = useState<Blob>();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const voice = useVoice((text) => setTitle((t) => (t ? `${t} ${text}` : text)));

  useEffect(() => {
    if (!captureId) return setCapture(null);
    takeCapture(captureId).then((c) => { setCapture(c ?? null); setShot(c?.screenshot); });
  }, [captureId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') discard(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  async function discard() {
    if (captureId) await dropCapture(captureId);
    post({ action: 'close' });
  }

  /** Hand the annotated shot and typed title to the full editor. */
  async function expand() {
    if (!capture) return;
    const { db } = await import('@/lib/db');
    await db.pending.update(capture.id, { screenshot: shot });
    post({ action: 'expand', captureId: capture.id, title, severity });
  }

  async function save() {
    if (!capture || saving) return;
    setSaving(true);
    try {
      const bug = await saveBug(
        {
          sessionId: capture.sessionId,
          title: title.trim(),
          description: '',
          status: 'open',
          severity,
          tags: [],
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
      post({ action: 'saved', issue: filed });
    } catch (e) {
      // Never close on failure — the user would lose the capture without knowing why.
      setSaveError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (capture === undefined) return <Card><p className="text-sm text-neutral-400">Loading…</p></Card>;
  if (capture === null)
    return (
      <Card>
        <p className="text-sm text-neutral-300">This capture has expired.</p>
        <button onClick={() => post({ action: 'close' })} className="mt-2 text-xs text-neutral-400 underline">Close</button>
      </Card>
    );

  const problems =
    capture.console.filter((c) => c.level === 'error').length + capture.network.filter((n) => n.failed).length;

  return (
    <Card>
      <header className="flex items-center gap-2 px-1">
        <h1 className="text-[13px] font-semibold tracking-tight text-neutral-100">Quick capture</h1>
        {problems > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
            <AlertCircle size={11} strokeWidth={2.5} />
            {problems} issue{problems === 1 ? '' : 's'} detected
          </span>
        )}
        <button
          onClick={discard}
          aria-label="Discard capture"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </header>

      {shot && (
        <div className="mt-3">
          <Annotator source={shot} dark inline compact onCancel={() => {}} onSave={setShot} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) save(); }}
          placeholder="What broke?"
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none transition-colors focus:border-neutral-500"
        />
        {voice.supported && (
          <button
            onClick={voice.active ? voice.stop : voice.start}
            title={voice.active ? 'Stop' : 'Dictate what broke'}
            aria-label={voice.active ? 'Stop dictation' : 'Dictate the description'}
            className={`grid w-10 shrink-0 place-items-center rounded-md border transition-colors ${
              voice.active
                ? 'border-red-500/60 bg-red-500/15 text-red-400'
                : 'border-neutral-700 bg-neutral-950 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
            }`}
          >
            {voice.active ? <Square size={14} strokeWidth={2.5} fill="currentColor" /> : <Mic size={15} strokeWidth={2} />}
          </button>
        )}
      </div>

      {voice.active && (
        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-[11px] text-red-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          Listening {fmtDuration(voice.seconds)}
          {voice.gotText && <span className="text-neutral-500">· transcribing</span>}
        </p>
      )}
      {voice.audio && !voice.active && <AudioNote voice={voice} />}
      {voice.error && <p className="mt-1.5 px-1 text-[11px] text-amber-400">{voice.error}</p>}
      {voice.blocked && <SpeechBlockedNotice blocked={voice.blocked} dark />}
      {saveError && <p className="mt-1.5 px-1 text-[11px] text-red-400">Could not save — {saveError}</p>}

      <footer className="mt-3 flex items-center gap-2 border-t border-neutral-800 pt-3">
        <Select
          dark
          ariaLabel="Severity"
          className="w-32"
          value={severity}
          options={SEVERITY_OPTIONS}
          onChange={setSeverity}
        />
        <button
          onClick={expand}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
        >
          <Maximize2 size={13} strokeWidth={2} />
          Details
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="ml-auto h-9 rounded-md bg-neutral-100 px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-40"
        >
          {saving ? 'Logging…' : 'Log bug'}
        </button>
      </footer>
    </Card>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="dark-scroll h-screen w-screen overflow-y-auto bg-neutral-900 p-3 text-neutral-200">{children}</div>
);

/** Lets the user hear the note back and re-record before logging. */
function AudioNote({ voice }: { voice: ReturnType<typeof useVoice> }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!voice.audio) return setUrl(undefined);
    const u = URL.createObjectURL(voice.audio);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [voice.audio]);

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-neutral-800/60 p-1.5">
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
