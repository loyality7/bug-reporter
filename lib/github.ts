import { toGitHubIssues, type SessionBundle } from './export';
import { bugLabel } from './db';

/**
 * Optional GitHub adapter. Reads the same bug data every other export uses and creates
 * real issues over the REST API. Token is stored locally and never leaves the browser
 * except in the Authorization header to github.com.
 */
export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

const API = 'https://api.github.com';

/**
 * Accepts what people actually paste: a repo URL, a clone URL, or plain `owner/repo`.
 * Returns null when it isn't a GitHub repo reference.
 */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const text = input.trim();
  if (!text) return null;

  const cleaned = text
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

  // Trailing path segments (/issues, /tree/main, ...) are fine — take the first two.
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * A pre-filled fine-grained token form.
 *
 * GitHub supports token "templates" via query parameters, so the exact permissions can be
 * ticked in advance. Getting Contents wrong is the usual reason screenshots silently fail
 * to attach, and this removes that guesswork.
 */
export function tokenTemplateUrl(owner?: string): string {
  const params = new URLSearchParams({
    name: 'Session Bug Reporter',
    description: 'Creates issues and uploads bug screenshots from the Session Bug Reporter extension.',
    expires_in: '90',
    // Issues to file the report; contents to commit screenshots to the images branch;
    // metadata is required by GitHub whenever any other repository permission is set.
    issues: 'write',
    contents: 'write',
    metadata: 'read',
  });
  if (owner) params.set('target_name', owner);
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

export const loadConfig = async (): Promise<GitHubConfig | null> =>
  ((await browser.storage.local.get('github')).github as GitHubConfig) ?? null;

export const saveConfig = (config: GitHubConfig) => browser.storage.local.set({ github: config });

export const clearConfig = () => browser.storage.local.remove('github');

/**
 * When on, saving a bug also files it as a GitHub issue. Off by default — filing should be
 * a deliberate choice, not a surprise every time someone logs a bug.
 */
export const loadAutoFile = async (): Promise<boolean> =>
  Boolean((await browser.storage.local.get('githubAutoFile')).githubAutoFile);

export const saveAutoFile = (enabled: boolean) =>
  browser.storage.local.set({ githubAutoFile: enabled });

/** Confirms the token works and the repo is writable before we try to create anything. */
export async function verify(
  config: GitHubConfig,
): Promise<{ ok: true; login: string; canUploadImages: boolean } | { ok: false; error: string }> {
  try {
    const me = await fetch(`${API}/user`, { headers: headers(config.token) });
    if (me.status === 401) return { ok: false, error: 'Token rejected. Check it has not expired.' };
    if (!me.ok) return { ok: false, error: `GitHub returned ${me.status}.` };
    const { login } = await me.json();

    const repo = await fetch(`${API}/repos/${config.owner}/${config.repo}`, { headers: headers(config.token) });
    if (repo.status === 404)
      return { ok: false, error: `Repo ${config.owner}/${config.repo} not found, or the token cannot see it.` };
    if (!repo.ok) return { ok: false, error: `Could not read the repo (${repo.status}).` };
    const info = await repo.json();
    if (!info.permissions?.push)
      return { ok: false, error: 'Token lacks write access to this repo. It needs Issues: Read and write.' };

    return { ok: true, login, canUploadImages: await canWriteContents(config) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const IMAGE_BRANCH = 'bug-reporter-screenshots';

/**
 * Whether the credential can actually commit blobs.
 *
 * Read access to /contents proves nothing — a token can list files and still be refused on
 * write. Probing the refs API is the cheapest honest check: a malformed ref returns 422 when
 * the token may write and 403 when it may not, and nothing is created either way.
 */
async function canWriteContents(c: GitHubConfig): Promise<boolean> {
  try {
    const res = await fetch(`${API}/repos/${c.owner}/${c.repo}/git/refs`, {
      method: 'POST',
      headers: headers(c.token),
      body: JSON.stringify({ ref: 'refs/heads/', sha: '' }),
    });
    return res.status !== 403 && res.status !== 401;
  } catch {
    return false;
  }
}

const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Ensures the screenshot branch exists, branched off the default branch.
 *
 * An orphan branch would be tidier, but creating one needs `git/trees` with an empty tree,
 * which GitHub rejects ("Invalid tree info") and fine-grained tokens often cannot reach at
 * all. Branching from the default branch uses only the refs API, which plain Contents:write
 * covers. The branch is never merged, so it still stays out of the code history.
 */
async function ensureImageBranch(c: GitHubConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = `${API}/repos/${c.owner}/${c.repo}`;
  const describe = async (step: string, res: Response) => ({
    ok: false as const,
    error: res.status === 403
      ? 'the token cannot write repository contents (needs Contents: Read and write)'
      : `${step} failed: ${res.status} ${(await res.text()).slice(0, 120)}`,
  });

  const exists = await fetch(`${base}/git/ref/heads/${IMAGE_BRANCH}`, { headers: headers(c.token) });
  if (exists.ok) return { ok: true };

  const repo = await fetch(base, { headers: headers(c.token) });
  if (!repo.ok) return describe('reading the repository', repo);
  const { default_branch: defaultBranch } = await repo.json();

  const head = await fetch(`${base}/git/ref/heads/${defaultBranch}`, { headers: headers(c.token) });
  // A repository with no commits yet has no ref to branch from.
  if (!head.ok)
    return head.status === 404
      ? { ok: false, error: 'the repository has no commits yet, so there is nothing to branch from' }
      : describe('reading the default branch', head);

  const created = await fetch(`${base}/git/refs`, {
    method: 'POST',
    headers: headers(c.token),
    body: JSON.stringify({ ref: `refs/heads/${IMAGE_BRANCH}`, sha: (await head.json()).object.sha }),
  });
  // 422 here means another push created it a moment ago, which is fine.
  if (!created.ok && created.status !== 422) return describe('creating the branch', created);

  // The new branch inherits the code tree. Point it at an empty tree so it carries nothing
  // but screenshots. Best effort — if the Git data API is out of reach, the branch still works.
  await emptyTheBranch(c).catch(() => {});
  return { ok: true };
}

/** Replaces the branch tip with a commit holding no files. */
async function emptyTheBranch(c: GitHubConfig): Promise<void> {
  const base = `${API}/repos/${c.owner}/${c.repo}`;
  const ref = await fetch(`${base}/git/ref/heads/${IMAGE_BRANCH}`, { headers: headers(c.token) });
  if (!ref.ok) return;
  const parent = (await ref.json()).object.sha;

  // A .gitkeep gives the tree one entry; GitHub rejects a literally empty tree.
  const tree = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers: headers(c.token),
    body: JSON.stringify({
      tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: EMPTY_BRANCH_README }],
    }),
  });
  if (!tree.ok) return;

  const commit = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers: headers(c.token),
    body: JSON.stringify({
      message: 'Start screenshot branch with no source files',
      tree: (await tree.json()).sha,
      parents: [parent],
    }),
  });
  if (!commit.ok) return;

  await fetch(`${base}/git/refs/heads/${IMAGE_BRANCH}`, {
    method: 'PATCH',
    headers: headers(c.token),
    body: JSON.stringify({ sha: (await commit.json()).sha, force: true }),
  });
}

