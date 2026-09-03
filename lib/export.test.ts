/**
 * Self-check for the export layer — run with: npx tsx lib/export.test.ts
 * Covers the branchy parts: CSV escaping, markdown structure, GitHub payloads,
 * and the "one data model, many views" invariant (every bug appears in every format).
 */
import assert from 'node:assert/strict';
import { toJSON, toMarkdown, toCSV, toGitHubIssues, slug, type SessionBundle } from './export';
import type { Bug, Session } from './db';

const session: Session = { id: 's1', name: 'Website QA', startedAt: 1_700_000_000_000, endedAt: null };

const bug = (seq: number, over: Partial<Bug> = {}): Bug => ({
  id: `b${seq}`,
  sessionId: 's1',
  seq,
  title: `Bug ${seq}`,
  description: 'It broke',
  status: 'open',
  createdAt: 1_700_000_060_000,
  url: 'https://example.com/login',
  pageTitle: 'Login',
  context: {
    userAgent: 'UA', platform: 'Win32',
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 2,
    language: 'en-US',
    online: true,
  },
  severity: 'medium',
  tags: [],
  console: [],
  network: [],
  steps: [],
  ...over,
});

// A bug that has already been filed carries its issue reference.
const alreadyFiled = bug(5, { title: 'Filed twice?', issue: { number: 9, url: 'https://x.test/9', filedAt: 1 } });

const withEvidence = bug(4, {
  title: 'Add to cart fails',
  severity: 'critical',
  tags: ['checkout', 'p1'],
  console: [
    { timestamp: 1, level: 'error', message: 'Uncaught Error: Invalid Color' },
    { timestamp: 2, level: 'log', message: 'selected color #3270A9' },
  ],
  network: [
    { timestamp: 3, method: 'POST', url: 'https://x.test/api/cart', status: 400, durationMs: 120, failed: true },
    { timestamp: 4, method: 'GET', url: 'https://x.test/api/me', status: 200, durationMs: 30, failed: false },
  ],
  steps: [{ timestamp: 5, type: 'click', detail: 'button "Add to cart"' }],
});

const bundle: SessionBundle = {
  session,
  bugs: [
    bug(1),
    // Nasty cell: comma, quote and newline must all survive CSV round-tripping.
    bug(2, { title: 'Say "hi", then', description: 'line one\nline two' }),
    bug(3, { title: '', description: '' }),
    withEvidence,
  ],
  screenshots: new Map([['b1', new Blob(['x'])]]),
  // BUG-004 has a voice note that was never transcribed.
  voiceNotes: new Set(['b4']),
};

// --- JSON: labels padded, every bug present, screenshot flagged only where it exists
const json = JSON.parse(toJSON(bundle));
assert.equal(json.session.totalBugs, 4);
assert.deepEqual(json.session.bugs.map((b: any) => b.id), ['BUG-001', 'BUG-002', 'BUG-003', 'BUG-004']);
assert.equal(json.session.bugs[0].evidence.screenshot, 'BUG-001.webp');
assert.equal(json.session.bugs[1].evidence.screenshot, null);

