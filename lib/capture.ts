import type { Browser } from 'wxt/browser';
import type { Bug, ConsoleEntry, NetworkEntry, StepEntry } from './db';

export interface PageContext {
  url: string;
  pageTitle: string;
  context: Bug['context'];
}

/** Runs in the page. Must be self-contained — it is serialized into the tab. */
function collectFromPage() {
  return {
    url: location.href,
    pageTitle: document.title,
    context: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screen: { width: screen.width, height: screen.height },
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio: devicePixelRatio,
      language: navigator.language,
      online: navigator.onLine,
    },
  };
}

const fallbackContext = (tab?: Browser.tabs.Tab): PageContext => ({
  url: tab?.url ?? '',
  pageTitle: tab?.title ?? '',
  context: {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screen: { width: screen.width, height: screen.height },
    viewport: { width: tab?.width ?? 0, height: tab?.height ?? 0 },
    devicePixelRatio: devicePixelRatio,
    language: navigator.language,
    online: navigator.onLine,
  },
});

/**
 * The web page being tested. Extension pages (popup, dashboard, the overlay iframes) can
 * be the "active tab", so skip them and fall back to the last focused normal page.
 */
export async function activeTab(): Promise<Browser.tabs.Tab | undefined> {
  const capturable = (t: Browser.tabs.Tab) => /^https?:/.test(t.url ?? '');

  const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused && capturable(focused)) return focused;

  // Popup or dashboard was focused — use the active tab of the last normal window.
  const actives = await browser.tabs.query({ active: true });
  const usable = actives.filter(capturable);
  if (usable.length) return usable[usable.length - 1];

  const all = await browser.tabs.query({});
  return all.filter(capturable).pop();
}

export async function capturePageContext(tab?: Browser.tabs.Tab): Promise<PageContext> {
  const target = tab ?? (await activeTab());
  if (!target?.id) return fallbackContext(target);
  try {
    const [res] = await browser.scripting.executeScript({ target: { tabId: target.id }, func: collectFromPage });
    return res?.result ?? fallbackContext(target);
  } catch {
    // Restricted page (chrome://, web store, PDF viewer). Tab metadata is all we get.
    return fallbackContext(target);
  }
}

/** Visible-tab screenshot, re-encoded to WebP to keep IndexedDB small. */
export async function captureScreenshot(tab?: Browser.tabs.Tab): Promise<Blob | undefined> {
  const target = tab ?? (await activeTab());
  if (target?.windowId == null) return undefined;
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(target.windowId, { format: 'png' });
    return await toWebp(dataUrl);
  } catch {
    return undefined;
  }
}

export interface Evidence {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  steps: StepEntry[];
}

const NO_EVIDENCE: Evidence = { console: [], network: [], steps: [] };

