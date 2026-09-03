# Session Bug Reporter

Offline, session-based bug capture browser extension. No account, no backend, no API keys, no AI.
Everything stays in your browser until you explicitly export it.

## Run it

```bash
npm install
npm run dev      # launches Chrome with the extension loaded, hot reload
npm run build    # production build -> .output/chrome-mv3
npm test         # export-layer self-check
```

To load a production build manually: `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `.output/chrome-mv3`.

## Workflow

1. Click the extension icon (or `Ctrl+Shift+B`) → **Start New Session**.
2. Browse and test normally. When something breaks, open the popup → **Capture Bug**.
   The screenshot and page context are grabbed immediately; you just type a title and description.
   `Ctrl+Enter` saves.
3. Every bug appends to the same active session.
4. **View Sheet** / **View Document** opens the dashboard — a searchable, filterable bug table and a
   readable session report, both generated from the same records.
5. **Export** tab → JSON, Markdown, HTML, CSV, or GitHub issue payloads.

## Architecture

One data model, many views — the sheet, the document and every export read the same records.

```
lib/db.ts          Dexie/IndexedDB schema. Bug metadata and Evidence blobs are separate tables.
lib/capture.ts     Screenshot (WebP) + page context. Degrades gracefully on restricted pages.
lib/export.ts      JSON / Markdown / HTML / CSV / GitHub adapters. Pure functions over a bundle.
entrypoints/popup      Home, active session, fast capture.
entrypoints/dashboard  Sheet view, document view, export panel.
```

Screenshots are stored as WebP Blobs (not base64) in their own table, so the bug list stays cheap to query.

## Scope

Built: session capture, screenshots, console and network capture, user-step tracking,
screenshot annotation, voice notes and transcription, exports (JSON, Markdown, HTML, CSV,
Word) and direct GitHub issue creation.

Not yet built: screen recording. The capture and export layers are modular, so it slots in
without touching the data model.
