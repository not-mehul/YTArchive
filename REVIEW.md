# YTArchive — Functionality & UX Review

A review of the three-tier tool (Flask bridge `server.py`, SPA in `static/`).
Findings are grouped by severity. File/line references point at the relevant
code.

---

## 1. Bugs & correctness

### 1.1 Shorts filter false-positives on short regular videos — **High**
`_is_short()` (`server.py:922`) treats *any* video `<= 60s` as a Short:

```python
if duration is not None and float(duration) > 0 and float(duration) <= SHORTS_DURATION_CUTOFF:
    return True
```

A legitimate 45-second upload (clip, teaser, trailer) gets silently hidden
whenever "Ignore Shorts" is on (the default). Two problems:

- The duration heuristic is too aggressive — it should be a fallback, with the
  `/shorts/` URL path being the authoritative signal.
- The cutoff is stale. YouTube Shorts have been up to **180s** since late 2024,
  so the 60s constant is also wrong in the other direction for URL-less cases.

Recommendation: prefer the `/shorts/` URL test; only use duration as a weak
secondary signal, and surface a count so the user knows what was hidden (the
"N shorts hidden" note already exists — good).

### 1.2 Cross-page selection is silently discarded — **High (UX)**
`loadPage()` calls `state.selected.clear()` (`app.js:250`) and `queueSelected()`
only reads `state.videos` (the current page). So:

- Select videos on page 1 → click **Next** → selection is wiped.
- You must **Queue selected** on every page before navigating.

There's no visible warning that paging discards your picks. Either persist
selection across pages (keep a map keyed by `video_id` with the video payload),
or auto-queue on navigation, or at minimum warn when navigating with a pending
selection.

### 1.3 `running` state can desync after SSE reconnect — **Medium**
The SSE `snapshot` payload (`server.py:1226`) contains only `items`, not
`running`. On reconnect (laptop sleep, network blip) `connectEvents()` re-renders
the queue but never re-syncs the Start/Pause toggle. If nothing is actively
downloading at that moment, the button can show the wrong state until the next
`update` event. Fix: include `"running": self.is_running()` in the snapshot, and
have the client apply it.

### 1.4 Terminated yt-dlp can hang a worker forever — **Medium**
`_terminate_proc()` (`server.py:854`) sends `SIGTERM`/`CTRL_BREAK` only — there's
no `SIGKILL` escalation. `_process()` then blocks on `proc.wait()`
(`server.py:670`) with no timeout. A yt-dlp/ffmpeg child that ignores SIGTERM
leaves that worker thread and its `_active_procs` slot occupied permanently,
permanently reducing effective concurrency. Add a `wait(timeout=...)` followed by
`kill()` on the process group.

### 1.5 Archive-skipped items report "Saved" with no file — **Low**
With **Use download archive** on, an already-archived video makes yt-dlp exit `0`
without downloading. `_process()` marks it `completed` / "Saved"
(`server.py:677`) even though nothing was written and `output_file` stays `None`.
**Reveal in folder** then silently falls back to the download root. Consider
detecting "has already been recorded in the archive" and labeling it
"Skipped (archived)".

### 1.6 SponsorBlock category set mismatch — **Low**
`server.py:47` lists **9** categories including `poi_highlight`; the frontend
`SB_CATEGORIES` (`app.js:3`) hardcodes **8** and ignores the `categories` the
`/api/settings` response actually sends (`server.py:1213`). Net effects:

- `poi_highlight` is accepted server-side but unreachable from the UI.
- `poi_highlight` is a single point-of-interest marker, not a removable segment;
  passing it to `--sponsorblock-remove` isn't meaningful. It probably shouldn't
  be in the removable set at all.
- The UI should render from the server's `categories` list so the two can't
  drift.

### 1.7 Re-queuing a failed video creates a duplicate — **Low**
`add()` dedups only against `pending|downloading|paused` (`server.py:405`). A
`failed` item is invisible to the check, so selecting the same video again adds a
second row alongside the failed one (instead of pointing the user at **Retry**).
Minor, but it clutters the queue.

---

## 2. UX / interaction

### 2.1 "Queue selected" sits above the config it depends on — **Medium**
Page order is grid → **Queue selected** → Configuration (quality/SponsorBlock) →
Destination → Queue. A user can queue before ever scrolling to the config that
governs the download. It works because choices are remembered, but it's a
confusing information hierarchy. Consider moving quality/SponsorBlock above the
grid, or showing the active quality/SB summary next to **Queue selected**.

### 2.2 "Pause" (whole queue) doesn't pause the active download — **Medium**
`manager.pause()` (`server.py:552`) only sets `_running=False`, which stops
*dispatching* new items; the in-flight download runs to completion. The button
labeled "Pause" with a pause-bars icon implies everything halts. Either rename it
("Stop starting new" / "Hold") or also pause active items.

### 2.3 Video cards aren't keyboard accessible — **Medium (a11y)**
Cards are `<article>` elements with a click handler (`app.js:303`) — no
`tabindex`, `role="button"`, or Enter/Space handling. Keyboard and screen-reader
users can't select videos. The quality segmented control has `role="radio"` but
no arrow-key navigation either.

