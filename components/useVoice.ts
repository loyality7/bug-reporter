import { useEffect, useRef, useState } from 'react';

/**
 * Voice input, speech-to-text first.
 *
 * Dictation is the goal: text in the description beats an audio file nobody replays.
 * But Chrome's Web Speech API streams audio to Google and fails outright in some contexts
 * ("network"), so audio is recorded in parallel and kept ONLY when dictation produced
 * nothing. A successful dictation leaves no stray recording behind.
 */
export type VoiceMode = 'idle' | 'listening' | 'failed';

/**
 * Chrome's Web Speech API needs a Google speech key that Brave does not ship, so recognition
 * there always fails with `network`. Detect that case so the UI can say so plainly rather
 * than silently handing the user an audio file.
 */

export interface SpeechBlocked {
  reason: 'network';
  isBrave: boolean;
}

const isBrave = () =>
  typeof navigator !== 'undefined' && Boolean((navigator as any).brave?.isBrave);

/**
 * Whether dictation has already proved unusable in this browser. Recording audio is only
 * worth doing as a fallback, so once speech is known to be dead the recorder starts with
 * the first capture instead of running pointlessly behind every successful dictation.
 */
let speechKnownDead = isBrave();

export interface VoiceState {
  supported: boolean;
  /** True while listening or recording. */
  active: boolean;
  mode: VoiceMode;
  seconds: number;
  /** Only set when dictation failed and we fell back to keeping the recording. */
  audio: Blob | undefined;
  /** Set once dictation has produced at least one final result this session. */
  gotText: boolean;
  error: string | null;
  /** Set when the speech service itself is unreachable, which is fixable in settings. */
  blocked: SpeechBlocked | null;
  start: () => void;
  stop: () => void;
  discardAudio: () => void;
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

const pickMime = () =>
  typeof MediaRecorder === 'undefined'
    ? undefined
    : MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));

export function useVoice(onTranscript: (text: string) => void): VoiceState {
  const [mode, setMode] = useState<VoiceMode>('idle');
  const [seconds, setSeconds] = useState(0);
  const [audio, setAudio] = useState<Blob>();
  const [gotText, setGotText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<SpeechBlocked | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recognition = useRef<any>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heardText = useRef(false);
  const sttFailed = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const supported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && !!pickMime();

  const releaseMedia = () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    try { recognition.current?.stop(); } catch { /* already stopped */ }
    recognition.current = null;
  };

  useEffect(() => releaseMedia, []);

  async function start() {
    setError(null);
    setBlocked(null);
    setSeconds(0);
    setAudio(undefined);
    heardText.current = false;
    sttFailed.current = false;
    setGotText(false);

    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      chunks.current = [];

      // Only capture audio when dictation cannot deliver text. Where speech works the
      // recording would be thrown away, so there is no reason to make it.
      if (speechKnownDead) {
        const rec = new MediaRecorder(media, { mimeType: pickMime() });
        rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
        rec.onstop = () => {
          if (!heardText.current) setAudio(new Blob(chunks.current, { type: rec.mimeType }));
          chunks.current = [];
          releaseMedia();
          setMode('idle');
        };
        rec.start(1000);
        recorder.current = rec;
      }

      setMode('listening');
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);

      startDictation();
    } catch (e: any) {
      setError(
        e?.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow access in the site settings.'
          : e?.name === 'NotFoundError'
            ? 'No microphone found.'
            : `Could not start: ${e?.message ?? e}`,
      );
      releaseMedia();
      setMode('idle');
    }
  }

  function startDictation() {
    const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Recognition) { sttFailed.current = true; return; }
    try {
      const rec = new Recognition();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = false;
      rec.continuous = true;
      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++)
          if (e.results[i].isFinal) {
            const text = e.results[i][0].transcript.trim();
            if (!text) continue;
            heardText.current = true;
            setGotText(true);
            onTranscriptRef.current(text);
          }
      };
      rec.onerror = (e: any) => {
        sttFailed.current = true;
        if (e?.error === 'not-allowed') setError('Microphone permission denied.');
        else if (e?.error === 'network') {
          // The speech service is unreachable in this browser and will stay that way, so
          // start recording audio from now on.
          speechKnownDead = true;
          setBlocked({ reason: 'network', isBrave: isBrave() });
        }
      };
      recognition.current = rec;
      rec.start();
    } catch {
      sttFailed.current = true;
    }
  }

  function stop() {
    // A blocked speech service gets its own actionable message, rendered separately.
    if (!heardText.current && !sttFailed.current) setError('Nothing was heard.');
    // First failure in a browser we assumed could dictate: nothing was recorded, so say
    // that plainly. `speechKnownDead` is now set, so the next attempt keeps the audio.
    else if (!heardText.current && sttFailed.current && !recorder.current)
      setError('Dictation is unavailable here. Press the mic again to record a voice note instead.');

    // Nothing was recording when dictation was expected to work, so tear down directly.
    if (!recorder.current) {
      releaseMedia();
      setMode('idle');
      return;
    }
    try { recorder.current.stop(); } catch { releaseMedia(); setMode('idle'); }
  }

  return {
    supported,
    active: mode === 'listening',
    mode,
    seconds,
    audio,
    gotText,
    error,
    blocked,
    start,
    stop,
    discardAudio: () => setAudio(undefined),
  };
}

export const fmtDuration = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
