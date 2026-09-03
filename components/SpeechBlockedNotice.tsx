import type { SpeechBlocked } from './useVoice';

/**
 * Shown when the speech service is unreachable.
 *
 * Chrome's Web Speech API relies on a Google speech endpoint that needs an API key baked
 * into the browser build. Brave ships without that key, so recognition always fails with
 * `network` there — no setting can turn it on. Say so plainly instead of sending the user
 * to a privacy toggle that will not help.
 */
export default function SpeechBlockedNotice({ blocked, dark = false }: { blocked: SpeechBlocked; dark?: boolean }) {
  const box = dark
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
    : 'border-amber-200 bg-amber-50 text-amber-800';

  return (
    <div className={`mt-2 rounded-md border px-3 py-2 text-[11px] leading-relaxed ${box}`}>
      <p className="font-medium">
        {blocked.isBrave ? 'Brave cannot do speech-to-text' : 'Speech-to-text is unavailable here'}
      </p>
      <p className="mt-1">
        {blocked.isBrave
          ? 'Brave ships without the Google speech key that this feature needs, and no setting can enable it. Your words were saved as audio instead.'
          : 'The browser could not reach its speech service, so your words were saved as audio instead.'}
      </p>
      <p className="mt-1.5">
        For dictation, use Chrome or Edge. Everything else in this extension works the same here —
        you can also type the description, or play the note back and type what you hear.
      </p>
    </div>
  );
}
