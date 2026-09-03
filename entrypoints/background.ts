import { activeSession } from '@/lib/db';
import { startCapture, type CaptureArea, type CaptureMode } from '@/lib/startCapture';

/**
 * Capture runs here, never in the popup. Region select needs the user to click into the
 * page, which closes the popup and would kill any promise it was awaiting mid-drag.
 */
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== 'start-capture') return;
    startCapture(msg.sessionId, { mode: msg.mode as CaptureMode, area: msg.area as CaptureArea })
      .then((problem) => sendResponse({ problem }))
      .catch((e) => sendResponse({ problem: String(e?.message ?? e) }));
    return true; // async reply
  });

  // The single shortcut repeats whatever capture style was last used in the popup, so one
  // key covers every mode without competing with the browser for more bindings.
  browser.commands?.onCommand.addListener(async (command) => {
    if (command !== 'capture-bug') return;

    const session = await activeSession();
    if (!session) {
      await browser.action.openPopup().catch(() => {});
      return;
    }

    const stored = await browser.storage.local.get('lastCapture');
    const last = stored.lastCapture as { mode?: CaptureMode; area?: CaptureArea } | undefined;
    await startCapture(session.id, {
      mode: last?.mode ?? 'quick',
      area: last?.area ?? 'region',
    });
  });

  // Tabs opened before install (or before the last reload) are running old content scripts,
  // or none at all — messaging them fails with "Receiving end does not exist". Inject into
  // them once so capture works without asking the user to refresh every tab.
  browser.runtime.onInstalled.addListener(() => void injectIntoOpenTabs());
});

async function injectIntoOpenTabs() {
  const scripts = await browser.scripting.getRegisteredContentScripts().catch(() => []);
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  for (const tab of tabs) {
    if (!tab.id) continue;
    for (const script of scripts) {
      if (!script.js?.length) continue;
      await browser.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: script.allFrames ?? false },
          files: script.js as never,
          world: script.world ?? 'ISOLATED',
        })
        // Restricted pages (web store, PDF viewer) refuse injection; skip them quietly.
        .catch(() => {});
    }
  }
}
