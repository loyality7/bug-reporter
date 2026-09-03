import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, dbError, startSession, finishSession, type Session } from '@/lib/db';
import type { CaptureArea, CaptureMode } from '@/lib/startCapture';
import { Crop, Monitor, ScrollText, LayoutGrid, CircleCheck } from 'lucide-react';
import { Button, Input, fmtTime } from '@/components/ui';

const AREAS: { id: CaptureArea; label: string; hint: string; Icon: typeof Crop }[] = [
  { id: 'region', label: 'Area', hint: 'Drag to select part of the page', Icon: Crop },
  { id: 'visible', label: 'Visible', hint: 'What is on screen right now', Icon: Monitor },
  { id: 'fullpage', label: 'Full page', hint: 'Scrolls and stitches the whole page', Icon: ScrollText },
];

const openDashboard = (sessionId?: string) => {
  const q = sessionId ? `?session=${sessionId}` : '';
  browser.tabs.create({ url: browser.runtime.getURL(`/dashboard.html${q}`) });
};

export default function App() {
  // useLiveQuery uses `undefined` for "still loading", and Dexie's first() also returns
  // undefined when nothing matches. Wrapping in an object keeps the two distinguishable.
  const active = useLiveQuery(
    async () => ({ session: await db.sessions.filter((s) => s.endedAt === null).first() }),
    [],
  );
  const recent = useLiveQuery(() => db.sessions.orderBy('startedAt').reverse().limit(5).toArray(), []);

  if (active === undefined)
    return (
      <div className="w-[380px] p-6 text-sm">
        {dbError ? (
          <p className="text-red-600">Storage unavailable — {dbError}</p>
        ) : (
          <p className="text-neutral-500">Loading…</p>
        )}
      </div>
    );

  return (
    <div className="w-[380px] bg-white text-neutral-900 antialiased">
      {active.session ? <ActiveSession session={active.session} /> : <Home recent={recent ?? []} />}
    </div>
  );
}

function Home({ recent }: { recent: Session[] }) {
  const [name, setName] = useState('');
  const counts = useLiveQuery(async () => {
    const entries = await Promise.all(
      recent.map(async (s) => [s.id, await db.bugs.where('sessionId').equals(s.id).count()] as const),
    );
    return Object.fromEntries(entries);
  }, [recent]) ?? {};

  return (
    <div className="p-4">
      <h1 className="text-[15px] font-semibold tracking-tight">Session Bug Reporter</h1>
      <p className="mt-1 text-xs text-neutral-500">Everything stays local in your browser.</p>

      <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); startSession(name); setName(''); }}>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session name, e.g. Website QA"
        />
        <Button type="submit" className="w-full">Start new session</Button>
      </form>

      {recent.length > 0 && (
        <div className="mt-5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Recent sessions</h2>
          <ul className="mt-2 space-y-1">
            {recent.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => openDashboard(s.id)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-neutral-100"
                >
                  <span className="truncate">{s.name}</span>
                  <span className="ml-2 shrink-0 text-xs tabular-nums text-neutral-500">{counts[s.id] ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActiveSession({ session }: { session: Session }) {
  const count = useLiveQuery(() => db.bugs.where('sessionId').equals(session.id).count(), [session.id]) ?? 0;
  const [area, setArea] = useState<CaptureArea>('region');
  const [busy, setBusy] = useState<CaptureMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(mode: CaptureMode) {
    setBusy(mode);
    setError(null);
    // The keyboard shortcut repeats this choice, so persist it before capturing.
    await browser.storage.local.set({ lastCapture: { mode, area } });
    // Region select requires clicking into the page, which closes this popup. Hand the
    // whole capture to the background worker so it survives that, then close immediately.
    if (area === 'region') {
      browser.runtime.sendMessage({ type: 'start-capture', sessionId: session.id, mode, area });
      window.close();
      return;
    }
    const res = await browser.runtime.sendMessage({ type: 'start-capture', sessionId: session.id, mode, area });
    setBusy(null);
    if (res?.problem) setError(res.problem);
    else window.close();
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-emerald-700">Recording session</span>
      </div>
      <h1 className="mt-1.5 truncate text-[15px] font-semibold tracking-tight">{session.name}</h1>
      <p className="mt-0.5 text-xs text-neutral-500">
        Started {fmtTime(session.startedAt)} · {count} bug{count === 1 ? '' : 's'} captured
      </p>

      <div className="mt-4 flex gap-1 rounded-lg bg-neutral-100 p-1">
        {AREAS.map(({ id, label, hint, Icon }) => (
          <button
            key={id}
            onClick={() => setArea(id)}
            title={hint}
            aria-pressed={area === id}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
              area === id ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <Icon size={13} strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        <button
          onClick={() => go('quick')}
          disabled={busy !== null}
          className="w-full rounded-lg bg-neutral-900 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800 disabled:opacity-40"
        >
          <span className="block text-sm font-medium text-white">
            {busy === 'quick' ? 'Capturing…' : 'Quick capture'}
          </span>
          <span className="mt-0.5 block text-[11px] text-neutral-400">Point, describe, log in seconds</span>
        </button>

        <button
          onClick={() => go('editor')}
          disabled={busy !== null}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50 disabled:opacity-40"
        >
          <span className="block text-sm font-medium text-neutral-900">
            {busy === 'editor' ? 'Capturing…' : 'Detailed capture'}
          </span>
          <span className="mt-0.5 block text-[11px] text-neutral-500">Full editor with console, network and steps</span>
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <p className="mt-3 text-center text-[11px] text-neutral-400">
        Press <kbd className="rounded border border-neutral-300 px-1 font-sans">
          {navigator.platform.startsWith('Mac') ? '⌘⇧K' : 'Ctrl+Shift+K'}
        </kbd> to repeat this capture
      </p>

      <div className="mt-3 flex gap-2 border-t border-neutral-200 pt-3">
        <Button variant="ghost" size="sm" className="flex-1" onClick={() => openDashboard(session.id)}>
          <LayoutGrid size={13} strokeWidth={2} />
          View session
        </Button>
        <Button variant="ghost" size="sm" className="flex-1" onClick={() => finishSession(session.id)}>
          <CircleCheck size={13} strokeWidth={2} />
          Finish
        </Button>
      </div>
    </div>
  );
}
