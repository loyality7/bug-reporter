/**
 * Page-world half of the recorder. Patches console, fetch and XHR — these live on the
 * page's own globals, which the isolated content-script world cannot reach.
 *
 * Registered as a MAIN-world content script rather than injected as inline <script> text,
 * because pages with a Content-Security-Policy block inline execution outright.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const emit = (kind: 'console' | 'network', payload: unknown) =>
      window.dispatchEvent(new CustomEvent('__bugreporter_evidence', { detail: { kind, payload } }));

    const render = (a: unknown): string => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    };

    for (const level of ['error', 'warn', 'info', 'log'] as const) {
      const original = console[level];
      console[level] = function (...args: unknown[]) {
        try {
          emit('console', {
            timestamp: Date.now(),
            level,
            message: args.map(render).join(' ').slice(0, 2000),
          });
        } catch { /* never let logging break the page */ }
        return original.apply(this, args as []);
      };
    }

    window.addEventListener('error', (e) =>
      emit('console', {
        timestamp: Date.now(),
        level: 'error',
        message: e.error?.stack ?? `${e.message} @ ${e.filename}:${e.lineno}`,
      }),
    );

    window.addEventListener('unhandledrejection', (e) =>
      emit('console', {
        timestamp: Date.now(),
        level: 'error',
        message: `Unhandled rejection: ${(e.reason as Error)?.stack ?? (e.reason as Error)?.message ?? String(e.reason)}`,
      }),
    );

    const origFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const started = Date.now();
      const [input, init] = args;
      const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input);
      const method = init?.method ?? (input as Request)?.method ?? 'GET';
      try {
        const res = await origFetch.apply(this, args);
        emit('network', {
          timestamp: started, method, url, status: res.status,
          durationMs: Date.now() - started, failed: !res.ok,
        });
        return res;
      } catch (err) {
        emit('network', {
          timestamp: started, method, url, status: 0,
          durationMs: Date.now() - started, failed: true,
        });
        throw err;
      }
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL, ...rest: any[]) {
      this.__br = { method, url: String(url), started: 0 };
      return (origOpen as any).call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (this: any, ...args: any[]) {
      if (this.__br) {
        this.__br.started = Date.now();
        this.addEventListener('loadend', () => {
          emit('network', {
            timestamp: this.__br.started,
            method: this.__br.method,
            url: this.__br.url,
            status: this.status,
            durationMs: Date.now() - this.__br.started,
            failed: this.status === 0 || this.status >= 400,
          });
        });
      }
      return origSend.apply(this, args as []);
    };
  },
});