const EMPTY_BRANCH_README = [
  '# Bug report screenshots',
  '',
  'Images attached to GitHub issues by the Session Bug Reporter extension.',
  'This branch holds no source code and is never merged.',
  '',
].join('\n');

/** Commits one screenshot and returns the raw URL GitHub will render inside an issue. */
async function uploadImage(
  c: GitHubConfig,
  path: string,
  blob: Blob,
): Promise<{ url: string } | { error: string }> {
  try {
    // The path must not be URI-encoded as a whole — slashes are real path separators.
    const res = await fetch(`${API}/repos/${c.owner}/${c.repo}/contents/${path}`, {
      method: 'PUT',
      headers: headers(c.token),
      body: JSON.stringify({
        message: `Add screenshot ${path}`,
        content: b64(await blob.arrayBuffer()),
        branch: IMAGE_BRANCH,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { error: res.status === 403
        ? 'token cannot write repository contents'
        : `${res.status} ${body.slice(0, 120)}` };
    }
    const url = (await res.json()).content?.download_url;
    return url ? { url } : { error: 'upload succeeded but no download URL was returned' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface PushResult {
  created: { bug: string; number: number; url: string }[];
  failed: { bug: string; error: string }[];
  /** Why screenshots were left out, when they were. */
  imageWarning?: string;
}

/**
 * Creates one issue per bug, carrying description, environment, console errors, failed
 * requests and steps — plus the screenshot when image upload succeeds.
 *
 * GitHub has no issue-attachment API, so screenshots are committed to a dedicated orphan
 * branch (never merged, never in your code history) and the issue embeds the raw URL.
 */
/**
 * Creates one issue for a single freshly-saved bug, so a bug can go straight from capture
 * to GitHub without a trip through the dashboard. Same pipeline as a session push.
 */
export async function pushOneIssue(
  bugId: string,
  config: GitHubConfig,
  onProgress?: (message: string) => void,
): Promise<{ number: number; url: string; imageWarning?: string } | { error: string }> {
  const { db } = await import('./db');
  const bug = await db.bugs.get(bugId);
  if (!bug) return { error: 'That bug no longer exists.' };
  const session = await db.sessions.get(bug.sessionId);
  if (!session) return { error: 'That session no longer exists.' };

  const evidence = await db.evidence.where('bugId').equals(bugId).toArray();
  const bundle: SessionBundle = {
    session,
    bugs: [bug],
    screenshots: new Map(evidence.filter((e) => e.kind === 'screenshot').map((e) => [e.bugId, e.blob])),
    voiceNotes: new Set(evidence.filter((e) => e.kind === 'audio').map((e) => e.bugId)),
  };

  const result = await pushIssues(bundle, config, onProgress);
  const created = result.created[0];
  // Carry the image warning through: an issue with no screenshot must say why.
  if (created) return { number: created.number, url: created.url, imageWarning: result.imageWarning };
  return { error: result.failed[0]?.error ?? result.imageWarning ?? 'The issue could not be created.' };
}

export async function pushIssues(
  bundle: SessionBundle,
  config: GitHubConfig,
  onProgress?: (message: string) => void,
): Promise<PushResult> {
  // Upload screenshots first so each issue body can link a real, renderable image.
  const images = new Map<string, string>();
  let imageWarning: string | undefined;

  const withShots = bundle.bugs.filter((b) => bundle.screenshots.has(b.id));
  if (withShots.length > 0) {
    const branch = await ensureImageBranch(config);
    if (!branch.ok) {
      imageWarning = `Screenshots were not attached — ${branch.error}`;
    } else {
      const stamp = Date.now();
      const problems: string[] = [];
      for (const [i, bug] of withShots.entries()) {
        onProgress?.(`Uploading screenshot ${i + 1} of ${withShots.length}…`);
        const res = await uploadImage(
          config,
          `screenshots/${stamp}-${bugLabel(bug.seq)}.webp`,
          bundle.screenshots.get(bug.id)!,
        );
        if ('url' in res) images.set(bug.id, res.url);
        else problems.push(res.error);
      }
      if (problems.length)
        imageWarning = `${problems.length} of ${withShots.length} screenshots failed to upload — ${problems[0]}`;
    }
  }

  const payloads = toGitHubIssues(bundle, images);
  const result: PushResult = { created: [], failed: [], imageWarning };

  for (const [i, payload] of payloads.entries()) {
    try {
      const res = await fetch(`${API}/repos/${config.owner}/${config.repo}/issues`, {
        method: 'POST',
        headers: headers(config.token),
        // Labels that don't exist yet would 422 the whole request, so send none.
        body: JSON.stringify({ title: payload.title, body: payload.body }),
      });

      if (res.ok) {
        const issue = await res.json();
        result.created.push({ bug: payload.title, number: issue.number, url: issue.html_url });
      } else {
        const detail = await res.text();
        result.failed.push({
          bug: payload.title,
          error: res.status === 403 ? 'Rate limited or forbidden.' : `${res.status}: ${detail.slice(0, 140)}`,
        });
      }
    } catch (e) {
      result.failed.push({ bug: payload.title, error: e instanceof Error ? e.message : String(e) });
    }
    onProgress?.(`Creating issue ${i + 1} of ${payloads.length}…`);
  }

  return result;
}
