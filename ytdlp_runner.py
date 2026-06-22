"""Run yt-dlp through its Python API with flushing progress hooks.

Why this exists: the standalone `yt-dlp.exe` — and even `python -m yt_dlp` —
buffer their progress output on Windows so it never reaches the parent process's
pipe until the very end, making downloads appear to jump straight from 0% to
100% with no live speed or ETA. Emitting progress from a `progress_hooks`
callback with an explicit `flush()` sidesteps all of that: the bytes leave this
process immediately, regardless of platform stdio buffering.

The server invokes this with the same yt-dlp CLI flags it would otherwise pass
to the binary; `yt_dlp.parse_options` turns them into the API options, so every
feature (formats, SponsorBlock, subtitles, cookies, archive, …) is preserved.

Lines emitted (each flushed, newline-terminated):
  [YTPROG] downloaded|total|estimate|speed|eta|status|ext
  [YTPP]   <postprocessor name>          (a postprocessing phase started)
"""

from __future__ import annotations

import sys


def _emit(line: str) -> None:
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def main() -> int:
    import yt_dlp

    parsed = yt_dlp.parse_options(sys.argv[1:])
    opts = dict(parsed.ydl_opts)
    # The progress hook below is our single source of progress; suppress
    # yt-dlp's own progress line so it doesn't also spam the captured log.
    opts["noprogress"] = True

    def progress_hook(d: dict) -> None:
        info = d.get("info_dict") or {}
        _emit("[YTPROG] {}|{}|{}|{}|{}|{}|{}".format(
            d.get("downloaded_bytes"),
            d.get("total_bytes"),
            d.get("total_bytes_estimate"),
            d.get("speed"),
            d.get("eta"),
            d.get("status"),
            info.get("ext"),
        ))

    def postprocessor_hook(d: dict) -> None:
        if d.get("status") == "started":
            _emit("[YTPP] " + str(d.get("postprocessor") or ""))

    opts.setdefault("progress_hooks", []).append(progress_hook)
    opts.setdefault("postprocessor_hooks", []).append(postprocessor_hook)

    with yt_dlp.YoutubeDL(opts) as ydl:
        return int(ydl.download(parsed.urls) or 0)


if __name__ == "__main__":
    sys.exit(main())
