import Dexie, { type EntityTable } from 'dexie';

export type BugStatus = 'open' | 'in_progress' | 'fixed' | 'closed' | 'ignored';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ConsoleEntry {
  timestamp: number;
  level: 'error' | 'warn' | 'info' | 'log';
  message: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status: number;      // 0 when the request failed outright
  durationMs: number;
  failed: boolean;
}

export interface StepEntry {
  timestamp: number;
  type: 'navigate' | 'click' | 'input' | 'keydown';
  detail: string;
}

export interface Session {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
}

/** Bug metadata only. Screenshots/video/audio live in `evidence` as Blobs. */
export interface Bug {
  id: string;
  sessionId: string;
  seq: number;
  title: string;
  description: string;
  status: BugStatus;
  severity: Severity;
  tags: string[];
  createdAt: number;
  url: string;
  pageTitle: string;
  context: {
    userAgent: string;
    platform: string;
    screen: { width: number; height: number };
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    language: string;
    online: boolean;
  };
  /** Evidence collected by the session recorder, trimmed to what preceded the bug. */
  console: ConsoleEntry[];
  network: NetworkEntry[];
  steps: StepEntry[];
  /** Set once filed to GitHub, so a second push does not duplicate the issue. */
  issue?: { number: number; url: string; filedAt: number };
}

export type EvidenceKind = 'screenshot' | 'video' | 'audio';

export interface Evidence {
  id: string;
  bugId: string;
  sessionId: string;
  kind: EvidenceKind;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

/** A capture in flight, parked so the popup can hand it (blobs included) to the editor. */
export interface PendingCapture {
  id: string;
  sessionId: string;
  createdAt: number;
  screenshot: Blob | undefined;
  url: string;
  pageTitle: string;
  context: Bug['context'];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  steps: StepEntry[];
}

export const db = new Dexie('session-bug-reporter') as Dexie & {
  sessions: EntityTable<Session, 'id'>;
  bugs: EntityTable<Bug, 'id'>;
  evidence: EntityTable<Evidence, 'id'>;
  pending: EntityTable<PendingCapture, 'id'>;
};

db.version(1).stores({
  sessions: 'id, startedAt, endedAt',
  bugs: 'id, sessionId, createdAt, status, [sessionId+seq]',
  evidence: 'id, bugId, sessionId, kind',
  pending: 'id, createdAt',
});

/** Open failures (version conflicts, blocked upgrades, private-mode quirks) must surface.
 *  Without this the promise stays pending and every useLiveQuery renders "Loading…" forever. */
export let dbError: string | null = null;
// Guarded so importing the exporters in Node (tests, scripts) doesn't try to open IndexedDB.
if (typeof indexedDB !== 'undefined')
  db.open().catch((e: unknown) => {
    dbError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('[bug-reporter] IndexedDB open failed:', e);
  });

export const uid = () => crypto.randomUUID();

export async function parkCapture(c: Omit<PendingCapture, 'id' | 'createdAt'>): Promise<string> {
  const id = uid();
  await db.pending.put({ ...c, id, createdAt: Date.now() });
  // Drop anything abandoned over an hour ago so screenshot blobs don't accumulate.
  await db.pending.where('createdAt').below(Date.now() - 3_600_000).delete();
  return id;
}

export const takeCapture = (id: string) => db.pending.get(id);
export const dropCapture = (id: string) => db.pending.delete(id);
export const bugLabel = (seq: number) => `BUG-${String(seq).padStart(3, '0')}`;

export async function startSession(name: string): Promise<Session> {
  const session: Session = { id: uid(), name: name.trim() || 'Untitled Session', startedAt: Date.now(), endedAt: null };
  await db.transaction('rw', db.sessions, async () => {
    // Only one session active at a time: close any others.
    const open = await db.sessions.filter((s) => s.endedAt === null).toArray();
    await Promise.all(open.map((s) => db.sessions.update(s.id, { endedAt: Date.now() })));
    await db.sessions.add(session);
  });
  return session;
}

export const activeSession = () => db.sessions.filter((s) => s.endedAt === null).first();

export const finishSession = (id: string) => db.sessions.update(id, { endedAt: Date.now() });

/**
 * Reopens a finished session so more bugs can be added to it. Only one session may be
 * active, so any other open session is closed first — the same rule startSession follows.
 */
export async function resumeSession(id: string): Promise<void> {
  await db.transaction('rw', db.sessions, async () => {
    const open = await db.sessions.filter((s) => s.endedAt === null && s.id !== id).toArray();
    await Promise.all(open.map((s) => db.sessions.update(s.id, { endedAt: Date.now() })));
    await db.sessions.update(id, { endedAt: null });
  });
}

export async function deleteSession(id: string) {
  await db.transaction('rw', db.sessions, db.bugs, db.evidence, async () => {
    await db.evidence.where('sessionId').equals(id).delete();
    await db.bugs.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

export async function deleteBug(id: string) {
  await db.transaction('rw', db.bugs, db.evidence, async () => {
    await db.evidence.where('bugId').equals(id).delete();
    await db.bugs.delete(id);
  });
}

/** Saves a bug and its evidence atomically. seq is allocated inside the txn so it never collides. */
export async function saveBug(
  input: Omit<Bug, 'id' | 'seq' | 'createdAt'>,
  screenshot?: Blob,
  audio?: Blob,
): Promise<Bug> {
  return db.transaction('rw', db.bugs, db.evidence, async () => {
    const seq = (await db.bugs.where('sessionId').equals(input.sessionId).count()) + 1;
    const bug: Bug = { ...input, id: uid(), seq, createdAt: Date.now() };
    await db.bugs.add(bug);

    const attach = (kind: EvidenceKind, blob: Blob, fallbackType: string) =>
      db.evidence.add({
        id: uid(),
        bugId: bug.id,
        sessionId: bug.sessionId,
        kind,
        mimeType: blob.type || fallbackType,
        size: blob.size,
        blob,
        createdAt: Date.now(),
      });

    if (screenshot) await attach('screenshot', screenshot, 'image/webp');
    if (audio) await attach('audio', audio, 'audio/webm');
    return bug;
  });
}
