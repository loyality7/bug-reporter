/**
 * Drag-to-select overlay, injected on demand. Draws a dimmed backdrop with a clear
 * cut-out and reports the chosen rect in CSS pixels back to whoever asked.
 * Escape or a click without a drag cancels.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
      if (msg?.type !== 'select-region') return;
      selectRegion().then(sendResponse);
      return true; // keep the channel open for the async reply
    });
  },
});

const MIN_SIZE = 8; // smaller than this is a stray click, not a selection

function selectRegion(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    // Shadow DOM so the page's own CSS can't restyle the overlay.
    const root = host.attachShadow({ mode: 'closed' });
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .layer { position: fixed; inset: 0; cursor: crosshair; }
        .dim { position: fixed; background: rgba(15,17,21,.55); }
        .box {
          position: fixed; box-sizing: border-box;
          /* Inset so the line sits inside the selection and leaves no bright sliver. */
          border: 2px solid #22c55e;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.45);
        }

        .hint {
          position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
          background: rgba(20,20,20,.92); color: #fff; padding: 6px 12px; border-radius: 6px;
          font: 500 12px system-ui, sans-serif; white-space: nowrap;
        }
        .size {
          position: fixed; background: rgba(20,20,20,.92); color: #fff; padding: 2px 6px;
          border-radius: 4px; font: 500 11px system-ui, sans-serif; white-space: nowrap;
        }
      </style>
      <div class="layer">
        <div class="dim" id="top"></div><div class="dim" id="bottom"></div>
        <div class="dim" id="left"></div><div class="dim" id="right"></div>
        <div class="box" id="box" hidden></div>
        <div class="size" id="size" hidden></div>
        <div class="hint" id="hint">Drag to select an area · Esc to cancel</div>
      </div>`;
    document.documentElement.appendChild(host);

    const el = (id: string) => root.getElementById(id) as HTMLElement;
    const top = el('top'), bottom = el('bottom'), left = el('left'), right = el('right');
    const box = el('box'), size = el('size'), hint = el('hint');

    let sx = 0, sy = 0, dragging = false;

    // The selection in CSS pixels, kept as numbers rather than read back off the element:
    // the box's outline is drawn outside its bounds, so getBoundingClientRect() would report
    // a rect two pixels larger on every side.
    let selection = { x: 0, y: 0, width: 0, height: 0 };

    /**
     * Four dim panels around the selection leave the chosen area at full brightness.
     *
     * Each panel is pinned by all four edges. Mixing `width`/`height` with `right`/`bottom`
     * previously left stale zero sizes behind, which collapsed the right and bottom panels
     * and made only the top-left look dimmed.
     */
    const paint = (x: number, y: number, w: number, h: number) => {
      selection = { x, y, width: w, height: h };
      box.hidden = false;
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });

      const place = (el: HTMLElement, l: number, t: number, r: number, b: number) =>
        Object.assign(el.style, {
          left: `${l}px`, top: `${t}px`, right: `${r}px`, bottom: `${b}px`,
          width: 'auto', height: 'auto',
        });

      const vw = innerWidth;
      const vh = innerHeight;
      place(top, 0, 0, 0, vh - y);
      place(bottom, 0, y + h, 0, 0);
      place(left, 0, y, vw - x, vh - (y + h));
      place(right, x + w, y, 0, vh - (y + h));
      size.hidden = false;
      size.textContent = `${Math.round(w)}px × ${Math.round(h)}px`;
      // Follow the dragging corner; flip inside when the box runs off-screen.
      const sxPos = Math.min(x + w + 8, innerWidth - 96);
      const syPos = Math.min(y + h - 10, innerHeight - 26);
      Object.assign(size.style, { left: `${sxPos}px`, top: `${syPos}px` });
    };

    // Before any drag the whole page is dimmed by a single panel.
    const reset = () => {
      Object.assign(top.style, { left: '0', top: '0', right: '0', bottom: '0', width: 'auto', height: 'auto' });
      for (const d of [bottom, left, right] as HTMLElement[])
        Object.assign(d.style, { left: '0', top: '0', right: '0', bottom: '100%', width: 'auto', height: 'auto' });
    };
    reset();

    const finish = (result: { x: number; y: number; width: number; height: number } | null) => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(result);
    };

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    }
    window.addEventListener('keydown', onKey, true);

    host.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      hint.hidden = true;
      paint(sx, sy, 0, 0);
    });

    host.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      paint(Math.min(sx, e.clientX), Math.min(sy, e.clientY), Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
    });

    host.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      finish(selection.width >= MIN_SIZE && selection.height >= MIN_SIZE ? selection : null);
    });
  });
}
