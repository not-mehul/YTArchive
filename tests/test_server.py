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


class ProgressRegexTests(unittest.TestCase):
    def test_full_progress_line(self):
        m = server.QueueManager._PROGRESS_RE.search(
            "[download]  12.3% of 10.00MiB at 1.20MiB/s ETA 00:07"
        )
        self.assertIsNotNone(m)
        self.assertEqual(m.group("pct"), "12.3")
        self.assertEqual(m.group("speed"), "1.20MiB/s")
        self.assertEqual(m.group("eta"), "00:07")

    def test_percent_without_eta(self):
        m = server.QueueManager._PROGRESS_RE.search("[download] 100% of 5.00MiB")
        self.assertIsNotNone(m)
        self.assertEqual(m.group("pct"), "100")


class CleanTplTests(unittest.TestCase):
    def test_placeholder_values_become_none(self):
        for v in ("NA", "N/A", "Unknown", "--", " ", "Unknown ETA"):
            self.assertIsNone(server.QueueManager._clean_tpl_value(v))

    def test_real_value_trimmed(self):
        self.assertEqual(server.QueueManager._clean_tpl_value(" 1.2MiB/s "), "1.2MiB/s")


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
            page2 = server.scrape_channel("http://chan", 51, 100, ignore_shorts=False)
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


if __name__ == "__main__":
    unittest.main()
