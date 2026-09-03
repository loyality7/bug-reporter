import { useEffect, useRef, useState } from 'react';
import { Pencil, ArrowUpRight, Square, Circle, Highlighter, Type, Undo2, Trash2 } from 'lucide-react';

/**
 * Annotation editor over a screenshot. Shapes are kept as data (not baked into the
 * bitmap) so undo is just a pop — flattening happens once, on save.
 */
export type Tool = 'pencil' | 'arrow' | 'rect' | 'ellipse' | 'highlight' | 'text';

type Shape =
  | { tool: 'pencil' | 'highlight'; color: string; width: number; points: [number, number][] }
  | { tool: 'arrow' | 'rect' | 'ellipse'; color: string; width: number; x1: number; y1: number; x2: number; y2: number }
  | { tool: 'text'; color: string; size: number; x: number; y: number; text: string };

// Annotation colors only — chosen to stay legible on light and dark screenshots alike.
const COLORS = ['#e5484d', '#f5a524', '#30a46c', '#0090ff', '#8e4ec6', '#1c2024', '#ffffff'];

const TOOLS: { id: Tool; label: string; Icon: typeof Pencil }[] = [
  { id: 'pencil', label: 'Draw', Icon: Pencil },
  { id: 'arrow', label: 'Arrow', Icon: ArrowUpRight },
  { id: 'rect', label: 'Rectangle', Icon: Square },
  { id: 'ellipse', label: 'Ellipse', Icon: Circle },
  { id: 'highlight', label: 'Highlight', Icon: Highlighter },
  { id: 'text', label: 'Text', Icon: Type },
];

const HIGHLIGHT_ALPHA = 0.35;
const HIGHLIGHT_WIDTH = 18;

