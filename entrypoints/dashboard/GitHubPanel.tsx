import { useEffect, useRef, useState } from 'react';
import { loadBundle, toGitHubIssues, download, slug } from '@/lib/export';
import {
  loadConfig, saveConfig, clearConfig, verify, pushIssues, parseRepoUrl,
  loadAutoFile, saveAutoFile, tokenTemplateUrl,
  type GitHubConfig, type PushResult,
} from '@/lib/github';
import { isOAuthConfigured, requestDeviceCode, pollForToken, listRepos, type DeviceCode } from '@/lib/githubAuth';
import { Button, SectionTitle } from '@/components/ui';

type Repo = { owner: string; repo: string; fullName: string };

/** Optional GitHub integration. The extension works fully without it. */
export default function GitHubPanel({ sessionId }: { sessionId: string }) {
  const [config, setConfig] = useState<GitHubConfig | null | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  const [canUploadImages, setCanUploadImages] = useState(true);

  // Sign-in state
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState({ token: '', url: '' });
  const abort = useRef<AbortController | null>(null);

  const [autoFile, setAutoFile] = useState(false);

  useEffect(() => { loadConfig().then(setConfig); }, []);
  useEffect(() => { loadAutoFile().then(setAutoFile); }, []);

  async function toggleAutoFile(next: boolean) {
    setAutoFile(next);
    await saveAutoFile(next);
  }
  useEffect(() => () => abort.current?.abort(), []);

  async function apply(candidate: GitHubConfig, onFail?: (msg: string) => void) {
    const check = await verify(candidate);
    if (check.ok) {
      await saveConfig(candidate);
      setConfig(candidate);
      setCanUploadImages(check.canUploadImages);
      setStatus(null);
      setRepos(null);
      return true;
    }
    (onFail ?? setStatus)(check.error);
    return false;
  }

  /** Device Flow: show a code, wait for approval, then let the user pick a repo. */
  async function signIn() {
    setBusy(true);
    setStatus(null);
    try {
      const code = await requestDeviceCode();
      setDevice(code);
      await navigator.clipboard.writeText(code.userCode).catch(() => {});
      window.open(code.verificationUri, '_blank', 'noopener');

      abort.current = new AbortController();
      const accessToken = await pollForToken(code, { signal: abort.current.signal });
      setToken(accessToken);
      setDevice(null);
      setRepos(await listRepos(accessToken));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setDevice(null);
    } finally {
      setBusy(false);
    }
  }

  async function chooseRepo(fullName: string) {
    if (!token) return;
    const parsed = parseRepoUrl(fullName);
    if (!parsed) return setStatus('Could not read that repository name.');
    setBusy(true);
    await apply({ token, ...parsed });
    setBusy(false);
  }

  async function connectManually() {
    const parsed = parseRepoUrl(form.url);
    if (!parsed) return setStatus('Paste a repository URL, e.g. https://github.com/owner/repo');
    setBusy(true);
    setStatus(null);
    await apply({ token: form.token.trim(), ...parsed });
    setBusy(false);
  }

  async function disconnect() {
    abort.current?.abort();
    await clearConfig();
    setConfig(null);
    setToken(null);
    setRepos(null);
    setDevice(null);
    setResult(null);
    setStatus(null);
  }

  async function push() {
    if (!config) return;
    setBusy(true);
    setResult(null);
    setStatus(null);
    try {
      const bundle = await loadBundle(sessionId);
      if (bundle.bugs.length === 0) {
        setStatus('No bugs in this session to push.');
        return;
      }
      const unfiled = bundle.bugs.filter((b) => !b.issue).length;
      if (unfiled === 0) {
        setStatus('Every bug in this session already has an issue.');
        return;
      }
      if (!confirm(`Create ${unfiled} issue(s) in ${config.owner}/${config.repo}?`)) return;
      setResult(await pushIssues(bundle, config, setProgress));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function exportPayloads() {
    const bundle = await loadBundle(sessionId);
    download(
      JSON.stringify(toGitHubIssues(bundle), null, 2),
      `${slug(bundle.session.name)}-github-issues.json`,
      'application/json',
    );
  }

  const loading = config === undefined;

  return (
    <div className="max-w-2xl">
      <h2 className="text-sm font-semibold tracking-tight">GitHub</h2>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        Turn this session into issues. Optional — the extension works fully without it, and your
        credentials never leave this browser.
      </p>

      <div className="mt-4 rounded-lg border border-neutral-200 bg-white px-4 py-3">
        {loading ? (
          <p className="py-2 text-sm text-neutral-500">Loading…</p>
        ) : config ? (
          <Connected
            config={config} busy={busy} canUploadImages={canUploadImages}
            progress={progress} status={status} result={result}
            autoFile={autoFile} onToggleAutoFile={toggleAutoFile}
            onPush={push} onDisconnect={disconnect}
          />
        ) : device ? (
          <DeviceStep code={device} onCancel={() => { abort.current?.abort(); setDevice(null); setBusy(false); }} />
        ) : repos ? (
          <RepoPicker repos={repos} busy={busy} status={status} onPick={chooseRepo} onCancel={disconnect} />
        ) : (
          <SignIn
            busy={busy} status={status} manual={manual} form={form}
            setForm={setForm} setManual={setManual} onSignIn={signIn} onManual={connectManually}
          />
        )}
      </div>

      <section className="mt-6">
        <SectionTitle>Export instead</SectionTitle>
        <div className="mt-2 flex items-center gap-4 rounded-lg border border-neutral-200 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Issue payloads (JSON)</p>
            <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
              Title and body for every bug, ready to POST from your own script or automation.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={exportPayloads}>Export</Button>
        </div>
      </section>
    </div>
  );
}

function SignIn({
  busy, status, manual, form, setForm, setManual, onSignIn, onManual,
}: {
  busy: boolean; status: string | null; manual: boolean;
  form: { token: string; url: string };
  setForm: (f: { token: string; url: string }) => void;
  setManual: (v: boolean) => void;
  onSignIn: () => void; onManual: () => void;
}) {
  const oauth = isOAuthConfigured();

  if (!manual && oauth)
    return (
      <>
        <p className="text-sm font-medium">Connect GitHub</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          Create issues straight from a session. Optional — everything else works without it.
        </p>
        <Button onClick={onSignIn} disabled={busy} className="mt-2">
          {busy ? 'Waiting for approval…' : 'Sign in with GitHub'}
        </Button>
        <button onClick={() => setManual(true)} className="ml-3 text-xs text-neutral-500 underline">
          Use a token instead
        </button>
        {status && <p className="mt-2 text-xs text-red-600">{status}</p>}
      </>
    );

  // Pre-selects the owner on GitHub's form once a repo URL has been pasted.
  const owner = parseRepoUrl(form.url)?.owner;

  return (
    <>
      <p className="text-sm font-medium">Connect a repository</p>
      <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
        Paste the repo URL, then create a token. The link below opens GitHub with the right
        permissions already ticked. Stored locally in this browser only.
      </p>

      <ol className="mt-3 space-y-2 text-xs text-neutral-700">
        <li className="flex gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-medium">1</span>
          <div className="flex-1">
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://github.com/owner/repo"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-900"
            />
          </div>
        </li>
        <li className="flex gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-medium">2</span>
          <div className="flex-1 pt-1">
            <a
              href={tokenTemplateUrl(owner)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-50"
            >
              Create a token on GitHub
            </a>
            <p className="mt-1 text-neutral-500">
              Opens with <strong>Issues</strong> and <strong>Contents</strong> set to Read and write
              {owner ? <> for <strong>{owner}</strong></> : null}. Pick the repository, then Generate.
            </p>
          </div>
        </li>
        <li className="flex gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-medium">3</span>
          <span className="flex-1 pt-1.5 text-neutral-500">Paste the token below.</span>
        </li>
      </ol>
      <input
        type="password"
        value={form.token}
        onChange={(e) => setForm({ ...form, token: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') onManual(); }}
        placeholder="github_pat_..."
        className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-900"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={onManual} disabled={busy || !form.token.trim() || !form.url.trim()}>
          {busy ? 'Verifying…' : 'Connect'}
        </Button>
        {oauth && (
          <button onClick={() => setManual(false)} className="text-xs text-neutral-500 underline">
            Sign in with GitHub instead
          </button>
        )}
      </div>
      {status && <p className="mt-2 text-xs text-red-600">{status}</p>}
    </>
  );
}

function DeviceStep({ code, onCancel }: { code: DeviceCode; onCancel: () => void }) {
  return (
    <>
      <p className="text-sm font-medium">Enter this code on GitHub</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        A GitHub tab should have opened, and the code is on your clipboard. Approve there and this
        connects itself.
      </p>
      <p className="my-3 font-mono text-2xl tracking-[0.3em] text-neutral-900">{code.userCode}</p>
      <a href={code.verificationUri} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">
        {code.verificationUri}
      </a>
      <div className="mt-3">
        <button onClick={onCancel} className="text-xs text-neutral-500 underline">Cancel</button>
      </div>
    </>
  );
}

function RepoPicker({
  repos, busy, status, onPick, onCancel,
}: {
  repos: Repo[]; busy: boolean; status: string | null;
  onPick: (fullName: string) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase())).slice(0, 50);

  return (
    <>
      <p className="text-sm font-medium">Choose a repository</p>
      <p className="mt-0.5 text-xs text-neutral-500">{repos.length} repositories you can write to.</p>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter, or paste a repo URL"
        className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-900"
      />
      <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border border-neutral-200">
        {shown.map((r) => (
          <li key={r.fullName}>
            <button
              disabled={busy}
              onClick={() => onPick(r.fullName)}
              className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-neutral-50 disabled:text-neutral-400"
            >
              {r.fullName}
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-3 py-2">
            <button
              disabled={busy || !q.trim()}
              onClick={() => onPick(q)}
              className="text-sm text-blue-600 underline disabled:text-neutral-400"
            >
              Use “{q.trim() || '…'}” anyway
            </button>
          </li>
        )}
      </ul>
      <button onClick={onCancel} className="mt-2 text-xs text-neutral-500 underline">Cancel</button>
      {status && <p className="mt-2 text-xs text-red-600">{status}</p>}
    </>
  );
}

function Connected({
  config, busy, canUploadImages, progress, status, result, autoFile, onToggleAutoFile,
  onPush, onDisconnect,
}: {
  config: GitHubConfig; busy: boolean; canUploadImages: boolean;
  progress: string | null; status: string | null; result: PushResult | null;
  autoFile: boolean; onToggleAutoFile: (next: boolean) => void;
  onPush: () => void; onDisconnect: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Create issues in{' '}
            <a
              href={`https://github.com/${config.owner}/${config.repo}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              {config.owner}/{config.repo}
            </a>
          </p>
          <p className="text-xs text-neutral-500">
            One issue per bug: screenshot, description, environment, console errors, failed requests
            and steps. Screenshots are committed to a{' '}
            <code className="rounded bg-neutral-100 px-1">bug-reporter-screenshots</code> branch,
            kept out of your code history.
          </p>
        </div>
        <Button onClick={onPush} disabled={busy}>{busy ? 'Creating…' : 'Create Issues'}</Button>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5">
        <input
          type="checkbox"
          checked={autoFile}
          onChange={(e) => onToggleAutoFile(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-neutral-900"
        />
        <span className="text-xs leading-relaxed">
          <span className="font-medium text-neutral-800">File every bug as an issue automatically</span>
          <span className="mt-0.5 block text-neutral-500">
            When on, “Log bug” also creates the issue as you capture. Off by default — file
            individually from a bug, or push the whole session with the button above.
          </span>
        </span>
      </label>

      <button onClick={onDisconnect} className="mt-3 text-xs text-neutral-500 underline">Disconnect</button>

      {!canUploadImages && (
        <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          <p>
            This token cannot write repository contents, so issues will be created{' '}
            <strong>without screenshots</strong>.
          </p>
          <a
            href={tokenTemplateUrl(config.owner)}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center rounded border border-amber-300 px-2 py-1 font-medium transition-colors hover:bg-amber-100"
          >
            Create a token with the right permissions
          </a>
          <p className="mt-1.5">Then disconnect and reconnect with the new token.</p>
        </div>
      )}
      {progress && <p className="mt-2 text-xs text-neutral-600">{progress}</p>}
      {status && <p className="mt-2 text-xs text-neutral-600">{status}</p>}

      {result && (
        <div className="mt-3 text-xs">
          {result.created.length > 0 && (
            <>
              <p className="font-medium text-green-700">Created {result.created.length} issue(s):</p>
              <ul className="mt-1 space-y-0.5">
                {result.created.map((c) => (
                  <li key={c.number}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">#{c.number}</a>{' '}
                    <span className="text-neutral-600">{c.bug}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.imageWarning && (
            <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 leading-relaxed text-amber-800">
              <p>{result.imageWarning}</p>
              <a
                href={tokenTemplateUrl(config.owner)}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center rounded border border-amber-300 px-2 py-1 font-medium transition-colors hover:bg-amber-100"
              >
                Create a token with the right permissions
              </a>
            </div>
          )}
          {result.failed.length > 0 && (
            <>
              <p className="mt-2 font-medium text-red-600">Failed {result.failed.length}:</p>
              <ul className="mt-1 space-y-0.5 text-neutral-600">
                {result.failed.map((f, i) => <li key={i}>{f.bug} — {f.error}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
