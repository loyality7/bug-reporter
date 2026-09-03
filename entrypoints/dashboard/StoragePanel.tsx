import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteSession, type Session } from '@/lib/db';
import { Button, fmtBytes, fmtDate, SectionTitle } from '@/components/ui';

/** Where the space went, and how to get it back. Evidence blobs dominate; metadata is noise. */
export default function StoragePanel({ onDeleted }: { onDeleted?: (id: string) => void }) {
  const rows = useLiveQuery(async () => {
    const sessions = await db.sessions.orderBy('startedAt').reverse().toArray();
    return Promise.all(
      sessions.map(async (session) => {
        const evidence = await db.evidence.where('sessionId').equals(session.id).toArray();
        return {
          session,
          bugs: await db.bugs.where('sessionId').equals(session.id).count(),
          files: evidence.length,
          bytes: evidence.reduce((n, e) => n + e.size, 0),
        };
      }),
    );
  }, []);

  const quota = useLiveQuery(async () => {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  }, []);

  if (!rows) return <p className="text-sm text-neutral-500">Loading…</p>;

  const total = rows.reduce((n, r) => n + r.bytes, 0);

  async function remove(session: Session) {
    if (!confirm(`Delete "${session.name}" and all its bugs and evidence? This cannot be undone.`)) return;
    await deleteSession(session.id);
    onDeleted?.(session.id);
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-sm font-semibold tracking-tight">Storage</h2>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        Everything is stored in this browser. Screenshots and voice notes take almost all of the
        space — delete sessions you have already exported.
      </p>

      {quota && quota.quota > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium text-neutral-700">{fmtBytes(total)} in sessions</span>
            <span className="text-neutral-500">
              {fmtBytes(quota.usage)} of {fmtBytes(quota.quota)} available used
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-neutral-900"
              style={{ width: `${Math.min(100, (quota.usage / quota.quota) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <section className="mt-6">
        <SectionTitle>Sessions</SectionTitle>
        <ul className="mt-2 space-y-2">
          {rows.map(({ session, bugs, files, bytes }) => (
            <li
              key={session.id}
              className="flex items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{session.name}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {fmtDate(session.startedAt)} · {bugs} bug{bugs === 1 ? '' : 's'} · {files} file
                  {files === 1 ? '' : 's'}
                </p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-neutral-600">{fmtBytes(bytes)}</span>
              <Button variant="danger" size="sm" onClick={() => remove(session)}>Delete</Button>
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-neutral-500">No sessions stored.</li>}
        </ul>
      </section>
    </div>
  );
}
