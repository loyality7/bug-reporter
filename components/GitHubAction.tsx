import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { loadConfig, loadAutoFile, pushOneIssue, type GitHubConfig } from '@/lib/github';
import { db } from '@/lib/db';

type Phase = 'unknown' | 'unconfigured' | 'ready' | 'pushing' | 'done' | 'failed';

/** Lucide dropped brand marks, so the GitHub logo is inlined. */
const GitHubMark = ({ size = 13 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
  </svg>
);

/**
 * Sends a saved bug to GitHub from the capture UI, so a bug can be filed the moment it is
 * found. When no repo is configured it points at the dashboard rather than embedding a
 * whole setup form in a capture card.
 */
export default function GitHubAction({
  bugId,
  dark = false,
  onOpenSettings,
}: {
  /** Set once the bug is saved. Null keeps the control disabled. */
  bugId: string | null;
  dark?: boolean;
  onOpenSettings?: () => void;
}) {
  const [config, setConfig] = useState<GitHubConfig | null>(null);
  const [phase, setPhase] = useState<Phase>('unknown');
  const [message, setMessage] = useState<string | null>(null);
  const [issue, setIssue] = useState<{ number: number; url: string; imageWarning?: string } | null>(null);

  useEffect(() => {
    (async () => {
      const c = await loadConfig();
      setConfig(c);
      // A bug that already has an issue shows the link rather than offering to file again.
      const existing = bugId ? (await db.bugs.get(bugId))?.issue : undefined;
      if (existing) {
        setIssue({ number: existing.number, url: existing.url });
        setPhase('done');
        return;
      }
      setPhase(c ? 'ready' : 'unconfigured');
    })();
  }, [bugId]);

  async function push() {
    if (!config || !bugId) return;
    setPhase('pushing');
    setMessage(null);
    const res = await pushOneIssue(bugId, config, setMessage);
    if ('error' in res) {
      setPhase('failed');
      setMessage(res.error);
      return;
    }
    setIssue(res);
    setPhase('done');
    setMessage(res.imageWarning ?? null);
  }

  if (phase === 'unknown') return null;

  const link = dark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700';
  const muted = dark ? 'text-neutral-500' : 'text-neutral-500';
  const button = dark
    ? 'border-neutral-700 bg-neutral-950 text-neutral-200 hover:bg-neutral-800'
    : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50';

  if (phase === 'unconfigured')
    return (
      <p className={`text-[11px] ${muted}`}>
        <button onClick={onOpenSettings} className={`underline ${link}`}>
          Connect a GitHub repo
        </button>{' '}
        to file bugs as issues from here.
      </p>
    );

  if (phase === 'done' && issue)
    return (
      <div>
        <p className="inline-flex items-center gap-1.5 text-[11px] text-emerald-500">
          <Check size={12} strokeWidth={2.5} />
          Filed as
          <a href={issue.url} target="_blank" rel="noreferrer" className={`underline ${link}`}>
            #{issue.number}
          </a>
        </p>
        {message && <p className="mt-1 text-[11px] text-amber-500">{message}</p>}
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={push}
        disabled={!bugId || phase === 'pushing'}
        title={config ? `Create an issue in ${config.owner}/${config.repo}` : undefined}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-40 ${button}`}
      >
        <GitHubMark />
        {phase === 'pushing' ? message ?? 'Creating issue…' : 'Create GitHub issue'}
      </button>

      {config && phase !== 'pushing' && (
        <span className={`text-[11px] ${muted}`}>
          {config.owner}/{config.repo}
        </span>
      )}

      {phase === 'failed' && message && (
        <p className="w-full text-[11px] text-amber-500">{message}</p>
      )}
    </div>
  );
}

/**
 * Files a freshly-saved bug as a GitHub issue, but only when the user has turned that on
 * and a repo is connected. Returns the issue when one was created, otherwise null — a
 * failure here must never block saving the bug locally.
 */
export async function fileBugIfEnabled(
  bugId: string,
): Promise<{ number: number; url: string; imageWarning?: string } | null> {
  try {
    if (!(await loadAutoFile())) return null;
    const config = await loadConfig();
    if (!config) return null;
    const res = await pushOneIssue(bugId, config);
    if ('error' in res) {
      console.warn('[bug-reporter] GitHub issue was not created:', res.error);
      return null;
    }
    if (res.imageWarning) console.warn('[bug-reporter]', res.imageWarning);
    return res;
  } catch (e) {
    console.warn('[bug-reporter] GitHub filing failed:', e);
    return null;
  }
}

/** Opens the dashboard on its GitHub tab, where the repo can be connected. */
export function openGitHubSettings() {
  const url = browser.runtime.getURL('/dashboard.html?tab=github');
  browser.tabs.create({ url }).catch(() => window.open(url, '_blank'));
}
