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
import subprocess
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

SCRAPE_PAGE_SIZE = 50

SPONSORBLOCK_CATEGORIES = {
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
    "preview",
    "filler",
    "music_offtopic",
    "poi_highlight",
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
    status: str = "pending"  # pending | downloading | completed | failed | cancelled
    progress: float = 0.0
    speed: str | None = None
    eta: str | None = None
    message: str | None = None
    output_file: str | None = None
    added_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None


# ---------------------------------------------------------------------------
# Manager: thread-safe queue + background worker + event broadcaster
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
        self._current: QueueItem | None = None
        self._current_proc: subprocess.Popen | None = None
        self._download_dir: Path = DEFAULT_DOWNLOAD_DIR
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    # ----- public api --------------------------------------------------

    def set_download_dir(self, path: str) -> Path:
        p = Path(path).expanduser().resolve()
        p.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._download_dir = p
        self._broadcast({"type": "settings", "download_dir": str(p)})
        return p

    @property
    def download_dir(self) -> Path:
        with self._lock:
            return self._download_dir

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
            existing_video_ids = {
                self._items[i].video_id
                for i in self._order
                if self._items[i].status in {"pending", "downloading"}
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
        return removed

    def cancel_current(self) -> bool:
        with self._lock:
            proc = self._current_proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                return False
            return True
        return False

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
                pass

    # ----- worker loop -------------------------------------------------

    def _next_pending(self) -> QueueItem | None:
        with self._lock:
            if not self._running:
                return None
            for iid in self._order:
                it = self._items[iid]
                if it.status == "pending":
                    return it
            return None

    def _run(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            while True:
                item = self._next_pending()
                if not item:
                    break
                self._process(item)

    def _process(self, item: QueueItem) -> None:
        with self._lock:
            item.status = "downloading"
            item.started_at = time.time()
            self._current = item
        self._broadcast({"type": "update", "item": asdict(item)})

        cmd = self._build_command(item)
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            self._finish(item, "failed", "yt-dlp not found on PATH")
            return
        with self._lock:
            self._current_proc = proc

        last_emit = 0.0
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            self._parse_progress(item, line)
            now = time.time()
            if now - last_emit > 0.2:
                self._broadcast({"type": "progress", "item": asdict(item)})
                last_emit = now
        rc = proc.wait()
        with self._lock:
            self._current_proc = None
            self._current = None
        if rc == 0:
            self._finish(item, "completed", "Saved")
        elif rc < 0:
            self._finish(item, "cancelled", "Stopped")
        else:
            self._finish(item, "failed", item.message or f"yt-dlp exited {rc}")

    def _finish(self, item: QueueItem, status: str, message: str) -> None:
        with self._lock:
            item.status = status
            item.message = message
            item.finished_at = time.time()
            if status == "completed":
                item.progress = 100.0
        self._broadcast({"type": "update", "item": asdict(item)})

    # ----- yt-dlp command + parsing ------------------------------------

    def _build_command(self, item: QueueItem) -> list[str]:
        preset = QUALITY_PRESETS[item.quality]
        out_template = str(self._download_dir / "%(uploader)s/%(title)s [%(id)s].%(ext)s")
        cmd: list[str] = [
            "yt-dlp",
            "--newline",
            "--no-colors",
            "--progress",
            "--no-playlist",
            "-o", out_template,
            "--print", "after_move:filepath:%(filepath)s",
        ]
        if preset.get("audio_only"):
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
        cmd.append(item.url)
        return cmd

    _PROGRESS_RE = re.compile(
        r"\[download\]\s+(?P<pct>[\d.]+)%\s+of\s+~?\s*(?P<size>[\d.]+\w+)"
        r"(?:\s+at\s+(?P<speed>[^\s]+))?"
        r"(?:\s+ETA\s+(?P<eta>[\d:]+))?"
    )
    _FILEPATH_RE = re.compile(r"^filepath:(.+)$")
    _ERROR_RE = re.compile(r"^ERROR:\s*(.+)$", re.IGNORECASE)

    def _parse_progress(self, item: QueueItem, line: str) -> None:
        m = self._PROGRESS_RE.search(line)
        if m:
            with self._lock:
                item.progress = float(m.group("pct"))
                item.speed = m.group("speed")
                item.eta = m.group("eta")
                item.message = "Downloading"
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
        if "Deleting original" in line or "[ModifyChapters]" in line:
            with self._lock:
                item.message = "Cutting segments"
            return
        err = self._ERROR_RE.match(line)
        if err:
            with self._lock:
                item.message = err.group(1)[:200]


manager = QueueManager()


# ---------------------------------------------------------------------------
# Scrape helpers
# ---------------------------------------------------------------------------


def _thumbnail_for(video_id: str, hinted: str | None) -> str | None:
    if hinted:
        return hinted
    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


SHORTS_DURATION_CUTOFF = 60  # seconds; canonical YouTube Shorts limit


def _is_short(entry_url: str | None, duration: Any) -> bool:
    if entry_url and "/shorts/" in entry_url:
        return True
    try:
        if duration is not None and float(duration) > 0 and float(duration) <= SHORTS_DURATION_CUTOFF:
            return True
    except (TypeError, ValueError):
        pass
    return False


def scrape_channel(url: str, start: int, end: int, ignore_shorts: bool = True) -> dict[str, Any]:
    """Return a page of videos from a channel/playlist URL.

    yt-dlp's --flat-playlist + --dump-json gives one JSON object per entry on
    stdout. We use --playlist-items to grab just the slice we need.
    """
    if shutil.which("yt-dlp") is None:
        raise RuntimeError("yt-dlp is not installed or not on PATH")
    items_arg = f"{start}:{end}"
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--ignore-no-formats-error",
        "--playlist-items", items_arg,
        url,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if proc.returncode != 0 and not proc.stdout.strip():
        msg = (proc.stderr or "").strip().splitlines()[-1] if proc.stderr else "scrape failed"
        raise RuntimeError(msg)
    videos: list[dict[str, Any]] = []
    channel: str | None = None
    skipped_shorts = 0
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        vid = entry.get("id")
        if not vid:
            continue
        entry_url = entry.get("url") or f"https://www.youtube.com/watch?v={vid}"
        duration = entry.get("duration")
        if ignore_shorts and _is_short(entry_url, duration):
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
    cancelled = manager.cancel_current()
    return jsonify({"cancelled": cancelled})


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings() -> Response:
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        new_dir = data.get("download_dir")
        if new_dir:
            try:
                manager.set_download_dir(new_dir)
            except Exception as exc:
                return jsonify({"error": str(exc)}), 400
    return jsonify({
        "download_dir": str(manager.download_dir),
        "categories": sorted(SPONSORBLOCK_CATEGORIES),
        "qualities": {
            key: {"label": preset["label"], "audio_only": preset.get("audio_only", False)}
            for key, preset in QUALITY_PRESETS.items()
        },
    })


@app.route("/api/events")
def api_events() -> Response:
    listener = manager.listen()

    def stream():
        snapshot = json.dumps({"type": "snapshot", "items": manager.snapshot()})
        yield f"data: {snapshot}\n\n"
        try:
            while True:
                try:
                    payload = listener.get(timeout=15)
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            manager.drop(listener)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(stream(), mimetype="text/event-stream", headers=headers)


def main() -> None:
    host = os.environ.get("YTARCHIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("YTARCHIVE_PORT", "8765"))
    print(f"\nYTArchive bridge → http://{host}:{port}\n")
    app.run(host=host, port=port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
