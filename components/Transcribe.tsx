import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { db } from '@/lib/db';
import { Button } from '@/components/ui';
import SpeechBlockedNotice from '@/components/SpeechBlockedNotice';
import type { SpeechBlocked } from '@/components/useVoice';

/**
 * Second chance at transcribing a voice note.
 *
 * The browser's speech API has no file input — it only listens to a live mic — so the
 * recording is played back through a speaker while recognition listens. Crude, but it needs
 * no model download and no cloud service, and it usually succeeds in a normal tab even when
 * it failed inside the capture overlay.
 */
export default function Transcribe({
  bugId,
  audio,
  onText,
}: {
  bugId: string;
  audio: Blob;
  onText?: (text: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<SpeechBlocked | null>(null);
  const recognition = useRef<any>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  const Recognition =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
      : undefined;

  useEffect(() => () => stop(), []);

  function stop() {
    try { recognition.current?.stop(); } catch { /* already stopped */ }
    recognition.current = null;
    player.current?.pause();
    player.current = null;
  }

  async function finish(text: string) {
    stop();
    if (!text.trim()) {
      setState('failed');
      setError('Nothing could be transcribed. Play the note and type it manually.');
      return;
    }
    // Append rather than replace: the description may already hold typed notes.
    const bug = await db.bugs.get(bugId);
    const existing = bug?.description?.trim();
    const merged = existing ? `${existing}\n\n${text.trim()}` : text.trim();
    await db.bugs.update(bugId, { description: merged });
    onText?.(text.trim());
    setState('done');
  }

  function start() {
    if (!Recognition) return;
    setState('running');
    setError(null);
    setBlocked(null);
    setHeard('');

    let collected = '';
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) collected += (collected ? ' ' : '') + text.trim();
        else interim += text;
      }
      setHeard((collected + ' ' + interim).trim());
    };

    rec.onerror = (e: any) => {
      stop();
      setState('failed');
      if (e?.error === 'network') {
        // The speech service itself is unreachable; the notice explains how to enable it.
        setBlocked({ reason: 'network', isBrave: Boolean((navigator as any).brave?.isBrave) });
        return;
      }
      setError(
        e?.error === 'not-allowed'
          ? 'Microphone permission is required — the browser listens through the mic while the note plays.'
          : `Transcription failed: ${e?.error ?? 'unknown error'}`,
      );
    };

    recognition.current = rec;
    rec.start();

    // Play the note out loud so recognition can hear it.
    const url = URL.createObjectURL(audio);
    const el = new Audio(url);
    el.volume = 1;
    el.onended = () => {
      URL.revokeObjectURL(url);
      // Give recognition a moment to flush its final result.
      setTimeout(() => finish(collected), 1200);
    };
    el.play().catch(() => {
      stop();
      setState('failed');
      setError('Could not play the recording back.');
    });
    player.current = el;
  }

  // Brave has the API but no speech key behind it, so a retry can only ever fail.
  const isBrave = Boolean((navigator as any).brave?.isBrave);
  if (!Recognition || isBrave)
    return (
      <p className="mt-2 text-xs text-neutral-500">
        {isBrave
          ? 'Brave cannot transcribe audio. Open this session in Chrome or Edge to transcribe, or play the note and type what you hear.'
          : 'This browser has no speech recognition, so the note cannot be transcribed automatically.'}
      </p>
    );

  return (
    <div className="mt-2">
      {state === 'running' ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => finish(heard)}>
            <Square size={12} strokeWidth={2.5} fill="currentColor" />
            Stop and keep
          </Button>
          <p className="mt-1.5 text-xs text-neutral-500">
            Playing the note aloud and listening. Keep the sound on.
          </p>
          {heard && <p className="mt-1 text-xs italic text-neutral-600">“{heard}”</p>}
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={start}>
          <Mic size={12} strokeWidth={2} />
          {state === 'done' ? 'Transcribe again' : 'Transcribe to text'}
        </Button>
      )}

      {state === 'done' && <p className="mt-1.5 text-xs text-emerald-700">Added to the description.</p>}
      {error && <p className="mt-1.5 text-xs text-amber-700">{error}</p>}
      {blocked && <SpeechBlockedNotice blocked={blocked} />}
    </div>
  );
}
