import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType,
} from 'docx';
import { bugLabel, type Bug } from './db';
import { VOICE_NOTE_TEXT, type SessionBundle } from './export';

/**
 * Session report as a Word document — screenshots embedded inline, so it opens in
 * Word or Google Docs with everything in one file.
 */
const GRAY = '6B7280';
const RED = 'DC2626';

const ts = (ms: number) => new Date(ms).toLocaleString();

const label = (text: string) => new TextRun({ text, bold: true });
const muted = (text: string) => new TextRun({ text, color: GRAY, size: 18 });

/**
 * Word needs real PNG bytes and pixel dimensions up front. Screenshots are stored as
 * WebP, which Word will not render, so re-encode through a canvas on the way in.
 */
async function imageFor(blob: Blob, maxWidth = 600) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: 'image/png' });

  return { data: await png.arrayBuffer(), width, height };
}

function evidenceParagraphs(bug: Bug): Paragraph[] {
  const out: Paragraph[] = [];

  const errors = bug.console.filter((c) => c.level === 'error' || c.level === 'warn');
  if (errors.length) {
    out.push(new Paragraph({ children: [label('Console')], spacing: { before: 200, after: 60 } }));
    for (const c of errors)
      out.push(
        new Paragraph({
          children: [new TextRun({ text: `[${c.level}] ${c.message}`, font: 'Consolas', size: 18, color: c.level === 'error' ? RED : GRAY })],
        }),
      );
  }

  const failed = bug.network.filter((n) => n.failed);
  if (failed.length) {
    out.push(new Paragraph({ children: [label('Failed requests')], spacing: { before: 200, after: 60 } }));
    for (const n of failed)
      out.push(
        new Paragraph({
          children: [new TextRun({ text: `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.durationMs}ms)`, font: 'Consolas', size: 18, color: RED })],
        }),
      );
  }

  if (bug.steps.length) {
    out.push(new Paragraph({ children: [label('Steps before the bug')], spacing: { before: 200, after: 60 } }));
    for (const s of bug.steps.slice(-15))
      out.push(
        new Paragraph({
          children: [new TextRun({ text: `${new Date(s.timestamp).toLocaleTimeString()} — ${s.type}: ${s.detail}`, font: 'Consolas', size: 18 })],
        }),
      );
  }

  return out;
}

function environmentTable(bug: Bug): Table {
  const c = bug.context;
  const rows: [string, string][] = [
    ['URL', bug.url],
    ['Page title', bug.pageTitle],
    ['Captured', ts(bug.createdAt)],
    ['Status', bug.status],
    ['Severity', bug.severity],
    ['Platform', c.platform],
    ['Language', c.language],
    ['Screen', `${c.screen.width} × ${c.screen.height}`],
    ['Viewport', `${c.viewport.width} × ${c.viewport.height} @${c.devicePixelRatio}x`],
    ['User agent', c.userAgent],
  ];
  if (bug.tags.length) rows.push(['Tags', bug.tags.join(', ')]);

  const thin = { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin },
    rows: rows.map(
      ([k, v]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 25, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 18 })] })],
            }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })] }),
          ],
        }),
    ),
  });
}

export async function toDOCX(b: SessionBundle): Promise<Blob> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: `Testing Session — ${b.session.name}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [
        muted(`Started: ${ts(b.session.startedAt)}   |   `),
        muted(`Ended: ${b.session.endedAt ? ts(b.session.endedAt) : 'In progress'}   |   `),
        muted(`Total bugs: ${b.bugs.length}`),
      ],
      spacing: { after: 240 },
    }),
  ];

  if (b.bugs.length === 0)
    children.push(new Paragraph({ children: [muted('No bugs captured in this session.')] }));

  for (const bug of b.bugs) {
    children.push(
      new Paragraph({
        text: `${bugLabel(bug.seq)} — ${bug.title || 'Untitled'}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360, after: 60 },
      }),
      new Paragraph({ children: [muted(`${bug.url} · ${bug.status} · ${bug.severity} · ${ts(bug.createdAt)}`)], spacing: { after: 120 } }),
      new Paragraph({ children: [new TextRun({ text: bug.description || 'No description' })], spacing: { after: 120 } }),
    );

    const shot = b.screenshots.get(bug.id);
    if (shot) {
      try {
        const { data, width, height } = await imageFor(shot);
        children.push(
          new Paragraph({
            children: [new ImageRun({ data, transformation: { width, height }, type: 'png' })],
            alignment: AlignmentType.LEFT,
            spacing: { after: 160 },
          }),
        );
      } catch {
        children.push(new Paragraph({ children: [muted('[screenshot could not be embedded]')] }));
      }
    }

    if (b.voiceNotes.has(bug.id))
      children.push(
        new Paragraph({
          children: [new TextRun({ text: VOICE_NOTE_TEXT, italics: true, color: GRAY, size: 18 })],
          spacing: { after: 120 },
        }),
      );

    children.push(...evidenceParagraphs(bug));
    children.push(new Paragraph({ children: [label('Environment')], spacing: { before: 200, after: 60 } }));
    children.push(environmentTable(bug));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
