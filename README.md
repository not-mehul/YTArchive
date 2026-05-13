# YTArchive

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

1. Paste a channel URL (e.g. `https://www.youtube.com/@channel`) or any
   playlist URL and hit **Fetch**. Videos are pulled in pages of 50.
2. Click thumbnails to mark videos for queueing. Walk pages with the
   arrow buttons.
3. In **Configuration**, tick the SponsorBlock segments you want cut
   and pick a quality preset.
4. Set a **Destination** folder (defaults to `./downloads`).
5. Hit **Queue selected**, then **Start** in the Queue section.
6. Watch the progress bars. Downloads run one at a time so the box
   doesn't melt.

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
- `--sponsorblock-remove <categories>` if any are selected
- `--merge-output-format mp4` for video presets, `--extract-audio` for
  audio presets
- `-o '<dir>/%(uploader)s/%(title)s [%(id)s].%(ext)s'`

`stdout` is parsed line-by-line; progress percent, speed, and ETA are
broadcast to the UI over Server-Sent Events at `/api/events`.

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

## Metadata fixer

`metadata_fixer.py` walks a folder of already-downloaded files and
re-embeds any missing title / uploader / thumbnail / chapter data by
fetching the YouTube info JSON via `yt-dlp` and muxing it in with
`ffmpeg`. Files are identified by the `[VIDEOID]` suffix in their name.

```sh
# dry-run against the default ./downloads folder
python3 metadata_fixer.py --dry-run --verbose

# actually fix
python3 metadata_fixer.py --dir ~/Videos/YT
```

The same routine is reachable from the web UI under
**Housekeeping → Scan / Fix all**, with per-file progress streamed over
SSE.

## Notes

- The bridge binds to `127.0.0.1` by default. Don't expose it on a
  public interface — it shells out to `yt-dlp` with user input.
- Queue, settings, and recent channels persist to
  `~/.ytarchive/state.json` (override with `YTARCHIVE_STATE_DIR`).
  Interrupted downloads come back as **pending** on next launch and
  resume from the `.part` file when restarted.
