"""Unit tests for the YTArchive bridge's pure helpers and scrape pagination.

Run with:  python3 -m unittest discover -s tests
No third-party test deps; yt-dlp is mocked so these run offline.
"""

import json
import os
import tempfile
import unittest
from unittest import mock

# Point persistence at a throwaway dir before importing the module under test —
# importing it constructs the QueueManager singleton, which reads state on init.
os.environ["YTARCHIVE_STATE_DIR"] = tempfile.mkdtemp(prefix="ytarchive-test-")

import server  # noqa: E402


class IsShortTests(unittest.TestCase):
    def test_shorts_url_is_short(self):
        self.assertTrue(server._is_short("https://www.youtube.com/shorts/abc123"))

    def test_regular_watch_url_is_not_short(self):
        self.assertFalse(server._is_short("https://www.youtube.com/watch?v=abc123"))

    def test_short_regular_upload_is_not_hidden(self):
        # Regression: a sub-minute regular upload must NOT be classified as a
        # Short just because of its duration (it has a /watch URL, not /shorts/).
        self.assertFalse(server._is_short("https://www.youtube.com/watch?v=clip"))

    def test_none_url(self):
        self.assertFalse(server._is_short(None))


class ScrapePaginationTests(unittest.TestCase):
    def setUp(self):
        server._SCRAPE_CACHE.clear()
        self.entries = [
            {
                "id": f"v{i}",
                "url": (
                    f"https://www.youtube.com/shorts/v{i}"
                    if i % 10 == 0
                    else f"https://www.youtube.com/watch?v=v{i}"
                ),
                "title": f"Title {i}",
                "channel": "Test Channel",
            }
            for i in range(1, 121)
        ]

    def _fake_run(self, *args, **kwargs):
        r = mock.Mock()
        r.returncode = 0
        r.stdout = "\n".join(json.dumps(e) for e in self.entries)
        r.stderr = ""
        return r

    def test_page_window_is_sliced(self):
        with mock.patch.object(server.shutil, "which", return_value="yt-dlp"), \
                mock.patch.object(server.subprocess, "run", side_effect=self._fake_run):
            page1 = server.scrape_channel("http://chan", 1, 50, ignore_shorts=False)
            page2 = server.scrape_channel("http://chan", 2, 50, ignore_shorts=False)
        self.assertEqual(page1["videos"][0]["video_id"], "v1")
        self.assertEqual(page2["videos"][0]["video_id"], "v51")
        self.assertEqual(page1["page_entries"], 50)

    def test_shorts_filtered_but_counted_for_pagination(self):
        with mock.patch.object(server.shutil, "which", return_value="yt-dlp"), \
                mock.patch.object(server.subprocess, "run", side_effect=self._fake_run):
            page = server.scrape_channel("http://chan", 1, 50, ignore_shorts=True)
        # v10, v20, v30, v40, v50 are /shorts/ → 5 hidden, 45 shown.
        self.assertEqual(page["skipped_shorts"], 5)
        self.assertEqual(page["count"], 45)
        # page_entries reflects the raw window so pagination doesn't stall.
        self.assertEqual(page["page_entries"], 50)

    def test_cache_avoids_refetch(self):
        with mock.patch.object(server.shutil, "which", return_value="yt-dlp"), \
                mock.patch.object(server.subprocess, "run", side_effect=self._fake_run) as run:
            server.scrape_channel("http://chan", 1, 50, ignore_shorts=False)
            server.scrape_channel("http://chan", 1, 50, ignore_shorts=False)
        # Second call for the same/shallower window is served from cache.
        self.assertEqual(run.call_count, 1)

    def test_title_filter_spans_whole_channel(self):
        with mock.patch.object(server.shutil, "which", return_value="yt-dlp"), \
                mock.patch.object(server.subprocess, "run", side_effect=self._fake_run):
            page = server.scrape_channel(
                "http://chan", 1, 50, ignore_shorts=False,
                filters={"query": "Title 11"})
        self.assertTrue(page["filtered"])
        # "Title 11" and "Title 110"..."Title 119" match across the channel.
        titles = [v["title"] for v in page["videos"]]
        self.assertIn("Title 11", titles)
        self.assertTrue(all("Title 11" in t for t in titles))

    def test_sort_oldest_reverses(self):
        with mock.patch.object(server.shutil, "which", return_value="yt-dlp"), \
                mock.patch.object(server.subprocess, "run", side_effect=self._fake_run):
            page = server.scrape_channel(
                "http://chan", 1, 50, ignore_shorts=True, sort="oldest")
        # Oldest-first → the highest-numbered non-short comes first.
        self.assertEqual(page["videos"][0]["video_id"], "v119")


class BuildCommandTests(unittest.TestCase):
    def _item(self, **kw):
        base = dict(id="x", video_id="v", url="https://www.youtube.com/watch?v=v",
                    title="t", thumbnail=None, duration=None, quality="1080p",
                    sponsorblock=["sponsor"])
        base.update(kw)
        return server.QueueItem(**base)

    def test_sponsorblock_remove_is_default(self):
        cmd = server.manager._build_command(self._item())
        self.assertIn("--sponsorblock-remove", cmd)
        self.assertNotIn("--sponsorblock-mark", cmd)

    def test_sponsorblock_mark_mode(self):
        cmd = server.manager._build_command(self._item(sponsorblock_mode="mark"))
        self.assertIn("--sponsorblock-mark", cmd)
        self.assertNotIn("--sponsorblock-remove", cmd)
        self.assertIn("--embed-chapters", cmd)  # marking needs chapters

    def test_subtitles_embedded_when_enabled(self):
        server.manager._subtitles = True
        server.manager._subtitle_embed = True
        try:
            cmd = server.manager._build_command(self._item(quality="1080p"))
        finally:
            server.manager._subtitles = False
        self.assertIn("--write-subs", cmd)
        self.assertIn("--embed-subs", cmd)

    def test_no_subtitles_for_audio_preset(self):
        server.manager._subtitles = True
        try:
            cmd = server.manager._build_command(self._item(quality="mp3"))
        finally:
            server.manager._subtitles = False
        self.assertNotIn("--write-subs", cmd)