// --- Markdown: one heading per bug, image only for the bug that has one
const md = toMarkdown(bundle);
assert.equal(md.match(/^## BUG-/gm)?.length, 4);
assert.ok(md.includes('**Total Bugs:** 4'));
assert.ok(md.includes('![BUG-001](BUG-001.webp)'));
assert.ok(!md.includes('BUG-002.webp'));
assert.ok(md.includes('_No description_'), 'empty description gets a placeholder');

// --- CSV: header + one row per bug. Embedded quotes doubled, newlines stay inside the quoted cell.
const csv = toCSV(bundle);
assert.equal(csv.split('\r\n').length, 5);
assert.ok(csv.includes('"Say ""hi"", then"'), 'quotes doubled');
assert.ok(csv.includes('"line one\nline two"'), 'newline preserved inside quoted cell');
assert.ok(csv.startsWith('"ID","Title"'));

// --- GitHub: one payload per bug, never an empty title
const issues = toGitHubIssues(bundle);
assert.equal(issues.length, 4);
assert.equal(issues[2]!.title, 'BUG-003', 'untitled bug falls back to its label');
assert.ok(issues[0]!.body.includes('https://example.com/login'));
assert.ok(issues.every((i) => i.title.length > 0 && i.body.length > 0));

// --- evidence survives every format, and only failures/errors are surfaced
assert.deepEqual(json.session.bugs[3].console.length, 2, 'JSON keeps the full console buffer');
assert.equal(json.session.bugs[3].severity, 'critical');
assert.deepEqual(json.session.bugs[3].tags, ['checkout', 'p1']);

assert.ok(md.includes('Uncaught Error: Invalid Color'), 'markdown includes console errors');
assert.ok(!md.includes('selected color #3270A9'), 'markdown omits plain log noise');
assert.ok(md.includes('POST https://x.test/api/cart → 400'), 'markdown includes failed requests');
assert.ok(!md.includes('/api/me'), 'markdown omits successful requests');
assert.ok(md.includes('click: button "Add to cart"'), 'markdown includes steps');
assert.ok(md.includes('**Severity:** critical'));

assert.ok(csv.includes('"critical"'), 'CSV carries severity');
assert.ok(csv.includes('"checkout p1"'), 'CSV carries tags');
assert.ok(csv.trim().endsWith(',"1","1"'), 'CSV ends with console-error and failed-request counts');

const evidenceIssue = issues[3]!;
assert.ok(evidenceIssue.body.includes('Uncaught Error: Invalid Color'));
assert.ok(evidenceIssue.body.includes('POST https://x.test/api/cart → 400'));
assert.deepEqual(evidenceIssue.labels, ['bug', 'checkout', 'p1']);

// A bug with no evidence must not emit empty console/network sections.
assert.ok(!issues[0]!.body.includes('Console errors'), 'no empty evidence sections');

// --- an untranscribed voice note must be announced in every text format
assert.ok(md.includes('voice note was recorded'), 'markdown warns about the voice note');
assert.equal(md.match(/voice note was recorded/g)?.length, 1, 'only the bug that has one is flagged');
assert.equal(json.session.bugs[3].evidence.untranscribedVoiceNote, true);
assert.equal(json.session.bugs[0].evidence.untranscribedVoiceNote, false);
assert.ok(evidenceIssue.body.includes('voice note was recorded'), 'GitHub issue warns too');
assert.ok(!issues[0]!.body.includes('voice note'), 'bugs without audio say nothing');

// --- slug: safe filenames, never empty
assert.equal(slug('Website QA'), 'website-qa');
assert.equal(slug('!!!'), 'session');

console.log('export self-check passed');

// --- repo URL parsing: accept whatever a person actually pastes
{
  const { parseRepoUrl } = await import('./github');
  const expect = (input: string, want: string | null) => {
    const got = parseRepoUrl(input);
    assert.equal(got ? `${got.owner}/${got.repo}` : null, want, `parseRepoUrl(${JSON.stringify(input)})`);
  };
  expect('https://github.com/loyality7/iso_99', 'loyality7/iso_99');
  expect('http://www.github.com/loyality7/iso_99/', 'loyality7/iso_99');
  expect('github.com/loyality7/iso_99', 'loyality7/iso_99');
  expect('loyality7/iso_99', 'loyality7/iso_99');
  expect('https://github.com/loyality7/iso_99.git', 'loyality7/iso_99');
  expect('git@github.com:loyality7/iso_99.git', 'loyality7/iso_99');
  expect('https://github.com/loyality7/iso_99/issues', 'loyality7/iso_99');
  expect('https://github.com/loyality7/iso_99/tree/main/src', 'loyality7/iso_99');
  expect('https://github.com/loyality7/iso_99?tab=readme', 'loyality7/iso_99');
  expect('  https://github.com/loyality7/iso_99  ', 'loyality7/iso_99');
  expect('https://github.com/loyality7', null);
  expect('', null);
  expect('not a repo', null);
}

console.log('github url parsing passed');

// --- token template URL: the permissions must be pre-ticked, or setup breaks silently
{
  const { tokenTemplateUrl } = await import('./github');
  const url = new URL(tokenTemplateUrl('loyality7'));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('issues'), 'write', 'issues write is required to file');
  assert.equal(url.searchParams.get('contents'), 'write', 'contents write is what attaches screenshots');
  assert.equal(url.searchParams.get('metadata'), 'read', 'GitHub requires metadata alongside other perms');
  assert.equal(url.searchParams.get('target_name'), 'loyality7');
  assert.ok((url.searchParams.get('name') ?? '').length <= 40, 'GitHub caps the name at 40 chars');
  assert.ok((url.searchParams.get('description') ?? '').length <= 1024);

  // Without an owner the form still opens, just without a pre-selected resource owner.
  assert.equal(new URL(tokenTemplateUrl()).searchParams.get('target_name'), null);
}

console.log('token template passed');
