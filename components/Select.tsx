import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Dropdown that actually respects the theme.
 *
 * A native <select> renders its option list through the OS, so on a dark surface it comes
 * back as a white menu with a blue highlight no CSS can reach. This draws the list itself.
 */
export interface Option<T extends string> {
  value: T;
  label: string;
  /** Optional dot colour, e.g. severity. */
  tone?: string;
}

export function Select<T extends string>({
  value, options, onChange, dark = false, className = '', ariaLabel, drop = 'auto',
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  dark?: boolean;
  className?: string;
  ariaLabel?: string;
  /** 'auto' flips upward only when there is no room below. */
  drop?: 'auto' | 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(drop === 'up');
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  // Decide direction at open time so the list never runs off-screen.
  const toggle = () => {
    if (!open && drop === 'auto') {
      const box = root.current?.getBoundingClientRect();
      const needed = Math.min(options.length * 34 + 8, 240);
      setUp(!!box && box.bottom + needed > window.innerHeight && box.top > needed);
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const trigger = dark
    ? 'border-neutral-700 bg-neutral-950 text-neutral-100 hover:border-neutral-600'
    : 'border-neutral-300 bg-white text-neutral-900 hover:border-neutral-400';

  const menu = dark
    ? 'border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/50'
    : 'border-neutral-200 bg-white shadow-lg shadow-neutral-900/10';

  const itemBase = dark
    ? 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100'
    : 'text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900';

  const itemActive = dark ? 'bg-neutral-800 text-neutral-100' : 'bg-neutral-100 text-neutral-900';

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={`flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-sm transition-colors focus:outline-none ${trigger}`}
      >
        {current?.tone && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: current.tone }} />}
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${dark ? 'text-neutral-500' : 'text-neutral-400'}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className={`absolute z-50 max-h-60 w-full min-w-max overflow-y-auto rounded-lg border p-1 scroll-thin ${
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          } ${menu}`}
        >
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  o.value === value ? itemActive : itemBase
                }`}
              >
                {o.tone && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: o.tone }} />}
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check size={13} strokeWidth={2.5} className="ml-auto shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Severity dots, shared so the sheet, quick card and editor agree. */
export const SEVERITY_TONE: Record<string, string> = {
  low: '#8b8d98',
  medium: '#0090ff',
  high: '#f5a524',
  critical: '#e5484d',
};