class ValidateSourceTests(unittest.TestCase):
    def test_handle(self):
        self.assertEqual(server.validate_source("@veritasium"),
                         ("url", "https://www.youtube.com/@veritasium"))

    def test_bare_host_gets_scheme(self):
        kind, val = server.validate_source("youtube.com/@x")
        self.assertEqual(kind, "url")
        self.assertTrue(val.startswith("https://"))

    def test_plain_text_is_query(self):
        self.assertEqual(server.validate_source("veritasium science"), ("query", "veritasium science"))

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            server.validate_source("   ")


class DownloadedIdsTests(unittest.TestCase):
    def test_detects_disk_and_archive_ignores_part(self):
        import pathlib
        d = pathlib.Path(tempfile.mkdtemp())
        (d / "Uploader").mkdir()
        (d / "Uploader" / "A Video [abcDEF12345].mp4").write_text("x")
        (d / "Uploader" / "Half [zzzZZZ99999].mp4.part").write_text("x")
        (d / "archive.txt").write_text("youtube arch1234567\n")
        prev = server.manager._download_dir
        server.manager._download_dir = d
        server.manager._dl_scan = None
        try:
            ids = server.manager.downloaded_ids()
        finally:
            server.manager._download_dir = prev
            server.manager._dl_scan = None
        self.assertIn("abcDEF12345", ids)       # on disk
        self.assertIn("arch1234567", ids)        # in archive.txt
        self.assertNotIn("zzzZZZ99999", ids)     # .part is in-progress, ignored


class ByteHelperTests(unittest.TestCase):
    def test_human_bytes(self):
        self.assertEqual(server._human_bytes(1536), "1.5 KiB")
        self.assertEqual(server._human_bytes(0), "0 B")

    def test_fmt_eta(self):
        self.assertEqual(server._fmt_eta(7), "00:07")
        self.assertEqual(server._fmt_eta(3661), "1:01:01")
        self.assertIsNone(server._fmt_eta(None))


class ProgressTemplateTests(unittest.TestCase):
    def _item(self, quality="1080p"):
        return server.QueueItem(id="x", video_id="v", url="u", title="t",
                                thumbnail=None, duration=None, quality=quality,
                                sponsorblock=[])

    def test_template_line_drives_progress(self):
        it = self._item()
        server.manager._parse_progress(
            it, "[YTPROG] 5242880|10485760|10485760|1258291.2|4|downloading|mp4")
        self.assertEqual(it.progress, 50.0)
        self.assertEqual(it.total_bytes, 10485760.0)
        self.assertEqual(it.downloaded_bytes, 5242880.0)
        self.assertAlmostEqual(it.speed_bps, 1258291.2)
        self.assertEqual(it.eta, "00:04")
        self.assertEqual(it.message, "Downloading video")

    def test_template_na_fields(self):
        it = self._item()
        server.manager._parse_progress(
            it, "[YTPROG] 1000|NA|NA|NA|NA|downloading|NA")
        # No total → percent unchanged, but downloaded bytes still tracked.
        self.assertEqual(it.downloaded_bytes, 1000.0)
        self.assertIsNone(it.speed)
        self.assertIsNone(it.eta)

    def test_template_finished_pins_100(self):
        it = self._item()
        server.manager._parse_progress(
            it, "[YTPROG] 100|100|100|0|0|finished|mp4")
        self.assertEqual(it.progress, 100.0)

    def test_build_command_streams_progress(self):
        # Either the API runner (flushing hook) is used, or the binary fallback
        # carries the --progress-template; both yield [YTPROG] lines.
        cmd = server.manager._build_command(self._item())
        if any("ytdlp_runner.py" in part for part in cmd):
            self.assertNotIn("--progress-template", cmd)  # the hook replaces it
        else:
            self.assertIn("--progress-template", cmd)
            self.assertIn("[YTPROG]", cmd[cmd.index("--progress-template") + 1])

    def test_pp_phase_mapping(self):
        self.assertEqual(server.manager._pp_phase("Merger"), "Merging streams")
        self.assertEqual(server.manager._pp_phase("ModifyChapters"), "Cutting segments")
        self.assertEqual(server.manager._pp_phase("EmbedSubtitle"), "Embedding subtitles")

    def test_ytpp_line_sets_phase(self):
        it = self._item()
        server.manager._parse_progress(it, "[YTPP] Merger")
        self.assertEqual(it.message, "Merging streams")


class BroadcastEvictionTests(unittest.TestCase):
    def test_full_listener_keeps_newest_event(self):
        m = server.manager
        q = m.listen()
        try:
            # Saturate the listener so the next put would overflow.
            for i in range(q.maxsize):
                q.put_nowait(f"old{i}")
            m._broadcast({"type": "update", "marker": "terminal"})
            drained = []
            while not q.empty():
                drained.append(q.get_nowait())
            # The newest (terminal) event must have survived the overflow...
            self.assertTrue(any("terminal" in x for x in drained))
            # ...and the queue must never have exceeded its bound.
            self.assertLessEqual(len(drained), q.maxsize)
        finally:
            m.drop(q)


if __name__ == "__main__":
    unittest.main()
