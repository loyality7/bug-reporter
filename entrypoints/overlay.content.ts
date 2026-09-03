/**
 * Hosts the capture UI over the current page — quick card or full editor — so the
 * user never leaves the tab they are testing.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
      // Lets the background check whether this tab already has the scripts.
      if (msg?.type === 'ping') { sendResponse({ ready: true }); return; }
      if (msg?.type === 'open-capture') open(msg.mode, msg.captureId);
      if (msg?.type === 'close-capture') close();
    });

    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data;
      if (d?.__bugreporter !== 'quick' && d?.__bugreporter !== 'editor') return;
      if (d.action === 'close' || d.action === 'saved') {
        close();
        if (d.action === 'saved')
          toast(d.issue ? `Bug logged · issue #${d.issue.number}` : 'Bug logged', d.issue?.url);
      }
      // Quick escalating to the detailed editor: swap the frame, keep the capture.
      if (d.action === 'expand') open('editor', d.captureId);
    });
  },
});

const HOST_ID = '__bugreporter_host';

function close() {
  document.getElementById(HOST_ID)?.remove();
}

function open(mode: 'quick' | 'editor', captureId: string) {
  close();
  const host = document.createElement('div');
  host.id = HOST_ID;

  const frame = document.createElement('iframe');
  frame.src = browser.runtime.getURL(`/${mode}.html?capture=${encodeURIComponent(captureId)}`);
  frame.allow = 'microphone';
  frame.style.cssText = 'border:0;width:100%;height:100%;background:transparent;color-scheme:dark';

  if (mode === 'quick') {
    // Small card in the corner — the page stays visible and usable behind it.
    host.style.cssText =
      'position:fixed;right:20px;bottom:20px;width:440px;height:min(600px,86vh);z-index:2147483647;' +
      'border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);' +
      'box-shadow:0 24px 64px -12px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.25)';
  } else {
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(10,10,12,.82);backdrop-filter:blur(2px)';
  }

  host.appendChild(frame);
  document.documentElement.appendChild(host);
}

function toast(text: string, href?: string) {
  const el = document.createElement(href ? 'a' : 'div');
  el.textContent = text;
  if (href && el instanceof HTMLAnchorElement) {
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener';
    el.style.textDecoration = 'none';
  }
  el.style.cssText =
    'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#18181b;color:#fafafa;' +
    'padding:10px 16px;border-radius:8px;font:500 13px system-ui,sans-serif;' +
    'border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 32px -8px rgba(0,0,0,.5)';
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), href ? 6000 : 2200);
}
