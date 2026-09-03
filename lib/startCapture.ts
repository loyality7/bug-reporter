import { parkCapture } from './db';
import {
  activeTab, capturePageContext, captureScreenshot, captureFullPage, captureRegion,
  selectRegion, collectEvidence,
} from './capture';

export type CaptureMode = 'quick' | 'editor';
export type CaptureArea = 'region' | 'visible' | 'fullpage';

/**
 * One capture path for every entry point (popup button, keyboard shortcut).
 * Grabs the screenshot and all evidence, parks it, then opens the chosen UI over the page.
 * Returns an error string when the page cannot be captured.
 */
/** Injects the registered content scripts into a tab that is missing them. */
async function ensureContentScripts(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'ping' });
    return; // already listening
  } catch {
    // Not loaded — fall through and inject.
  }

  const scripts = await browser.scripting.getRegisteredContentScripts().catch(() => []);
  for (const script of scripts) {
    if (!script.js?.length) continue;
    await browser.scripting
      .executeScript({
        target: { tabId, allFrames: script.allFrames ?? false },
        files: script.js as never,
        world: script.world ?? 'ISOLATED',
      })
      .catch(() => {});
  }
}

export async function startCapture(
  sessionId: string,
  { mode, area }: { mode: CaptureMode; area: CaptureArea },
): Promise<string | null> {
  const { activeSession } = await import('./db');
  const session = await activeSession();
  if (!session || session.id !== sessionId) return 'No active session. Start one first.';

  const tab = await activeTab();
  if (!tab?.id) return 'No web page open to capture.';

  // Extension pages and the web store block content scripts, so the overlay can't mount.
  if (!/^https?:/.test(tab.url ?? '')) return 'This page cannot be captured. Open a normal web page.';

  // A tab opened before the extension loaded has no content scripts, so messaging it fails
  // with "Receiving end does not exist". Inject them now rather than making the user reload.
  await ensureContentScripts(tab.id);

  const [context, evidence] = await Promise.all([capturePageContext(tab), collectEvidence(tab)]);

  let screenshot: Blob | undefined;
  if (area === 'region') {
    const rect = await selectRegion(tab);
    if (!rect) return null; // user cancelled — not an error
    screenshot = await captureRegion(rect, tab);
  } else if (area === 'fullpage') {
    screenshot = await captureFullPage(tab);
  } else {
    screenshot = await captureScreenshot(tab);
  }

  const captureId = await parkCapture({
    sessionId,
    screenshot,
    url: context.url,
    pageTitle: context.pageTitle,
    context: context.context,
    console: evidence.console,
    network: evidence.network,
    steps: evidence.steps,
  });

  await browser.tabs.sendMessage(tab.id, { type: 'open-capture', mode, captureId });
  return null;
}