/** Pulls the recorder's rolling buffers. Empty when the page blocks content scripts. */
export async function collectEvidence(tab?: Browser.tabs.Tab): Promise<Evidence> {
  const target = tab ?? (await activeTab());
  if (!target?.id) return NO_EVIDENCE;
  try {
    return (await browser.tabs.sendMessage(target.id, { type: 'collect-evidence' })) ?? NO_EVIDENCE;
  } catch {
    return NO_EVIDENCE;
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Asks the page for a drag-selected region. null = user cancelled or the page blocks injection. */
export async function selectRegion(tab?: Browser.tabs.Tab): Promise<Rect | null> {
  const target = tab ?? (await activeTab());
  if (!target?.id) return null;
  try {
    return (await browser.tabs.sendMessage(target.id, { type: 'select-region' })) ?? null;
  } catch {
    return null;
  }
}

/** Screenshot cropped to a CSS-pixel rect. captureVisibleTab returns device pixels, so scale. */
export async function captureRegion(rect: Rect, tab?: Browser.tabs.Tab): Promise<Blob | undefined> {
  const target = tab ?? (await activeTab());
  if (target?.windowId == null) return undefined;
  // Let the selection overlay finish tearing down, or it lands in the screenshot.
  await new Promise((r) => setTimeout(r, 120));
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(target.windowId, { format: 'png' });
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // The capture is the full viewport; derive the device-pixel ratio from its actual width.
    const scale = bitmap.width / (target.width || bitmap.width);
    const sx = Math.round(rect.x * scale);
    const sy = Math.round(rect.y * scale);
    const sw = Math.max(1, Math.round(rect.width * scale));
    const sh = Math.max(1, Math.round(rect.height * scale));
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } catch {
    return undefined;
  }
}

/** Page geometry needed to plan a scrolling capture. Runs inside the tab. */
function readPageMetrics() {
  const doc = document.documentElement;
  return {
    scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
    viewportHeight: innerHeight,
    width: innerWidth,
    originalScrollY: scrollY,
    dpr: devicePixelRatio,
  };
}

/**
 * Full-page screenshot: scroll, capture, stitch.
 *
 * captureVisibleTab only ever sees the viewport, so the page is walked one screen at a
 * time. Chrome caps that call at roughly one per second and *throws* past the limit
 * (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND), so each frame is paced and retried rather
 * than fired as fast as the loop can go.
 *
 * Fixed headers repeat on every slice — unavoidable without hiding them, which would alter
 * the page being reported.
 */
export async function captureFullPage(
  tab?: Browser.tabs.Tab,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob | undefined> {
  const target = tab ?? (await activeTab());
  if (!target?.id || target.windowId == null) return undefined;
  const tabId = target.id;
  const windowId = target.windowId;

  const scrollTo = (top: number) =>
    browser.scripting.executeScript({
      target: { tabId },
      func: (y: number) => { window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }); },
      args: [top],
    });

  let originalScrollY = 0;
  try {
    const [probe] = await browser.scripting.executeScript({ target: { tabId }, func: readPageMetrics });
    const m = probe?.result;
    if (!m) return captureScreenshot(target);
    originalScrollY = m.originalScrollY;

    const steps = Math.min(Math.ceil(m.scrollHeight / m.viewportHeight), MAX_FULLPAGE_STEPS);
    if (steps <= 1) return captureScreenshot(target);

    const slices: { bitmap: ImageBitmap; y: number }[] = [];
    try {
      for (let i = 0; i < steps; i++) {
        const y = i * m.viewportHeight;
        await scrollTo(y);
        // Let sticky elements and lazy images settle before the shot.
        await pause(i === 0 ? 150 : CAPTURE_INTERVAL_MS);

        const dataUrl = await captureWithRetry(windowId);
        if (!dataUrl) break; // quota still refusing — keep the slices already taken

        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        // The final slice overlaps the previous one; clamp so it lands flush with the bottom.
        slices.push({ bitmap, y: Math.min(y, m.scrollHeight - m.viewportHeight) });
        onProgress?.(i + 1, steps);
      }

      if (slices.length === 0) return captureScreenshot(target);

      const scale = slices[0]!.bitmap.width / m.width;
      const covered = Math.min(m.scrollHeight, slices[slices.length - 1]!.y + m.viewportHeight);
      const canvas = new OffscreenCanvas(slices[0]!.bitmap.width, Math.round(covered * scale));
      const ctx = canvas.getContext('2d')!;
      for (const { bitmap, y } of slices) ctx.drawImage(bitmap, 0, Math.round(y * scale));
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    } finally {
      for (const { bitmap } of slices) bitmap.close();
    }
  } catch {
    return captureScreenshot(target);
  } finally {
    // The page must never be left scrolled where the capture stopped.
    await scrollTo(originalScrollY).catch(() => {});
  }
}

/**
 * captureVisibleTab throws once the per-second quota is hit. Back off and try again rather
 * than losing the slice.
 */
async function captureWithRetry(windowId: number, attempts = 3): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      const quota = String((e as Error)?.message ?? e).includes('MAX_CAPTURE_VISIBLE_TAB');
      if (!quota) return undefined;
      await pause(CAPTURE_INTERVAL_MS * (i + 2));
    }
  }
  return undefined;
}

const MAX_FULLPAGE_STEPS = 20; // ponytail: caps very long pages; raise if reports need more
// Chrome allows roughly one captureVisibleTab per second and throws past that.
const CAPTURE_INTERVAL_MS = 1100;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function toWebp(dataUrl: string, quality = 0.85): Promise<Blob> {
  const png = await (await fetch(dataUrl)).blob();
  try {
    const bitmap = await createImageBitmap(png);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality });
  } catch {
    return png;
  }
}
