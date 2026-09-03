import { db, bugLabel, type Bug, type Session } from './db';

export interface SessionBundle {
  session: Session;
  bugs: Bug[];
  screenshots: Map<string, Blob>; // bugId -> blob
  /** Bug ids with a voice note. Audio only exists when dictation failed, so the words are
   *  not in the description and every text format has to say so. */
  voiceNotes: Set<string>;
}

export async function loadBundle(sessionId: string): Promise<SessionBundle> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');
  const bugs = (await db.bugs.where('sessionId').equals(sessionId).toArray()).sort((a, b) => a.seq - b.seq);
  const evidence = await db.evidence.where('sessionId').equals(sessionId).toArray();
  return {
    session,
    bugs,
    screenshots: new Map(evidence.filter((e) => e.kind === 'screenshot').map((e) => [e.bugId, e.blob])),
    voiceNotes: new Set(evidence.filter((e) => e.kind === 'audio').map((e) => e.bugId)),
  };
}

const ts = (ms: number) => new Date(ms).toLocaleString();

export function toJSON(b: SessionBundle, screenshotUrls?: Map<string, string>): string {
  return JSON.stringify(
    {
      session: {
        id: b.session.id,
        name: b.session.name,
        startedAt: new Date(b.session.startedAt).toISOString(),
        endedAt: b.session.endedAt ? new Date(b.session.endedAt).toISOString() : null,
        totalBugs: b.bugs.length,
        bugs: b.bugs.map((bug) => ({
          id: bugLabel(bug.seq),
          title: bug.title,
          description: bug.description,
          status: bug.status,
          severity: bug.severity,
          tags: bug.tags,
          createdAt: new Date(bug.createdAt).toISOString(),
          url: bug.url,
          pageTitle: bug.pageTitle,
          context: bug.context,
          console: bug.console,
          network: bug.network,
          steps: bug.steps,
          evidence: {
            screenshot: screenshotUrls?.get(bug.id) ?? (b.screenshots.has(bug.id) ? `${bugLabel(bug.seq)}.webp` : null),
            untranscribedVoiceNote: b.voiceNotes.has(bug.id),
          },
        })),
      },
    },
    null,
    2,
  );
}

export function toMarkdown(b: SessionBundle, imgPath = (bug: Bug) => `${bugLabel(bug.seq)}.webp`): string {
  const head = [
    `# Testing Session — ${b.session.name}`,
    '',
    `**Started:** ${ts(b.session.startedAt)}  `,
    `**Ended:** ${b.session.endedAt ? ts(b.session.endedAt) : 'In progress'}  `,
    `**Total Bugs:** ${b.bugs.length}`,
    '',
  ];
  const body = b.bugs.map((bug) => {
    const lines = [
      '---',
      '',
      `## ${bugLabel(bug.seq)} — ${bug.title || 'Untitled'}`,
      '',
      `**Page:** ${bug.url}`,
      `**Status:** ${bug.status} · **Severity:** ${bug.severity}`,
      `**Time:** ${ts(bug.createdAt)}`,
      '',
      '**Description:**',
      '',
      bug.description || '_No description_',
      '',
    ];
    if (b.screenshots.has(bug.id)) lines.push('**Screenshot:**', '', `![${bugLabel(bug.seq)}](${imgPath(bug)})`, '');
    if (bug.tags.length) lines.push(`**Tags:** ${bug.tags.join(', ')}`, '');
    if (b.voiceNotes.has(bug.id)) lines.push(`> ${VOICE_NOTE_TEXT}`, '');

    const errors = bug.console.filter((c) => c.level === 'error' || c.level === 'warn');
    if (errors.length) {
      lines.push('**Console:**', '', '```');
      for (const c of errors) lines.push(`[${c.level}] ${c.message}`);
      lines.push('```', '');
    }

    const failed = bug.network.filter((n) => n.failed);
    if (failed.length) {
      lines.push('**Failed requests:**', '', '```');
      for (const n of failed) lines.push(`${n.method} ${n.url} → ${n.status || 'ERR'} (${n.durationMs}ms)`);
      lines.push('```', '');
    }

    if (bug.steps.length) {
      lines.push('**Steps before the bug:**', '', '```');
      for (const s of bug.steps.slice(-15))
        lines.push(`${new Date(s.timestamp).toLocaleTimeString()} — ${s.type}: ${s.detail}`);
      lines.push('```', '');
    }

    lines.push(
      '**Environment:**',
      '',
      '```',
      `URL:        ${bug.url}`,
      `Page title: ${bug.pageTitle}`,
      `User agent: ${bug.context.userAgent}`,
      `Platform:   ${bug.context.platform}`,
      `Screen:     ${bug.context.screen.width}x${bug.context.screen.height}`,
      `Viewport:   ${bug.context.viewport.width}x${bug.context.viewport.height} @${bug.context.devicePixelRatio}x`,
      '```',
      '',
    );
    return lines.join('\n');
  });
  return [...head, ...body].join('\n');
}

