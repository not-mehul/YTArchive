"""YTArchive bridge server.

A local Flask server that drives yt-dlp for channel scraping and
SponsorBlock-aware downloads. The single-page UI in `static/index.html`
talks to this server over JSON + Server-Sent Events.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_DOWNLOAD_DIR = ROOT / "downloads"
DEFAULT_DOWNLOAD_DIR.mkdir(exist_ok=True)

STATE_DIR = Path(os.environ.get("YTARCHIVE_STATE_DIR") or (Path.home() / ".ytarchive"))
STATE_FILE = STATE_DIR / "state.json"
STATE_VERSION = 1
HISTORY_MAX = 10

SCRAPE_PAGE_SIZE = 50

IS_WINDOWS = os.name == "nt"

# Categories yt-dlp can *remove* via --sponsorblock-remove. `poi_highlight` is a
# single point-of-interest marker rather than a removable span, so it is
# deliberately excluded — passing it to --sponsorblock-remove is a no-op.
SPONSORBLOCK_CATEGORIES = {
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
    "preview",
    "filler",
    "music_offtopic",
}

QUALITY_PRESETS: dict[str, dict[str, Any]] = {
    "4k": {
        "label": "4K",
        "format": "bv*[height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height<=2160]+ba/b[height<=2160]",
        "merge_output_format": "mp4",
        "audio_only": False,
    },
    "1080p": {
        "label": "1080p",
        "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]",
        "merge_output_format": "mp4",
        "audio_only": False,
    },
    "720p": {
        "label": "720p",
        "format": "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]",
        "merge_output_format": "mp4",
        "audio_only": False,
    },
    "m4a": {
        "label": "Audio · M4A",
        "format": "ba[ext=m4a]/ba",
        "audio_only": True,
        "audio_format": "m4a",
    },
    "mp3": {
        "label": "Audio · MP3",
        "format": "ba/b",
        "audio_only": True,
        "audio_format": "mp3",
    },
}

MAX_CONCURRENCY = 4

# yt-dlp supports cookies via --cookies-from-browser. Whitelist the values it
# accepts so the UI can offer a closed dropdown rather than free text.
COOKIE_BROWSERS = (
    "brave", "chrome", "chromium", "edge", "firefox",
    "opera", "safari", "vivaldi", "whale",
)


# ---------------------------------------------------------------------------
# Queue data model
# ---------------------------------------------------------------------------


@dataclass
class QueueItem:
    id: str
    video_id: str
    url: str
    title: str
    thumbnail: str | None
    duration: int | None
    quality: str
    sponsorblock: list[str]
    status: str = "pending"  # pending | downloading | paused | completed | failed | cancelled
    progress: float = 0.0
    speed: str | None = None
    eta: str | None = None
    message: str | None = None
    output_file: str | None = None
    added_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=str)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {}
    try:
        with STATE_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


# ---------------------------------------------------------------------------
# Manager: thread-safe queue + worker pool + event broadcaster
# ---------------------------------------------------------------------------


class QueueManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, QueueItem] = {}
        self._order: list[str] = []
        self._wake = threading.Event()
        self._listeners: list[queue.Queue[str]] = []
        self._listeners_lock = threading.Lock()
        self._running = False
        self._active_procs: dict[str, subprocess.Popen] = {}
        self._dispatched: set[str] = set()
        self._pausing: set[str] = set()
        self._download_dir: Path = DEFAULT_DOWNLOAD_DIR
        self._concurrency: int = 1
        self._embed_metadata: bool = True
        self._embed_thumbnail: bool = True
        self._embed_chapters: bool = True
        self._use_archive: bool = False
        self._cookies_browser: str = ""
        self._cookies_file: str = ""
        self._history: list[str] = []
        self._last_quality: str = "1080p"
        self._last_sponsorblock: list[str] = ["sponsor", "selfpromo"]
        self._persist_dirty = False
        self._load_persisted()
        self._dispatcher = threading.Thread(target=self._dispatch_loop, daemon=True)
        self._dispatcher.start()

    # ----- persistence -------------------------------------------------

    def _load_persisted(self) -> None:
        data = _load_state()
        if not data:
            return
        dl = data.get("download_dir")
        if isinstance(dl, str):
            try:
                p = Path(dl).expanduser()
                p.mkdir(parents=True, exist_ok=True)
                self._download_dir = p.resolve()
            except OSError:
                pass
        try:
            self._concurrency = max(1, min(MAX_CONCURRENCY, int(data.get("concurrency", 1))))
        except (TypeError, ValueError):
            self._concurrency = 1
        self._embed_metadata = bool(data.get("embed_metadata", True))
        self._embed_thumbnail = bool(data.get("embed_thumbnail", True))
        self._embed_chapters = bool(data.get("embed_chapters", True))
        self._use_archive = bool(data.get("use_archive", False))
        cb = data.get("cookies_browser")
        if isinstance(cb, str) and cb in COOKIE_BROWSERS:
            self._cookies_browser = cb
        cf = data.get("cookies_file")
        if isinstance(cf, str):
            self._cookies_file = cf
        hist = data.get("history") or []
        if isinstance(hist, list):
            self._history = [h for h in hist if isinstance(h, str)][:HISTORY_MAX]
        lq = data.get("last_quality")
        if isinstance(lq, str) and lq in QUALITY_PRESETS:
            self._last_quality = lq
        lsb = data.get("last_sponsorblock")
        if isinstance(lsb, list):
            self._last_sponsorblock = [c for c in lsb if c in SPONSORBLOCK_CATEGORIES]
        items = data.get("queue") or []
        if isinstance(items, list):
            for raw in items:
                if not isinstance(raw, dict):
                    continue
                try:
                    item = QueueItem(
                        id=str(raw.get("id") or uuid.uuid4()),
                        video_id=str(raw["video_id"]),
                        url=str(raw["url"]),
                        title=str(raw.get("title") or raw["video_id"]),
                        thumbnail=raw.get("thumbnail"),
                        duration=raw.get("duration"),
                        quality=str(raw.get("quality") or self._last_quality),
                        sponsorblock=[c for c in (raw.get("sponsorblock") or []) if c in SPONSORBLOCK_CATEGORIES],
                        status=str(raw.get("status") or "pending"),
                        progress=float(raw.get("progress") or 0.0),
                        speed=raw.get("speed"),
                        eta=raw.get("eta"),
                        message=raw.get("message"),
                        output_file=raw.get("output_file"),
                        added_at=float(raw.get("added_at") or time.time()),
                        started_at=raw.get("started_at"),
                        finished_at=raw.get("finished_at"),
                    )
                except (KeyError, TypeError, ValueError):
                    continue
                # interrupted downloads come back as pending so they can resume
                if item.status == "downloading":
                    item.status = "pending"
                    item.progress = 0.0
                    item.speed = None
                    item.eta = None
                    item.message = "Restored — will resume"
                self._items[item.id] = item
                self._order.append(item.id)

    def _persist_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "version": STATE_VERSION,
                "download_dir": str(self._download_dir),
                "concurrency": self._concurrency,
                "embed_metadata": self._embed_metadata,
                "embed_thumbnail": self._embed_thumbnail,
                "embed_chapters": self._embed_chapters,
                "use_archive": self._use_archive,
                "cookies_browser": self._cookies_browser,
                "cookies_file": self._cookies_file,
                "history": list(self._history),
                "last_quality": self._last_quality,
                "last_sponsorblock": list(self._last_sponsorblock),
                "queue": [asdict(self._items[i]) for i in self._order],
            }

    def _persist(self) -> None:
        try:
            _atomic_write_json(STATE_FILE, self._persist_snapshot())
        except OSError as exc:
            print(f"[ytarchive] could not persist state: {exc}", file=sys.stderr)

    # ----- settings ----------------------------------------------------

    def set_download_dir(self, path: str) -> Path:
        p = Path(path).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._download_dir = p
        self._broadcast({"type": "settings", "download_dir": str(p)})
        self._persist()
        return p

    def set_concurrency(self, n: int) -> int:
        n = max(1, min(MAX_CONCURRENCY, int(n)))
        with self._lock:
            self._concurrency = n
        self._broadcast({"type": "settings", "concurrency": n})
        self._persist()
        self._wake.set()
        return n

    def set_embed(self, metadata: bool, thumbnail: bool, chapters: bool) -> None:
        with self._lock:
            self._embed_metadata = bool(metadata)
            self._embed_thumbnail = bool(thumbnail)
            self._embed_chapters = bool(chapters)
        self._broadcast({
            "type": "settings",
            "embed_metadata": metadata,
            "embed_thumbnail": thumbnail,
            "embed_chapters": chapters,
        })
        self._persist()

    def set_cookies(self, browser: str | None, file: str | None) -> None:
        with self._lock:
            if browser is not None:
                b = (browser or "").strip().lower()
                self._cookies_browser = b if b in COOKIE_BROWSERS else ""
            if file is not None:
                self._cookies_file = (file or "").strip()
        self._broadcast({
            "type": "settings",
            "cookies_browser": self._cookies_browser,
            "cookies_file": self._cookies_file,
        })
        self._persist()

    def set_use_archive(self, enabled: bool) -> None:
        with self._lock:
            self._use_archive = bool(enabled)
        self._broadcast({"type": "settings", "use_archive": bool(enabled)})
        self._persist()

    def push_history(self, url: str) -> None:
        url = (url or "").strip()
        if not url:
            return
        with self._lock:
            self._history = [url] + [h for h in self._history if h != url]
            self._history = self._history[:HISTORY_MAX]
        self._broadcast({"type": "settings", "history": list(self._history)})
        self._persist()

    def remember_choices(self, quality: str | None, sponsorblock: list[str] | None) -> None:
        changed = False
        with self._lock:
            if quality and quality in QUALITY_PRESETS and quality != self._last_quality:
                self._last_quality = quality
                changed = True
            if sponsorblock is not None:
                clean = sorted([c for c in sponsorblock if c in SPONSORBLOCK_CATEGORIES])
                if clean != sorted(self._last_sponsorblock):
                    self._last_sponsorblock = clean
                    changed = True
        if changed:
            self._persist()

    @property
    def download_dir(self) -> Path:
        with self._lock:
            return self._download_dir

    def settings(self) -> dict[str, Any]:
        with self._lock:
            return {
                "download_dir": str(self._download_dir),
                "concurrency": self._concurrency,
                "max_concurrency": MAX_CONCURRENCY,
                "embed_metadata": self._embed_metadata,
                "embed_thumbnail": self._embed_thumbnail,
                "embed_chapters": self._embed_chapters,
                "use_archive": self._use_archive,
                "cookies_browser": self._cookies_browser,
                "cookies_file": self._cookies_file,
                "cookie_browsers": list(COOKIE_BROWSERS),
                "history": list(self._history),
                "last_quality": self._last_quality,
                "last_sponsorblock": list(self._last_sponsorblock),
            }

    # ----- queue mutation ---------------------------------------------

    def add(
        self,
        videos: list[dict[str, Any]],
        quality: str,
        sponsorblock: list[str],
    ) -> list[QueueItem]:
        if quality not in QUALITY_PRESETS:
            raise ValueError(f"unknown quality preset: {quality}")
        clean_sb = [c for c in sponsorblock if c in SPONSORBLOCK_CATEGORIES]
        added: list[QueueItem] = []
        with self._lock:
            # Dedup against any non-completed item already in the queue. A
            # previously failed/cancelled video should be re-run via Retry
            # rather than spawning a duplicate row; completed items may be
            # re-queued for a fresh download.
            existing_video_ids = {
                self._items[i].video_id
                for i in self._order
                if self._items[i].status != "completed"
            }
            for v in videos:
                vid = v.get("video_id") or v.get("id")
                if not vid or vid in existing_video_ids:
                    continue
                item = QueueItem(
                    id=str(uuid.uuid4()),
                    video_id=vid,
                    url=v.get("url") or f"https://www.youtube.com/watch?v={vid}",
                    title=v.get("title") or vid,
                    thumbnail=v.get("thumbnail"),
                    duration=v.get("duration"),
                    quality=quality,
                    sponsorblock=clean_sb,
                )
                self._items[item.id] = item
                self._order.append(item.id)
                existing_video_ids.add(vid)
                added.append(item)
        for item in added:
            self._broadcast({"type": "queued", "item": asdict(item)})
        if added:
            self.remember_choices(quality, clean_sb)
            self._persist()
            self._wake.set()
        return added

    def remove(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item:
                return False
            if item.status == "downloading":
                return False
            if item_id in self._order:
                self._order.remove(item_id)
            self._items.pop(item_id, None)
        self._broadcast({"type": "removed", "id": item_id})
        self._persist()
        return True

    def retry(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item:
                return False
            if item.status not in {"failed", "cancelled"}:
                return False
            item.status = "pending"
            item.progress = 0.0
            item.speed = None
            item.eta = None
            item.message = None
            item.started_at = None
            item.finished_at = None
            snap = asdict(item)
        self._broadcast({"type": "update", "item": snap})
        self._persist()
        self._wake.set()
        return True

    def clear_finished(self) -> int:
        removed = 0
        with self._lock:
            keep: list[str] = []
            for iid in self._order:
                it = self._items[iid]
                if it.status in {"completed", "failed", "cancelled"}:
                    self._items.pop(iid, None)
                    removed += 1
                else:
                    keep.append(iid)
            self._order = keep
        if removed:
            self._broadcast({"type": "cleared"})
            self._persist()
        return removed

    def cancel_current(self) -> int:
        with self._lock:
            procs = list(self._active_procs.values())
        cancelled = 0
        for proc in procs:
            if _terminate_proc(proc):
                cancelled += 1
        return cancelled

    def cancel_item(self, item_id: str) -> bool:
        with self._lock:
            proc = self._active_procs.get(item_id)
        if proc is None:
            return False
        return _terminate_proc(proc)

    def pause_item(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item:
                return False
            proc = self._active_procs.get(item_id)
            if proc is None:
                # Not currently downloading — pause it in place if pending.
                if item.status == "pending":
                    item.status = "paused"
                    item.message = "Paused"
                    snap = asdict(item)
                else:
                    return False
            else:
                self._pausing.add(item_id)
                snap = None
        if snap is not None:
            self._broadcast({"type": "update", "item": snap})
            self._persist()
            return True
        return _terminate_proc(proc)

    def resume_item(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item or item.status != "paused":
                return False
            item.status = "pending"
            item.message = "Resuming"
            # Keep the last known percent so the bar holds its place until
            # yt-dlp emits a real progress line off the .part file, instead of
            # snapping back to 0%. The stale speed/eta are cleared.
            item.speed = None
            item.eta = None
            item.finished_at = None
            snap = asdict(item)
        self._broadcast({"type": "update", "item": snap})
        self._persist()
        self._wake.set()
        return True

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [asdict(self._items[i]) for i in self._order]

    def start(self) -> None:
        with self._lock:
            self._running = True
        self._wake.set()
        self._broadcast({"type": "state", "running": True})

    def pause(self) -> None:
        with self._lock:
            self._running = False
        self._broadcast({"type": "state", "running": False})

    def is_running(self) -> bool:
        with self._lock:
            return self._running

    # ----- SSE listeners -----------------------------------------------

    def listen(self) -> queue.Queue[str]:
        q: queue.Queue[str] = queue.Queue(maxsize=512)
        with self._listeners_lock:
            self._listeners.append(q)
        return q

    def drop(self, q: queue.Queue[str]) -> None:
        with self._listeners_lock:
            if q in self._listeners:
                self._listeners.remove(q)

    def _broadcast(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, default=str)
        with self._listeners_lock:
            listeners = list(self._listeners)
        for q in listeners:
            try:
                q.put_nowait(data)
            except queue.Full:
                # The listener is draining slower than we produce (a backgrounded
                # tab, a slow machine). Evict the OLDEST queued event and retry so
                # the newest event survives — crucially the terminal status
                # updates (completed/failed/cancelled), which would otherwise be
                # lost and leave a row stuck mid-download. Progress events are
                # throttled and newest-wins, so dropping an older one is harmless.
                try:
                    q.get_nowait()
                    q.put_nowait(data)
                except (queue.Empty, queue.Full):
                    pass

    # ----- dispatcher + workers ----------------------------------------

    def _dispatch_loop(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            while True:
                spawned = False
                with self._lock:
                    if not self._running:
                        break
                    if len(self._active_procs) + len(self._dispatched) >= self._concurrency:
                        break
                    next_item: QueueItem | None = None
                    for iid in self._order:
                        it = self._items[iid]
                        if (
                            it.status == "pending"
                            and iid not in self._active_procs
                            and iid not in self._dispatched
                        ):
                            next_item = it
                            break
                    if next_item is None:
                        break
                    self._dispatched.add(next_item.id)
                    spawned = True
                if spawned and next_item is not None:
                    t = threading.Thread(target=self._process, args=(next_item,), daemon=True)
                    t.start()
                if not spawned:
                    break

    def _process(self, item: QueueItem) -> None:
        with self._lock:
            item.status = "downloading"
            item.started_at = time.time()
        self._broadcast({"type": "update", "item": asdict(item)})

        cmd = self._build_command(item)
        popen_kwargs: dict[str, Any] = dict(
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        if IS_WINDOWS:
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True

        try:
            proc = subprocess.Popen(cmd, **popen_kwargs)
        except FileNotFoundError:
            with self._lock:
                self._dispatched.discard(item.id)
            self._finish(item, "failed", "yt-dlp not found on PATH")
            self._wake.set()
            return
        with self._lock:
            self._active_procs[item.id] = proc
            self._dispatched.discard(item.id)

        last_emit = 0.0
        last_progress = -1.0
        last_message: str | None = None
        archived = False
        assert proc.stdout is not None
        try:
            for raw in proc.stdout:
                line = raw.rstrip("\n")
                if "has already been recorded in the archive" in line:
                    archived = True
                self._parse_progress(item, line)
                now = time.time()
                changed = item.progress != last_progress or item.message != last_message
                if changed and now - last_emit > 0.15:
                    self._broadcast({"type": "progress", "item": asdict(item)})
                    last_emit = now
                    last_progress = item.progress
                    last_message = item.message
        except Exception:
            pass
        # Flush any tail update so the bar reaches its final value before
        # the completion event arrives.
        if item.progress != last_progress or item.message != last_message:
            self._broadcast({"type": "progress", "item": asdict(item)})
        rc = proc.wait()
        with self._lock:
            self._active_procs.pop(item.id, None)
            paused = item.id in self._pausing
            self._pausing.discard(item.id)
        if paused:
            self._finish(item, "paused", "Paused — partial file kept for resume")
        elif rc == 0 and archived and not item.output_file:
            self._finish(item, "completed", "Skipped — already in archive")
        elif rc == 0:
            self._finish(item, "completed", "Saved")
        elif rc < 0 or (IS_WINDOWS and rc in (3221225786, -1073741510)):
            # CTRL_BREAK/CTRL_C terminations on Windows surface as 0xC000013A
            self._finish(item, "cancelled", "Stopped")
        else:
            self._finish(item, "failed", item.message or f"yt-dlp exited {rc}")
        self._wake.set()

    def _finish(self, item: QueueItem, status: str, message: str) -> None:
        with self._lock:
            item.status = status
            item.message = message
            item.finished_at = time.time()
            if status == "completed":
                item.progress = 100.0
        self._broadcast({"type": "update", "item": asdict(item)})
        self._persist()

    # ----- yt-dlp command + parsing ------------------------------------

    def _build_command(self, item: QueueItem) -> list[str]:
        preset = QUALITY_PRESETS[item.quality]
        out_template = str(self._download_dir / "%(uploader)s/%(title)s [%(id)s].%(ext)s")
        # Use yt-dlp's default, newline-delimited progress output ("[download]
        # 12.3% of 10.00MiB at 1.20MiB/s ETA 00:07"). It is by far the most
        # stable line format across versions, and `_PROGRESS_RE` parses it. The
        # per-pass label (video / audio / thumbnail) comes from the preceding
        # "[download] Destination: …" line. A custom --progress-template was
        # tried here but its space-padded fields proved too brittle to parse,
        # which left the bar stuck at 0% until completion.
        cmd: list[str] = [
            "yt-dlp",
            "--newline",
            "--no-colors",
            "--no-playlist",
            "-o", out_template,
            "--print", "after_move:filepath:%(filepath)s",
        ]
        with self._lock:
            audio_only = bool(preset.get("audio_only"))
            if audio_only:
                cmd += [
                    "-f", preset["format"],
                    "-x",
                    "--audio-format", preset["audio_format"],
                ]
            else:
                cmd += ["-f", preset["format"]]
                if "merge_output_format" in preset:
                    cmd += ["--merge-output-format", preset["merge_output_format"]]
            if item.sponsorblock:
                cmd += ["--sponsorblock-remove", ",".join(item.sponsorblock)]
            if self._embed_metadata:
                cmd += ["--embed-metadata"]
            if self._embed_thumbnail:
                cmd += ["--embed-thumbnail"]
            if self._embed_chapters and not audio_only:
                cmd += ["--embed-chapters"]
            if self._use_archive:
                archive_path = self._download_dir / "archive.txt"
                cmd += ["--download-archive", str(archive_path)]
            if self._cookies_browser:
                cmd += ["--cookies-from-browser", self._cookies_browser]
            elif self._cookies_file:
                cmd += ["--cookies", self._cookies_file]
        cmd.append(item.url)
        return cmd

    _PROGRESS_RE = re.compile(
        r"\[download\]\s+(?P<pct>[\d.]+)%(?:\s+of\s+~?\s*(?P<size>[\d.]+\w+))?"
        r"(?:\s+at\s+(?P<speed>[^\s]+))?"
        r"(?:\s+ETA\s+(?P<eta>[\d:]+))?"
    )
    _FILEPATH_RE = re.compile(r"^filepath:(.+)$")
    _ERROR_RE = re.compile(r"^ERROR:\s*(.+)$", re.IGNORECASE)
    _DESTINATION_RE = re.compile(r"^\[download\]\s+Destination:\s*(.+)$")

    _AUDIO_EXTS = {".m4a", ".mp3", ".opus", ".aac", ".wav", ".flac", ".ogg"}
    _VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".m4v", ".mov", ".avi", ".ts"}
    _IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

    def _classify_destination(self, path: str) -> str:
        ext = Path(path).suffix.lower()
        if ext in self._AUDIO_EXTS:
            return "Downloading audio"
        if ext in self._VIDEO_EXTS:
            return "Downloading video"
        if ext in self._IMAGE_EXTS:
            return "Downloading thumbnail"
        return "Downloading"

    def _looks_age_restricted(self, text: str) -> bool:
        t = text.lower()
        return (
            "sign in to confirm your age" in t
            or "age-restricted" in t
            or "inappropriate for some users" in t
            or "confirm you're not a bot" in t
        )

    @staticmethod
    def _clean_tpl_value(v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v or v in ("NA", "N/A", "Unknown", "--"):
            return None
        if v.startswith("Unknown") or v.startswith("--"):
            return None
        return v

    def _parse_progress(self, item: QueueItem, line: str) -> None:
        # Strip carriage returns; yt-dlp on Windows emits CRLF.
        line = line.rstrip("\r")
        m = self._PROGRESS_RE.search(line)
        if m:
            with self._lock:
                item.progress = float(m.group("pct"))
                item.speed = self._clean_tpl_value(m.group("speed"))
                item.eta = self._clean_tpl_value(m.group("eta"))
                # Preserve "Downloading video / audio / thumbnail" phase set
                # by the most recent Destination line.
                if not (item.message or "").startswith("Downloading"):
                    item.message = "Downloading"
            return
        dest = self._DESTINATION_RE.match(line)
        if dest:
            phase = self._classify_destination(dest.group(1).strip())
            with self._lock:
                item.message = phase
                item.progress = 0.0
                item.speed = None
                item.eta = None
            return
        fp = self._FILEPATH_RE.match(line)
        if fp:
            with self._lock:
                item.output_file = fp.group(1).strip()
            return
        if "[SponsorBlock]" in line:
            with self._lock:
                item.message = "Querying SponsorBlock"
            return
        if "[Merger]" in line or "Merging" in line:
            with self._lock:
                item.message = "Merging streams"
            return
        if "[ExtractAudio]" in line:
            with self._lock:
                item.message = "Extracting audio"
            return
        if "[EmbedThumbnail]" in line:
            with self._lock:
                item.message = "Embedding thumbnail"
            return
        if "[Metadata]" in line:
            with self._lock:
                item.message = "Writing metadata"
            return
        if "Deleting original" in line or "[ModifyChapters]" in line:
            with self._lock:
                item.message = "Cutting segments"
            return
        err = self._ERROR_RE.match(line)
        if err:
            msg = err.group(1)
            if self._looks_age_restricted(msg):
                msg = "Age-restricted — add cookies under Configuration → Cookies"
            with self._lock:
                item.message = msg[:200]
            return
        if self._looks_age_restricted(line):
            with self._lock:
                item.message = "Age-restricted — add cookies under Configuration → Cookies"


TERMINATE_GRACE = 10  # seconds to wait after SIGTERM before SIGKILL


def _force_kill(proc: subprocess.Popen) -> None:
    if IS_WINDOWS:
        try:
            proc.kill()
        except Exception:
            pass
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except Exception:
            pass


def _escalate_after_grace(proc: subprocess.Popen) -> None:
    # A yt-dlp/ffmpeg child that ignores SIGTERM would otherwise leave the
    # worker thread blocked on proc.wait() forever, permanently consuming a
    # concurrency slot. Escalate to SIGKILL once the grace period lapses.
    try:
        proc.wait(timeout=TERMINATE_GRACE)
    except subprocess.TimeoutExpired:
        _force_kill(proc)


def _terminate_proc(proc: subprocess.Popen) -> bool:
    if proc.poll() is not None:
        return False
    try:
        if IS_WINDOWS:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
    except (OSError, ValueError):
        try:
            proc.terminate()
        except Exception:
            return False
    threading.Thread(target=_escalate_after_grace, args=(proc,), daemon=True).start()
    return True


manager = QueueManager()


# ---------------------------------------------------------------------------
# Reveal helper
# ---------------------------------------------------------------------------


def _reveal_path(target: Path) -> None:
    """Open the OS file manager focused on `target` (or its parent if a file)."""
    if not target.exists():
        raise FileNotFoundError(str(target))
    try:
        if IS_WINDOWS:
            if target.is_file():
                subprocess.Popen(["explorer", f"/select,{target}"])
            else:
                subprocess.Popen(["explorer", str(target)])
        elif sys.platform == "darwin":
            if target.is_file():
                subprocess.Popen(["open", "-R", str(target)])
            else:
                subprocess.Popen(["open", str(target)])
        else:
            opener = "xdg-open"
            folder = target if target.is_dir() else target.parent
            subprocess.Popen([opener, str(folder)])
    except FileNotFoundError as exc:
        raise RuntimeError(f"could not open file manager: {exc}") from exc


# ---------------------------------------------------------------------------
# Scrape helpers
# ---------------------------------------------------------------------------


def _thumbnail_for(video_id: str, hinted: str | None) -> str | None:
    if hinted:
        return hinted
    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def _is_short(entry_url: str | None) -> bool:
    # The `/shorts/` URL path is the only reliable signal. A duration-based
    # heuristic was tried here but hid legitimate short uploads (clips, teasers,
    # trailers) — plenty of real videos run under a minute, and the Shorts
    # length ceiling has since risen to three minutes, so duration tells us
    # nothing useful. Shorts come through flat-playlist with `/shorts/` URLs.
    return bool(entry_url and "/shorts/" in entry_url)


# Per-URL cache of parsed flat-playlist entries. Because yt-dlp can only walk a
# channel's continuation tokens from the top (see below), every page fetch is a
# "1:end" scrape — so the deepest fetch already contains every shallower page.
# Caching it makes back-navigation, Shorts-toggling, and re-renders instant
# instead of re-running yt-dlp each time.
_SCRAPE_CACHE: dict[str, dict[str, Any]] = {}
_SCRAPE_CACHE_LOCK = threading.Lock()
_SCRAPE_CACHE_TTL = 300  # seconds


def _fetch_entries(url: str, end: int) -> list[dict[str, Any]]:
    """Return parsed flat-playlist entries for `url`, covering items 1..end.

    Served from the per-URL cache when a fresh, deep-enough scrape already
    exists; otherwise yt-dlp is run for `1:end` and the result is cached.
    """
    now = time.time()
    with _SCRAPE_CACHE_LOCK:
        cached = _SCRAPE_CACHE.get(url)
        if cached and cached["end"] >= end and (now - cached["ts"]) < _SCRAPE_CACHE_TTL:
            return cached["entries"]
    # For channel URLs yt-dlp's --playlist-items "51:100" often returns nothing
    # because it never walks the continuation tokens past the first batch. Ask
    # for 1:end and slice client-side — yt-dlp keeps paginating until it hits
    # the upper bound, which is what we actually want.
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--ignore-no-formats-error",
        "--playlist-items", f"1:{end}",
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
    if proc.returncode != 0 and not proc.stdout.strip():
        msg = (proc.stderr or "").strip().splitlines()[-1] if proc.stderr else "scrape failed"
        raise RuntimeError(msg)
    entries: list[dict[str, Any]] = []
    for ln in proc.stdout.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            entries.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    with _SCRAPE_CACHE_LOCK:
        _SCRAPE_CACHE[url] = {"entries": entries, "end": end, "ts": now}
    return entries


def scrape_channel(url: str, start: int, end: int, ignore_shorts: bool = True) -> dict[str, Any]:
    """Return a page of videos from a channel/playlist URL.

    yt-dlp's --flat-playlist + --dump-json gives one JSON object per entry on
    stdout. We use --playlist-items to grab just the slice we need.
    """
    if shutil.which("yt-dlp") is None:
        raise RuntimeError("yt-dlp is not installed or not on PATH")
    entries = _fetch_entries(url, end)
    # Drop everything before this page's window so we don't re-emit page 1.
    window = entries[start - 1:end]
    # Entries actually present in this window, before Shorts filtering. The UI
    # uses this (not the post-filter video count) to decide whether a further
    # page exists — otherwise a window full of hidden Shorts looks like the end.
    page_entries = len(window)
    videos: list[dict[str, Any]] = []
    channel: str | None = None
    skipped_shorts = 0
    for entry in window:
        vid = entry.get("id")
        if not vid:
            continue
        entry_url = entry.get("url") or f"https://www.youtube.com/watch?v={vid}"
        duration = entry.get("duration")
        if ignore_shorts and _is_short(entry_url):
            skipped_shorts += 1
            if not channel:
                channel = entry.get("channel") or entry.get("uploader")
            continue
        thumb = None
        thumbs = entry.get("thumbnails") or []
        if isinstance(thumbs, list) and thumbs:
            thumb = thumbs[-1].get("url")
        elif entry.get("thumbnail"):
            thumb = entry["thumbnail"]
        videos.append({
            "video_id": vid,
            "url": entry_url,
            "title": entry.get("title") or vid,
            "thumbnail": _thumbnail_for(vid, thumb),
            "duration": duration,
            "upload_date": entry.get("upload_date"),
            "view_count": entry.get("view_count"),
            "channel": entry.get("channel") or entry.get("uploader"),
        })
        if not channel:
            channel = entry.get("channel") or entry.get("uploader")
    return {
        "channel": channel,
        "videos": videos,
        "start": start,
        "end": end,
        "count": len(videos),
        "page_entries": page_entries,
        "skipped_shorts": skipped_shorts,
        "ignore_shorts": ignore_shorts,
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


@app.route("/")
def index() -> Response:
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/health")
def health() -> Response:
    return jsonify({
        "ok": True,
        "yt_dlp": shutil.which("yt-dlp") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "download_dir": str(manager.download_dir),
    })


@app.route("/api/scrape", methods=["POST"])
def api_scrape() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("url") or "").strip()
    page = int(data.get("page", 1))
    ignore_shorts = bool(data.get("ignore_shorts", True))
    if not url:
        return jsonify({"error": "url is required"}), 400
    if page < 1:
        page = 1
    start = (page - 1) * SCRAPE_PAGE_SIZE + 1
    end = page * SCRAPE_PAGE_SIZE
    try:
        result = scrape_channel(url, start, end, ignore_shorts=ignore_shorts)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    result["page"] = page
    result["page_size"] = SCRAPE_PAGE_SIZE
    if page == 1:
        manager.push_history(url)
    return jsonify(result)


@app.route("/api/queue", methods=["GET"])
def api_queue() -> Response:
    return jsonify({
        "items": manager.snapshot(),
        "running": manager.is_running(),
        "download_dir": str(manager.download_dir),
    })


@app.route("/api/queue/add", methods=["POST"])
def api_queue_add() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    videos = data.get("videos") or []
    quality = data.get("quality") or "1080p"
    sponsorblock = data.get("sponsorblock") or []
    if not isinstance(videos, list) or not videos:
        return jsonify({"error": "videos must be a non-empty list"}), 400
    try:
        added = manager.add(videos, quality, sponsorblock)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"added": [asdict(i) for i in added], "count": len(added)})


@app.route("/api/queue/remove", methods=["POST"])
def api_queue_remove() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    if not item_id:
        return jsonify({"error": "id is required"}), 400
    ok = manager.remove(item_id)
    return jsonify({"ok": ok})


@app.route("/api/queue/retry", methods=["POST"])
def api_queue_retry() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    if not item_id:
        return jsonify({"error": "id is required"}), 400
    ok = manager.retry(item_id)
    return jsonify({"ok": ok})


@app.route("/api/queue/clear", methods=["POST"])
def api_queue_clear() -> Response:
    removed = manager.clear_finished()
    return jsonify({"removed": removed})


@app.route("/api/queue/start", methods=["POST"])
def api_queue_start() -> Response:
    manager.start()
    return jsonify({"running": True})


@app.route("/api/queue/pause", methods=["POST"])
def api_queue_pause() -> Response:
    manager.pause()
    return jsonify({"running": False})


@app.route("/api/queue/cancel", methods=["POST"])
def api_queue_cancel() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    if item_id:
        cancelled = manager.cancel_item(item_id)
        return jsonify({"cancelled": bool(cancelled)})
    cancelled = manager.cancel_current()
    return jsonify({"cancelled": cancelled})


@app.route("/api/queue/pause-item", methods=["POST"])
def api_queue_pause_item() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    if not item_id:
        return jsonify({"error": "id is required"}), 400
    ok = manager.pause_item(item_id)
    return jsonify({"ok": ok})


@app.route("/api/queue/resume-item", methods=["POST"])
def api_queue_resume_item() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    if not item_id:
        return jsonify({"error": "id is required"}), 400
    ok = manager.resume_item(item_id)
    return jsonify({"ok": ok})


@app.route("/api/queue/reveal", methods=["POST"])
def api_queue_reveal() -> Response:
    data = request.get_json(force=True, silent=True) or {}
    item_id = data.get("id")
    target: Path | None = None
    if item_id:
        for it in manager.snapshot():
            if it["id"] == item_id and it.get("output_file"):
                p = Path(str(it["output_file"]))
                if p.exists():
                    target = p
                    break
    if target is None:
        target = manager.download_dir
    try:
        _reveal_path(target)
    except (FileNotFoundError, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "path": str(target)})


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings() -> Response:
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        if "download_dir" in data and data["download_dir"]:
            try:
                manager.set_download_dir(data["download_dir"])
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400
        if "concurrency" in data:
            try:
                manager.set_concurrency(int(data["concurrency"]))
            except (TypeError, ValueError):
                return jsonify({"error": "concurrency must be an integer"}), 400
        if any(k in data for k in ("embed_metadata", "embed_thumbnail", "embed_chapters")):
            cur = manager.settings()
            manager.set_embed(
                metadata=bool(data.get("embed_metadata", cur["embed_metadata"])),
                thumbnail=bool(data.get("embed_thumbnail", cur["embed_thumbnail"])),
                chapters=bool(data.get("embed_chapters", cur["embed_chapters"])),
            )
        if "use_archive" in data:
            manager.set_use_archive(bool(data["use_archive"]))
        if "cookies_browser" in data or "cookies_file" in data:
            manager.set_cookies(
                browser=data.get("cookies_browser") if "cookies_browser" in data else None,
                file=data.get("cookies_file") if "cookies_file" in data else None,
            )
        if "last_quality" in data or "last_sponsorblock" in data:
            manager.remember_choices(
                data.get("last_quality"),
                data.get("last_sponsorblock") if isinstance(data.get("last_sponsorblock"), list) else None,
            )
    settings = manager.settings()
    settings["categories"] = sorted(SPONSORBLOCK_CATEGORIES)
    settings["qualities"] = {
        key: {"label": preset["label"], "audio_only": preset.get("audio_only", False)}
        for key, preset in QUALITY_PRESETS.items()
    }
    return jsonify(settings)


@app.route("/api/events")
def api_events() -> Response:
    listener = manager.listen()

    def stream():
        snapshot = json.dumps({
            "type": "snapshot",
            "items": manager.snapshot(),
            "running": manager.is_running(),
        })
        yield f"data: {snapshot}\n\n".encode("utf-8")
        try:
            while True:
                try:
                    payload = listener.get(timeout=15)
                    yield f"data: {payload}\n\n".encode("utf-8")
                except queue.Empty:
                    yield b": keepalive\n\n"
        finally:
            manager.drop(listener)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    response = Response(stream(), mimetype="text/event-stream", headers=headers)
    response.direct_passthrough = True
    return response


def main() -> None:
    host = os.environ.get("YTARCHIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("YTARCHIVE_PORT", "8765"))
    print(f"\nYTArchive bridge → http://{host}:{port}")
    print(f"State file:       {STATE_FILE}\n")
    app.run(host=host, port=port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
