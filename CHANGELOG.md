# Changelog

All notable changes to Chive are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-22

First public release. Chive (ar·chive) is a local web app for archiving
YouTube channels and podcasts — snip the fluff, keep the good stuff.

### YouTube
- Scrape a channel or playlist, or **search by name / `@handle`**, and browse
  it in pages of 50.
- **Click a thumbnail to queue it instantly**; queue or unqueue a whole page.
- **Filter and sort across the entire channel** — title search, duration,
  views, upload date, and six sort orders.
- **SponsorBlock**: remove segments (default) or mark them as chapters.
- **Subtitles**: download and embed captions, kept in sync across cuts.
- Quality presets (4K/1080p/720p, M4A/MP3), library embedding (metadata,
  thumbnail, chapters), cookies for age-restricted videos, and a download
  archive.
- Already-downloaded videos are detected and grayed out.

### Podcasts
- **Search podcasts** (Apple/iTunes directory) and browse a show's episodes.
- **Queue single episodes or the whole feed**; episodes download as-is into
  `<Podcast>/<Episode>`.
- Already-downloaded episodes are grayed out.

### Queue & engine
- Parallel downloads with live per-item progress (percent, speed, ETA) over
  Server-Sent Events, plus aggregate stats (remaining, speed, archived size).
- Pause / resume / cancel / retry, per-item log viewer, reveal-in-folder.
- Progress is driven through yt-dlp's Python API with a flushing hook, so the
  bar streams reliably — including on Windows, where the standalone binary
  buffers its output.
- Served by waitress for robust concurrent requests alongside the live stream.
- Disk-space guard, SSE reconnection indicator, persistent queue and settings.

### Design
- Editorial "Dusk / Dawn" theme with a chive-green + lavender palette, a sprig
  motif, and a few small easter eggs. Fully keyboard-accessible.

### Under the hood
- Three tiers: a Flask/waitress bridge (`server.py`), a no-build SPA
  (`static/`), and local `yt-dlp` + `ffmpeg`.
- Everything runs locally and binds to `127.0.0.1`; no telemetry.
- Offline unit-test suite (`tests/`).
