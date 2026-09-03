/**
 * GitHub Device Flow — sign in without a backend and without pasting tokens.
 *
 * Device Flow is the only GitHub OAuth grant that needs no client secret, so the whole
 * exchange happens in the browser and the extension stays backend-free.
 *
 * Register an OAuth App at https://github.com/settings/developers with "Enable Device
 * Flow" ticked, then put its Client ID in CLIENT_ID below. The ID is public by design.
 */
const CLIENT_ID = import.meta.env.WXT_GITHUB_CLIENT_ID ?? '';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Repo scope covers creating issues and committing screenshots to the images branch.
const SCOPE = 'repo';

export const isOAuthConfigured = () => CLIENT_ID.length > 0;

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} requesting a device code.`);
  const d = await res.json();
  if (d.error) throw new Error(d.error_description ?? d.error);
  return {
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    deviceCode: d.device_code,
    interval: d.interval ?? 5,
    expiresIn: d.expires_in ?? 900,
  };
}

/**
 * Polls until the user approves. GitHub answers `authorization_pending` until then, and
 * `slow_down` if we poll too fast — both are normal, not failures.
 */
export async function pollForToken(
  code: DeviceCode,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  let intervalMs = code.interval * 1000;
  const deadline = Date.now() + code.expiresIn * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const d = await res.json();

    if (d.access_token) return d.access_token as string;
    if (d.error === 'authorization_pending') continue;
    if (d.error === 'slow_down') { intervalMs += 5000; continue; }
    if (d.error === 'expired_token') throw new Error('The code expired. Start again.');
    if (d.error === 'access_denied') throw new Error('Sign-in was denied.');
    throw new Error(d.error_description ?? d.error ?? 'Sign-in failed.');
  }
  throw new Error('The code expired. Start again.');
}

/** Repos the signed-in user can actually push to, newest first. */
export async function listRepos(token: string): Promise<{ owner: string; repo: string; fullName: string }[]> {
  const out: { owner: string; repo: string; fullName: string }[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) break;
    const rows = await res.json();
    for (const r of rows)
      if (r.permissions?.push) out.push({ owner: r.owner.login, repo: r.name, fullName: r.full_name });
    if (rows.length < 100) break;
  }
  return out;
}