export const VOICE_NOTE_TEXT =
  'A voice note was recorded for this bug but not transcribed. Open the session dashboard and use "Transcribe to text" to add its words here.';

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function toCSV(b: SessionBundle): string {
  const header = ['ID', 'Title', 'Description', 'Status', 'Severity', 'Tags', 'URL', 'Page Title', 'Created', 'Screenshot', 'Console Errors', 'Failed Requests'];
  const rows = b.bugs.map((bug) =>
    [
      bugLabel(bug.seq), bug.title, bug.description, bug.status, bug.severity, bug.tags.join(' '),
      bug.url, bug.pageTitle, new Date(bug.createdAt).toISOString(),
      b.screenshots.has(bug.id) ? 'yes' : 'no',
      bug.console.filter((c) => c.level === 'error').length,
      bug.network.filter((n) => n.failed).length,
    ].map(csvCell).join(','),
  );
  return [header.map(csvCell).join(','), ...rows].join('\r\n');
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained HTML report. Images inlined so the single file is portable. */
export async function toHTML(b: SessionBundle): Promise<string> {
  const imgs = new Map<string, string>();
  for (const [bugId, blob] of b.screenshots) imgs.set(bugId, await blobToDataUrl(blob));
  const bugs = b.bugs
    .map(
      (bug) => `<article>
  <h2>${escapeHtml(bugLabel(bug.seq))} — ${escapeHtml(bug.title || 'Untitled')}</h2>
  <p class="meta">${escapeHtml(bug.url)} · ${escapeHtml(bug.status)} · ${escapeHtml(ts(bug.createdAt))}</p>
  <p>${escapeHtml(bug.description || 'No description').replace(/\n/g, '<br>')}</p>
  ${imgs.has(bug.id) ? `<img src="${imgs.get(bug.id)}" alt="${escapeHtml(bugLabel(bug.seq))}">` : ''}
  <pre>${escapeHtml(`User agent: ${bug.context.userAgent}\nPlatform: ${bug.context.platform}\nScreen: ${bug.context.screen.width}x${bug.context.screen.height}\nViewport: ${bug.context.viewport.width}x${bug.context.viewport.height} @${bug.context.devicePixelRatio}x`)}</pre>
</article>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(b.session.name)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
h1{margin-bottom:.25rem}article{border-top:1px solid #ddd;padding-top:1.5rem;margin-top:1.5rem}
.meta{color:#666;font-size:13px}img{max-width:100%;border:1px solid #ddd;border-radius:6px}
pre{background:#f6f6f6;padding:.75rem;border-radius:6px;overflow-x:auto;font-size:12px}</style></head>
<body><h1>${escapeHtml(b.session.name)}</h1>
<p class="meta">${escapeHtml(ts(b.session.startedAt))} — ${escapeHtml(b.session.endedAt ? ts(b.session.endedAt) : 'in progress')} · ${b.bugs.length} bugs</p>
${bugs}</body></html>`;
}

/**
 * GitHub issue payloads — same data, adapter shape.
 * Pass `images` (bugId -> data URI) to embed screenshots directly in the issue body.
 */
export function toGitHubIssues(b: SessionBundle, images?: Map<string, string>) {
  return b.bugs.map((bug) => ({
    title: bug.title || bugLabel(bug.seq),
    body: [
      bug.description || '_No description_',
      '',
      `**Page:** ${bug.url}`,
      `**Severity:** ${bug.severity}`,
      '',
      ...(images?.has(bug.id) ? [`![${bugLabel(bug.seq)}](${images.get(bug.id)})`, ''] : []),
      ...(b.voiceNotes.has(bug.id) ? [`> ${VOICE_NOTE_TEXT}`, ''] : []),
      ...githubEvidence(bug),
      '<details><summary>Environment</summary>',
      '',
      '```',
      `User agent: ${bug.context.userAgent}`,
      `Platform:   ${bug.context.platform}`,
      `Screen:     ${bug.context.screen.width}x${bug.context.screen.height}`,
      `Viewport:   ${bug.context.viewport.width}x${bug.context.viewport.height} @${bug.context.devicePixelRatio}x`,
      '```',
      '</details>',
      '',
      `_Captured with Session Bug Reporter — session "${b.session.name}", ${bugLabel(bug.seq)}_`,
    ].join('\n'),
    labels: ['bug', ...bug.tags],
  }));
}

function githubEvidence(bug: Bug): string[] {
  const out: string[] = [];
  const errors = bug.console.filter((c) => c.level === 'error');
  if (errors.length) {
    out.push('<details><summary>Console errors</summary>', '', '```');
    for (const c of errors) out.push(c.message);
    out.push('```', '</details>', '');
  }
  const failed = bug.network.filter((n) => n.failed);
  if (failed.length) {
    out.push('<details><summary>Failed requests</summary>', '', '```');
    for (const n of failed) out.push(`${n.method} ${n.url} → ${n.status || 'ERR'}`);
    out.push('```', '</details>', '');
  }
  if (bug.steps.length) {
    out.push('<details><summary>Steps to reproduce</summary>', '', '```');
    for (const s of bug.steps.slice(-15)) out.push(`${s.type}: ${s.detail}`);
    out.push('```', '</details>', '');
  }
  return out;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function download(content: string | Blob, filename: string, type = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