### 2.4 Destructive actions have no confirmation — **Low**
**Remove**, **Clear finished**, and **Cancel** act immediately. For a single
remove that's fine; for **Clear finished** (bulk) a small confirm or an
undo-toast would be safer.

### 2.5 Scrape gives no progress feedback for slow pages — **Low**
For deep pages the only feedback is the button reading "Fetching…" (`app.js:239`)
while a 180s subprocess runs. A spinner or "scanning channel… this can take a
minute on large channels" line would reassure the user.

### 2.6 Card metadata is usually empty — **Low**
Cards render `upload_date` and `view_count` (`app.js:323`), but
`--flat-playlist --dump-json` typically returns neither for channel entries, so
the meta line is often just blank/`—`. Not harmful, but it's dead UI most of the
time.

### 2.7 No way to reorder or bulk-manage the queue — **Low (feature gap)**
Items download in insertion order with no drag-to-reorder, no "move to top", and
no select-all/queue-entire-channel. For an archival tool aimed at whole channels,
queueing 50 at a time per page is tedious.

---

## 3. Performance

### 3.1 Pagination is O(n²) and re-fetches every page — **Medium**
`scrape_channel()` requests `1:end` and slices client-side (`server.py:945`)
because channel continuation tokens don't honor a `start:end` window. The comment
explains *why*, but the cost is real: page 5 re-scrapes entries 1–250, page 10
re-scrapes 1–500. Deep paging gets linearly slower and repeatedly pulls the same
metadata, and the fixed `timeout=180` (`server.py:959`) becomes a hard ceiling on
how deep you can go before it just fails. Options: cache the full id list per
channel for the session, or scrape once with a higher cap and paginate purely
client-side.

---

## 4. Security (local-only, but worth hardening)

### 4.1 No Origin/Host validation → local CSRF / DNS-rebinding — **Medium**
The bridge has no auth and no `Origin`/`Host` checks. Any web page open in the
user's browser can `POST` to `http://127.0.0.1:8765` and:

- change `download_dir` to an arbitrary writable path (`/api/settings`),
- queue arbitrary URLs to download to that path (`/api/queue/add`),
- spam the OS file manager (`/api/queue/reveal`).

The README's "don't expose publicly" note doesn't cover a malicious site
targeting localhost from the victim's own browser. Mitigations: validate the
`Origin`/`Host` header against `127.0.0.1:<port>`, and/or require a per-session
token. (Command execution itself is safe — args are passed as a list, not a
shell string.)

### 4.2 `cookies_file` / `download_dir` are unconstrained paths — **Low**
Accepted as free text and handed to yt-dlp / `mkdir`. Acceptable for a local tool
the user controls, but combined with 4.1 it widens what a CSRF request can reach.

---

## 5. Robustness / engineering

- **No tests.** There's no test suite; the progress regex (`_PROGRESS_RE`), the
  Shorts heuristic, pagination slicing, and the state-restore path are all
  prime candidates for unit tests and have already churned (see the
  progress-parsing history in the commit log).
- **Health is checked once.** `/api/health` runs only at page load
  (`app.js:368`); installing yt-dlp afterward needs a manual refresh. A
  re-check button or periodic poll would help first-run users.
- **`finished_at` not cleared on resume.** `resume_item()` (`server.py:526`) sets
  status back to `pending` but leaves `finished_at` set from the pause. Cosmetic,
  but the field is then misleading.
- **Resume visually restarts at 0%.** Paused→resumed items reset `progress` to
  `0.0` (`server.py:534`) even though yt-dlp resumes from the `.part` file, so the
  bar jumps 0→(actual). Consider keeping the last known percent until the first
  real progress line.
- **SSE listener overflow drops silently.** `_broadcast()` swallows
  `queue.Full` (`server.py:581`). Fine for throttled progress, but a dropped
  terminal `update` would leave a stale row; the 512 buffer makes this unlikely
  rather than impossible.

---

## 6. What's done well

- Clean separation of concerns; no shell-string command building (injection-safe).
- Atomic state writes (`_atomic_write_json`) and graceful restore of interrupted
  downloads as resumable `pending`.
- Thoughtful progress parsing with a documented rationale for using yt-dlp's
  default `--newline` output over `--progress-template`.
- Tokenized theming with a pre-paint inline script to avoid FOUC; respects
  `prefers-color-scheme`.
- Titles rendered via `textContent` / `createTextNode` — no XSS from video
  titles.
- Good empty/edge handling for the all-Shorts page (`page_entries` drives
  pagination, not the post-filter count).

---

## Suggested priority order

1. Shorts false-positives (1.1) — actively hides real content by default.
2. Cross-page selection loss (1.2) — silent data loss in the core flow.
3. Origin/Host validation (4.1) — real, if niche, local attack surface.
4. Worker hang on un-terminable yt-dlp (1.4) — degrades the tool over time.
5. `running` desync on reconnect (1.3) and the "Pause" semantics (2.2).
6. Keyboard accessibility (2.3).
