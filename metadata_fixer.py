"""metadata_fixer — repair embedded metadata, thumbnails, and chapters
in files produced by YTArchive (or yt-dlp in general).

Walks a directory, identifies video/audio files by their YouTube ID
suffix (`… [VIDEOID].ext`), probes each one with `ffprobe`, and for any
file missing metadata / cover art / chapters, fetches the info JSON +
thumbnail via `yt-dlp` and muxes them into the file with `ffmpeg`.

Usable as a CLI (`python metadata_fixer.py --dir downloads/`) or as a
module (`from metadata_fixer import walk_candidates, fix_file`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


VIDEO_EXTS = {".mp4", ".mkv", ".webm"}
AUDIO_EXTS = {".m4a", ".mp3", ".opus", ".ogg"}
ALL_EXTS = VIDEO_EXTS | AUDIO_EXTS

# YouTube video IDs are 11 chars of [A-Za-z0-9_-], in trailing `[ID].ext`.
VIDEO_ID_RE = re.compile(r"\[([A-Za-z0-9_-]{11})\](?=\.[^.]+$)")


@dataclass
class FixResult:
    path: Path
    video_id: str | None
    status: str           # "ok" | "fixed" | "needs" | "no-id" | "failed"
    missing: list[str]    # subset of {"metadata", "thumbnail", "chapters"}
    detail: str = ""


# ---------------------------------------------------------------------------
# Diagnosis
# ---------------------------------------------------------------------------


def extract_video_id(path: Path) -> str | None:
    m = VIDEO_ID_RE.search(path.name)
    return m.group(1) if m else None


def _ffprobe(path: Path) -> dict:
    cmd = [
        "ffprobe",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0 or not proc.stdout.strip():
        return {}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}


# If the file is more than this many seconds shorter than the upstream
# YouTube duration, we assume SponsorBlock (or some other editor) cut into
# it — chapter timestamps from YouTube no longer match the timeline, so we
# refuse to write them.
TRIM_TOLERANCE_S = 2.0


def _file_duration(probe_data: dict) -> float | None:
    fmt = probe_data.get("format") or {}
    try:
        return float(fmt.get("duration"))
    except (TypeError, ValueError):
        return None


def diagnose_file(path: Path) -> list[str]:
    """Return the list of missing fields among 'metadata', 'thumbnail', 'chapters'.

    For audio files, 'chapters' is never reported missing — most listeners don't
    surface them and ID3 chapter support is patchy.
    """
    data = _ffprobe(path)
    if not data:
        return []
    tags = (data.get("format") or {}).get("tags") or {}
    tags_lower = {k.lower(): v for k, v in tags.items() if isinstance(k, str)}
    streams = data.get("streams") or []
    chapters = data.get("chapters") or []

    missing: list[str] = []

    if not tags_lower.get("title") and not tags_lower.get("©nam"):
        missing.append("metadata")

    has_cover = any(
        (s.get("disposition") or {}).get("attached_pic") for s in streams
    )
    if not has_cover:
        missing.append("thumbnail")

    is_audio = path.suffix.lower() in AUDIO_EXTS
    if not is_audio and not chapters:
        missing.append("chapters")

    return missing


def _trimmed_vs_upstream(file_duration: float | None, info: dict) -> bool:
    """True if the local file is materially shorter than YouTube's duration."""
    if file_duration is None:
        return False
    try:
        upstream = float(info.get("duration") or 0)
    except (TypeError, ValueError):
        return False
    if upstream <= 0:
        return False
    return (upstream - file_duration) > TRIM_TOLERANCE_S


# ---------------------------------------------------------------------------
# Fetch sidecars from YouTube
# ---------------------------------------------------------------------------


