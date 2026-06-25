# Chive 🌱

**ar·chive** — snip the fluff, keep the good stuff.

A local web app for archiving YouTube channels with SponsorBlock segments cut
out automatically. Built as a three-tier system:

- **Frontend** — a single-page UI in `static/` (HTML + CSS + JS, no build step).
- **Bridge** — a Python/Flask server in `server.py` that talks to the UI and
  drives `yt-dlp` subprocesses.
- **Engine** — local `yt-dlp` + `ffmpeg` installations on your `PATH`.

The browser never speaks to YouTube directly; everything routes through
`http://127.0.0.1:8765`.

## Requirements

| Tool       | Why it's needed                              |
| ---------- | -------------------------------------------- |
| `yt-dlp`   | scraping, downloading, SponsorBlock lookup   |
| `ffmpeg`   | muxing video/audio, cutting sponsor segments |
| `python3`  | runs the bridge server                       |

Install them via your package manager:

```sh
# macOS
brew install yt-dlp ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg
pipx install yt-dlp   # or: pip install --user yt-dlp

# Windows (winget)
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Confirm they resolve:

```sh
yt-dlp --version
ffmpeg -version
```

> **Windows: install yt-dlp with pip.** The server prefers running yt-dlp as a
> module (`python -m yt_dlp`) over the standalone `yt-dlp.exe`, because the
> frozen Windows binary buffers its progress output and never flushes it —
> making downloads appear to jump straight from 0% to 100% with no live speed
> or ETA. `pip install -r requirements.txt` (which now includes `yt-dlp`) into
> the same environment that runs the server gives you live progress. The
> Settings → *Engine & storage* panel shows whether the **module** or **binary**
> is in use.

## Running

```sh
python3 -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python3 server.py
```

Then open <http://127.0.0.1:8765>.

Environment overrides (optional):

```sh
YTARCHIVE_HOST=127.0.0.1 YTARCHIVE_PORT=8765 python3 server.py
```

## Using it

1. In **Source**, paste a channel/playlist URL, an `@handle`, or just type
   a channel **name** to search and pick from the results. Hit **Fetch**.
   Videos are pulled in pages of 50.
2. **Click a thumbnail to queue it instantly** (click again to remove it).
   The page-actions let you queue or unqueue a whole page at once. Use the
   filter/sort bar to **search titles, filter by duration/views/date, and
   sort across the whole channel**.
3. Open **Settings** (the gear, top-right) to configure everything: SponsorBlock
   segments and **Remove** vs **Mark as chapters**, quality preset, **Subtitles**,
   library embedding, cookies, concurrency/archive, the **download path**, the
   yt-dlp/ffmpeg versions (with an **Update yt-dlp** button), and free disk.
4. Hit **Start** in the Queue section.
5. Watch live progress and the **aggregate stats** (remaining, speed, archived
   size, ETA). Each row has a **log** button to inspect the full yt-dlp output;
   failed items can be diagnosed without re-running in a terminal.

> **Beyond YouTube.** This started as a YouTube channel archiver and is being
> generalised into a broader archival tool (podcasts, music, …). The bridge
> already drives `yt-dlp`, which supports many sources; source-specific
> features (SponsorBlock, Shorts) are scoped to YouTube.

## How it works

### Scraping
`POST /api/scrape` calls
`yt-dlp --flat-playlist --dump-json --playlist-items <start>:<end> <url>`
and parses one JSON entry per line. Only metadata is fetched at this
stage — no video bytes leave YouTube's servers until you queue
something.

### Downloading
Each queued item becomes a `yt-dlp` subprocess with:

- `-f <format>` mapped from the quality preset
- `--sponsorblock-remove <categories>` (cut) or `--sponsorblock-mark`
  (label as chapters) when categories are selected
- `--write-subs`/`--embed-subs` (with `--sub-langs`) when subtitles are on —
  embedding keeps captions aligned when segments are cut
- `--merge-output-format mp4` for video presets, `--extract-audio` for
  audio presets
- `-o '<dir>/%(uploader)s/%(title)s [%(id)s].%(ext)s'`

When the `yt_dlp` module is importable, downloads run through
`ytdlp_runner.py`, which drives yt-dlp via its Python API and emits progress
from a `progress_hooks` callback with an explicit `flush()`. This is the only
thing that streams progress reliably on Windows, where yt-dlp buffers its own
stdout and the bar would otherwise jump straight to 100%. (Without the module,
it falls back to the `yt-dlp` binary + `--progress-template`.) Progress
percent, speed, ETA and byte counts are broadcast to the UI over Server-Sent
Events at `/api/events`, and retained per item for the in-app log viewer.

The server runs under **waitress** when available, which serves concurrent
requests reliably while the SSE stream is open (the Flask dev server can drop
a request mid-download); it falls back to the dev server otherwise. A live
connection pill, disk-space guard, and aggregate queue stats round out the
monitoring.

### Tests
`python3 -m unittest discover -s tests` — offline unit tests (yt-dlp is
mocked) covering the Shorts heuristic, progress parsing, scrape pagination
and whole-channel filter/sort, command building (SponsorBlock modes,
subtitles), source validation, and the byte helpers.

### SponsorBlock categories
| Key              | Meaning                       |
| ---------------- | ----------------------------- |
| `sponsor`        | paid promotion                |
| `selfpromo`      | the creator's own merch / Patreon |
| `interaction`    | "like and subscribe" prompts  |
| `intro`          | bumper / channel intro        |
| `outro`          | end-card music                |
| `preview`        | recap / "coming up" segments  |
| `filler`         | tangents, off-topic asides    |
| `music_offtopic` | music in non-music videos     |

## Layout

```
.
├── server.py             # Flask bridge
├── requirements.txt
├── static/
│   ├── index.html        # SPA shell
│   ├── style.css         # Editorial Dusk theme
│   └── app.js            # SSE client, grid, queue
└── downloads/            # default output (created on first run)
```

## Notes

- The bridge binds to `127.0.0.1` by default. Don't expose it on a
  public interface — it shells out to `yt-dlp` with user input.
- Queue, settings, and recent channels persist to
  `~/.ytarchive/state.json` (override with `YTARCHIVE_STATE_DIR`).
  Interrupted downloads come back as **pending** on next launch and
  resume from the `.part` file when restarted.
