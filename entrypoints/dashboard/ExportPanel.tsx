import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, bugLabel } from '@/lib/db';
import {
  loadBundle, toJSON, toMarkdown, toCSV, toHTML, blobToDataUrl, download, slug,
} from '@/lib/export';
import { Button, fmtBytes, SectionTitle } from '@/components/ui';

type Format = 'docx' | 'csv' | 'json' | 'markdown' | 'html';

const FORMATS: { id: Format; label: string; hint: string; group: string }[] = [
  { id: 'docx', label: 'Word document (.docx)', group: 'Document', hint: 'The session report with screenshots embedded. Opens in Word or Google Docs.' },
  { id: 'html', label: 'HTML', group: 'Document', hint: 'Single self-contained page. Screenshots embedded.' },
  { id: 'markdown', label: 'Markdown', group: 'Document', hint: 'Report as .md, plus one .webp per screenshot.' },
  { id: 'csv', label: 'CSV', group: 'Sheet', hint: 'The bug table for Excel or Google Sheets.' },
  { id: 'json', label: 'JSON', group: 'Data', hint: 'Structured data with inlined screenshots. For scripts and automation.' },
];

export default function ExportPanel({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState<Format | null>(null);

  const usage = useLiveQuery(async () => {
    const ev = await db.evidence.where('sessionId').equals(sessionId).toArray();
    return { count: ev.length, bytes: ev.reduce((n, e) => n + e.size, 0) };
  }, [sessionId]);

  async function run(format: Format) {
    setBusy(format);
    try {
      const b = await loadBundle(sessionId);
      const base = slug(b.session.name);

      if (format === 'docx') {
        // Lazy — the docx builder is large and most exports never need it.
        const { toDOCX } = await import('@/lib/docx');
        download(await toDOCX(b), `${base}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } else if (format === 'json') {
        // Inline screenshots as data URLs so the single JSON file is self-contained.
        const urls = new Map<string, string>();
        for (const [bugId, blob] of b.screenshots) urls.set(bugId, await blobToDataUrl(blob));
        download(toJSON(b, urls), `${base}.json`, 'application/json');
      } else if (format === 'markdown') {
        download(toMarkdown(b), `${base}.md`, 'text/markdown');
        // Markdown references images by filename, so ship the images alongside it.
        for (const bug of b.bugs) {
          const blob = b.screenshots.get(bug.id);
          if (blob) download(blob, `${bugLabel(bug.seq)}.webp`, blob.type);
        }
      } else if (format === 'html') {
        download(await toHTML(b), `${base}.html`, 'text/html');
      } else if (format === 'csv') {
        download(toCSV(b), `${base}.csv`, 'text/csv');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-sm font-semibold tracking-tight">Export session</h2>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        Nothing leaves your machine — exports are generated locally and saved to your downloads folder.
      </p>

      {['Document', 'Sheet', 'Data'].map((group) => (
        <section key={group} className="mt-4">
          <SectionTitle>{group}</SectionTitle>
          <ul className="mt-2 space-y-2">
            {FORMATS.filter((f) => f.group === group).map((f) => (
              <li key={f.id} className="flex items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{f.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{f.hint}</p>
                </div>
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => run(f.id)}>
                  {busy === f.id ? 'Exporting…' : 'Export'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {usage && (
        <p className="mt-4 text-xs text-neutral-500">
          Evidence stored for this session: {usage.count} file{usage.count === 1 ? '' : 's'} · {fmtBytes(usage.bytes)}
        </p>
      )}
    </div>
  );
}