def fetch_sidecars(video_id: str, tmp: Path) -> tuple[dict, Path | None]:
    """Use yt-dlp to drop the .info.json + thumbnail for `video_id` into `tmp`.

    Returns (info_dict, thumbnail_path_or_None).
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    cmd = [
        "yt-dlp",
        "--skip-download",
        "--write-info-json",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
        "--no-warnings",
        "--no-progress",
        "-o", str(tmp / "%(id)s.%(ext)s"),
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    info_path = tmp / f"{video_id}.info.json"
    if not info_path.exists():
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        msg = tail[-1] if tail else "yt-dlp produced no info.json"
        raise RuntimeError(msg)
    with info_path.open("r", encoding="utf-8") as fh:
        info = json.load(fh)
    thumb = tmp / f"{video_id}.jpg"
    return info, (thumb if thumb.exists() else None)


# ---------------------------------------------------------------------------
# ffmetadata writer
# ---------------------------------------------------------------------------


def _ffmeta_escape(value: str) -> str:
    # Per ffmpeg-formats(1): escape =, ;, #, \, and newlines.
    out = value.replace("\\", "\\\\")
    out = out.replace("=", "\\=").replace(";", "\\;").replace("#", "\\#")
    out = out.replace("\n", "\\\n")
    return out


def write_ffmetadata(info: dict, dest_dir: Path, include_chapters: bool = True) -> Path:
    lines: list[str] = [";FFMETADATA1"]

    def add(key: str, value) -> None:
        if value is None or value == "":
            return
        lines.append(f"{key}={_ffmeta_escape(str(value))}")

    add("title", info.get("title"))
    add("artist", info.get("uploader") or info.get("channel"))
    add("album_artist", info.get("channel") or info.get("uploader"))
    upload_date = info.get("upload_date") or ""
    if upload_date and len(upload_date) >= 4:
        add("date", upload_date[:4])
    add("comment", info.get("description"))
    add("purl", info.get("webpage_url"))
    add("synopsis", info.get("description"))

    if include_chapters:
        for ch in info.get("chapters") or []:
            try:
                start = float(ch.get("start_time", 0))
                end = float(ch.get("end_time", 0))
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue
            lines.append("[CHAPTER]")
            lines.append("TIMEBASE=1/1000")
            lines.append(f"START={int(round(start * 1000))}")
            lines.append(f"END={int(round(end * 1000))}")
            title = ch.get("title")
            if title:
                lines.append(f"title={_ffmeta_escape(str(title))}")

    path = dest_dir / "ffmeta.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# ffmpeg mux
# ---------------------------------------------------------------------------


def _build_ffmpeg_cmd(
    src: Path,
    meta_path: Path,
    thumb_path: Path | None,
    out_path: Path,
    include_chapters: bool = True,
) -> list[str]:
    ext = src.suffix.lower()
    is_audio = ext in AUDIO_EXTS

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(src),
        "-i", str(meta_path),
    ]
    if thumb_path is not None:
        cmd += ["-i", str(thumb_path)]

    # Input index of the metadata file is 1; thumbnail (if present) is 2.
    cmd += ["-map_metadata", "1"]
    # Caller decides which input the chapter table comes from:
    #   "upstream" (1) — use YouTube's chapter list from the ffmetadata file
    #   "source"   (0) — keep whatever chapters are already in the file
    #   "none"     (-1) — strip chapters entirely
    chapters_from = "upstream" if include_chapters else "source"
    if is_audio:
        chapters_from = "none"
    cmd += ["-map_chapters", {"upstream": "1", "source": "0", "none": "-1"}[chapters_from]]

    cmd += ["-map", "0"]
    if thumb_path is not None:
        cmd += ["-map", "2"]

    cmd += ["-c", "copy"]

    if thumb_path is not None:
        if ext in {".mp4", ".m4a", ".mkv"}:
            # the thumbnail becomes the last video stream; tag it as cover art
            cmd += ["-disposition:v:1", "attached_pic"]
        if ext == ".mp3":
            cmd += [
                "-id3v2_version", "3",
                "-metadata:s:v", "title=Album cover",
                "-metadata:s:v", "comment=Cover (front)",
            ]

    cmd.append(str(out_path))
    return cmd


# ---------------------------------------------------------------------------
# Per-file fix
# ---------------------------------------------------------------------------


def fix_file(path: Path, dry_run: bool = False) -> FixResult:
    vid = extract_video_id(path)
    if not vid:
        return FixResult(path=path, video_id=None, status="no-id", missing=[])

    probe_data = _ffprobe(path)
    file_duration = _file_duration(probe_data)
    source_chapters = bool(probe_data.get("chapters"))

    # diagnose_file re-probes — cheap and keeps the public API clean.
    missing = diagnose_file(path)
    if not missing:
        return FixResult(path=path, video_id=vid, status="ok", missing=[])

    if dry_run:
        return FixResult(path=path, video_id=vid, status="needs", missing=missing)

    with tempfile.TemporaryDirectory(prefix="ytmeta-") as td:
        tmp = Path(td)
        try:
            info, thumb = fetch_sidecars(vid, tmp)
        except RuntimeError as exc:
            return FixResult(
                path=path, video_id=vid, status="failed",
                missing=missing, detail=f"fetch: {exc}",
            )

        trimmed = _trimmed_vs_upstream(file_duration, info)

        # Decide chapter strategy:
        #   * source already has chapters → keep them; never overwrite
        #     (they may be SponsorBlock-adjusted and therefore correct).
        #   * source has no chapters & file isn't trimmed → embed YouTube's.
        #   * source has no chapters & file IS trimmed → skip; YouTube's
        #     timestamps reference the un-cut timeline and would be wrong.
        if source_chapters:
            use_upstream_chapters = False
            chapter_note = ""
        elif trimmed:
            use_upstream_chapters = False
            chapter_note = "file appears trimmed — chapters skipped"
            missing = [m for m in missing if m != "chapters"]
        else:
            use_upstream_chapters = True
            chapter_note = ""

        # No thumbnail available upstream? Don't fail the whole op.
        if "thumbnail" in missing and thumb is None:
            missing = [m for m in missing if m != "thumbnail"]

        if not missing:
            note = chapter_note or "nothing to embed"
            return FixResult(
                path=path, video_id=vid, status="ok",
                missing=[], detail=note,
            )

        meta_path = write_ffmetadata(info, tmp, include_chapters=use_upstream_chapters)
        out_path = path.with_name(path.stem + ".fix" + path.suffix)
        cmd = _build_ffmpeg_cmd(
            path, meta_path, thumb, out_path,
            include_chapters=use_upstream_chapters,
        )
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0 or not out_path.exists():
            try:
                out_path.unlink()
            except OSError:
                pass
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()
            return FixResult(
                path=path, video_id=vid, status="failed",
                missing=missing, detail=tail[-1] if tail else "ffmpeg failed",
            )
        try:
            os.replace(out_path, path)
        except OSError as exc:
            return FixResult(
                path=path, video_id=vid, status="failed",
                missing=missing, detail=f"replace: {exc}",
            )

    return FixResult(
        path=path, video_id=vid, status="fixed",
        missing=missing, detail=chapter_note,
    )


# ---------------------------------------------------------------------------
# Walking
# ---------------------------------------------------------------------------


def walk_candidates(root: Path) -> Iterable[Path]:
    """Yield every media file under `root` that has a recognized extension."""
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in ALL_EXTS:
            # Skip the .fix.* artifacts that would only exist if a previous
            # run crashed mid-mux.
            if ".fix" in p.suffixes:
                continue
            yield p


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _require_binaries() -> None:
    missing = [b for b in ("ffmpeg", "ffprobe", "yt-dlp") if shutil.which(b) is None]
    if missing:
        sys.exit(f"missing on PATH: {', '.join(missing)}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Repair missing metadata / thumbnails / chapters in a downloads folder.",
    )
    ap.add_argument(
        "--dir",
        default="downloads",
        help="folder to scan recursively (default: ./downloads)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be fixed, but make no changes",
    )
    ap.add_argument(
        "--verbose",
        action="store_true",
        help="also log files that are already complete",
    )
    args = ap.parse_args()

    root = Path(args.dir).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    _require_binaries()

    counts = {"ok": 0, "fixed": 0, "needs": 0, "no-id": 0, "failed": 0}
    for path in walk_candidates(root):
        try:
            res = fix_file(path, dry_run=args.dry_run)
        except Exception as exc:  # defensive — keep going
            counts["failed"] += 1
            print(f"FAIL  {path.relative_to(root)} :: {exc}")
            continue
        counts[res.status] = counts.get(res.status, 0) + 1
        rel = path.relative_to(root)
        if res.status == "ok":
            if args.verbose:
                print(f"OK    {rel}")
        elif res.status == "no-id":
            if args.verbose:
                print(f"SKIP  {rel} (no video id in name)")
        elif res.status == "needs":
            print(f"NEEDS {rel} — {', '.join(res.missing)}")
        elif res.status == "fixed":
            print(f"FIX   {rel} — {', '.join(res.missing)}")
        elif res.status == "failed":
            print(f"FAIL  {rel} — {res.detail}")

    print()
    print(
        "Summary: "
        f"ok={counts['ok']} fixed={counts['fixed']} needs={counts['needs']} "
        f"no-id={counts['no-id']} failed={counts['failed']}"
    )


if __name__ == "__main__":
    main()
