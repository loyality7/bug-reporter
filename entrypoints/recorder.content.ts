import type { ConsoleEntry, NetworkEntry, StepEntry } from '@/lib/db';

/**
 * Session recorder. Keeps rolling buffers of console output, network activity and user
 * steps so a bug captured at T carries the evidence that led up to T.
 *
 * Console and fetch/XHR patching runs in the page's own world — see collector.content.ts,
 * a MAIN-world script that reports back here over a CustomEvent. It has to be a registered
 * content script rather than injected inline, because page CSP blocks inline execution.
 */
const LIMIT = 500; // ponytail: fixed ring size, make it a setting if sessions get long

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'ISOLATED',
  main() {
    const consoleLog: ConsoleEntry[] = [];
    const network: NetworkEntry[] = [];
    const steps: StepEntry[] = [];
    const push = <T>(buf: T[], item: T) => { buf.push(item); if (buf.length > LIMIT) buf.shift(); };

    // Events from the page-world collector (collector.content.ts).
    window.addEventListener('__bugreporter_evidence', (e: Event) => {
      const { kind, payload } = (e as CustomEvent).detail ?? {};
      if (kind === 'console') push(consoleLog, payload as ConsoleEntry);
      else if (kind === 'network') push(network, payload as NetworkEntry);
    });

    // Steps are DOM-level, so the isolated world can observe them directly.
    push(steps, { timestamp: Date.now(), type: 'navigate', detail: location.href });

    addEventListener('click', (e) => {
      const t = e.target as Element | null;
      if (t) push(steps, { timestamp: Date.now(), type: 'click', detail: describe(t) });
    }, true);

    addEventListener('keydown', (e) => {
      // Record only navigational/submit keys — never the characters being typed.
      if (['Enter', 'Escape', 'Tab'].includes(e.key))
        push(steps, { timestamp: Date.now(), type: 'keydown', detail: e.key });
    }, true);

    addEventListener('change', (e) => {
      const t = e.target as Element | null;
      // Field identity only. Values may be passwords or personal data.
      if (t) push(steps, { timestamp: Date.now(), type: 'input', detail: `changed ${describe(t)}` });
    }, true);

    // SPA route changes don't fire a page load.
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        push(steps, { timestamp: Date.now(), type: 'navigate', detail: lastUrl });
      }
    }, 500);

    browser.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
      if (msg?.type !== 'collect-evidence') return;
      sendResponse({ console: [...consoleLog], network: [...network], steps: [...steps] });
      return true;
    });
  },
});

/** Short, human-readable identifier for an element: `button#save.primary "Save"`. */
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const text = (el.textContent ?? '').trim().slice(0, 40);
  return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`;
}