export default function Annotator({
  source, onCancel, onSave, dark = false, inline = false, compact = false,
}: {
  source: Blob;
  onCancel: () => void;
  onSave: (annotated: Blob) => void;
  /** Dark chrome for the in-page editor overlay. */
  dark?: boolean;
  /** Inline mode edits in place: every stroke flushes upward, no Apply/Back footer. */
  inline?: boolean;
  /** Fewer, larger targets for the small quick-capture popup. */
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState(COLORS[0]!);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  // Decode once; the <img> is the base layer for every redraw.
  useEffect(() => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => { imgRef.current = img; setReady(true); };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [source]);

  useEffect(() => { if (ready) redraw(); }, [ready, shapes, draft]);

  // Inline editors have no Apply button, so publish the flattened image as it changes.
  useEffect(() => {
    if (!inline || !ready || draft) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const id = setTimeout(() => {
      canvas.toBlob((b) => { if (b) onSave(b); }, 'image/webp', 0.85);
    }, 150);
    return () => clearTimeout(id);
  }, [inline, ready, shapes, draft]);

  function redraw() {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    for (const s of shapes) paint(ctx, s);
    if (draft) paint(ctx, draft);
  }

  /** Canvas coords from a pointer event, accounting for CSS scaling of the canvas. */
  function pos(e: React.PointerEvent): [number, number] {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  }

  function onDown(e: React.PointerEvent) {
    if (!ready) return;
    const [x, y] = pos(e);
    if (tool === 'text') {
      const text = prompt('Label text:')?.trim();
      if (text) setShapes((s) => [...s, { tool: 'text', color, size: Math.round(canvasRef.current!.width / 40), x, y, text }]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = tool === 'highlight' ? HIGHLIGHT_WIDTH : Math.max(2, Math.round(canvasRef.current!.width / 320));
    setDraft(
      tool === 'pencil' || tool === 'highlight'
        ? { tool, color, width, points: [[x, y]] }
        : { tool, color, width, x1: x, y1: y, x2: x, y2: y },
    );
  }

  function onMove(e: React.PointerEvent) {
    if (!draft) return;
    const [x, y] = pos(e);
    setDraft((d) => {
      if (!d) return d;
      if (d.tool === 'pencil' || d.tool === 'highlight') return { ...d, points: [...d.points, [x, y]] };
      if (d.tool === 'text') return d;
      return { ...d, x2: x, y2: y };
    });
  }

  function onUp() {
    const d = draft; // local binding so TS narrows the union (state vars don't narrow)
    if (!d) return;
    // Drop click-without-drag leftovers so a stray tap doesn't add an invisible shape.
    let meaningful = true;
    if (d.tool === 'pencil' || d.tool === 'highlight') meaningful = d.points.length > 1;
    else if (d.tool === 'arrow' || d.tool === 'rect' || d.tool === 'ellipse')
      meaningful = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 4;
    if (meaningful) setShapes((s) => [...s, d]);
    setDraft(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const canvas = canvasRef.current!;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
      onSave(blob ?? source);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex flex-wrap items-center gap-3 rounded-lg p-1.5 ${
        dark ? 'bg-neutral-900' : 'bg-neutral-100'
      }`}>
        <div className="flex items-center gap-0.5">
          {TOOLS.map(({ id, label, Icon }) => {
            const active = tool === id;
            return (
              <button
                key={id}
                title={label}
                aria-label={label}
                aria-pressed={active}
                onClick={() => setTool(id)}
                className={`grid ${compact ? 'h-7 w-7' : 'h-8 w-8'} place-items-center rounded-md transition-colors ${
                  active
                    ? dark ? 'bg-neutral-100 text-neutral-900' : 'bg-neutral-900 text-white'
                    : dark ? 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                           : 'text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900'
                }`}
              >
                <Icon size={15} strokeWidth={2} />
              </button>
            );
          })}
        </div>

        <span className={`h-5 w-px ${dark ? 'bg-neutral-800' : 'bg-neutral-300'}`} />

        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              title={`Color ${c}`}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={`grid h-6 w-6 place-items-center rounded-full transition ${
                color === c ? (dark ? 'ring-2 ring-neutral-100' : 'ring-2 ring-neutral-900') : ''
              }`}
            >
              <span
                style={{ background: c }}
                className={`block h-4 w-4 rounded-full ${
                  c === '#ffffff' ? 'ring-1 ring-inset ring-neutral-400' : ''
                }`}
              />
            </button>
          ))}
        </div>

        <span className={`h-5 w-px ${dark ? 'bg-neutral-800' : 'bg-neutral-300'}`} />

        <div className="flex items-center gap-0.5">
          <button
            title="Undo"
            aria-label="Undo"
            onClick={() => setShapes((s) => s.slice(0, -1))}
            disabled={shapes.length === 0}
            className={`grid ${compact ? 'h-7 w-7' : 'h-8 w-8'} place-items-center rounded-md transition-colors disabled:opacity-30 ${
              dark ? 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                   : 'text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900'
            }`}
          >
            <Undo2 size={15} strokeWidth={2} />
          </button>
          <button
            title="Clear all"
            aria-label="Clear all annotations"
            onClick={() => setShapes([])}
            disabled={shapes.length === 0}
            className={`grid ${compact ? 'h-7 w-7' : 'h-8 w-8'} place-items-center rounded-md transition-colors disabled:opacity-30 ${
              dark ? 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                   : 'text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900'
            }`}
          >
            <Trash2 size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className={`w-full touch-none rounded-lg ${
          dark ? 'bg-neutral-900/60' : 'bg-neutral-100'}`}
        style={{ cursor: 'crosshair', maxHeight: inline ? '46vh' : undefined, objectFit: 'contain' }}
      />

      {!inline && <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm">
          Back
        </button>
        <button
          onClick={save}
          disabled={!ready || saving}
          className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:bg-neutral-300"
        >
          {saving ? 'Applying…' : 'Apply'}
        </button>
      </div>}
    </div>
  );
}

function paint(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.tool === 'text') {
    ctx.font = `600 ${s.size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    // Dark outline keeps light text legible over light screenshots and vice versa.
    ctx.lineWidth = Math.max(2, s.size / 8);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillText(s.text, s.x, s.y);
    ctx.restore();
    return;
  }

  ctx.lineWidth = s.width;
  if (s.tool === 'highlight') ctx.globalAlpha = HIGHLIGHT_ALPHA;

  if (s.tool === 'pencil' || s.tool === 'highlight') {
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  } else if (s.tool === 'rect') {
    ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
  } else if (s.tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === 'arrow') {
    // Arrow: shaft plus a head sized off the stroke width.
    const head = Math.max(10, s.width * 5);
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
