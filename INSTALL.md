# Session Bug Reporter — Install

Offline bug capture for testing sessions. Everything stays in your browser; nothing is
uploaded unless you explicitly export it or connect GitHub.

Works in **Chrome**, **Brave**, and **Edge**.

## Install

1. Unzip `session-bug-reporter-0.0.0-chrome.zip` somewhere you will keep it.
   **The folder must stay where it is** — deleting it uninstalls the extension.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`)
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder
5. Pin the icon to your toolbar

Chrome shows a *"Disable developer mode extensions"* warning on startup. That is normal for
extensions installed this way — dismiss it.

## Using it

**Start a session** from the extension icon, then browse and test as normal.

**When you find a bug**, click the icon (or press `Ctrl+Shift+K` / `⌘⇧K`) and choose:

- **Quick capture** — point at the problem, say what broke, log it in seconds
- **Detailed capture** — full editor with console, network and reproduction steps

Capture the **selected area**, the **visible page**, or the **full scrolling page**.

Annotate with pencil, arrow, rectangle, ellipse, highlighter and text before saving.

**Everything is captured automatically:** console errors, failed network requests, the steps
you took, browser and screen details.

**Review and export** from the icon → **View session**:

| Tab | What it does |
|---|---|
| Sheet | Searchable table of every bug |
| Document | Readable session report |
| Export | Word (.docx), HTML, Markdown, CSV, JSON |
| GitHub | File bugs as issues, with screenshots |
| Storage | See what space sessions use, delete old ones |

## GitHub (optional)

The extension works fully without it. To file issues directly:

1. Dashboard → **GitHub** tab
2. Paste your repo URL
3. Click **Create a token on GitHub** — the form opens with the right permissions already
   ticked. Pick the repo and generate it.
4. Paste the token back

Tick **File every bug as an issue automatically** if you want each captured bug filed as you go.

Your token is stored locally in this browser and is only ever sent to github.com.

## Known limits

- **Dictation does not work in Brave.** Brave ships without the speech key Chrome's
  dictation relies on, and no setting enables it. Your voice is saved as an audio note
  instead. Use Chrome or Edge if you want spoken descriptions turned into text.
- Full-page capture repeats sticky headers at each stitch boundary — unavoidable when
  scrolling and joining screenshots.
- Screen recording is not built yet.
