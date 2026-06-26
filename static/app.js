// YTArchive frontend bridge client.

// Human labels for SponsorBlock category ids. The set of ids actually rendered
// is driven by the server (state.sbCategories) so the two can't drift; this map
// is only the display fallback for ordering/labels.
const SB_LABELS = {
  sponsor:        "Sponsor",
  selfpromo:      "Self-promotion",
  interaction:    "Interaction prompt",
  intro:          "Intro",
  outro:          "Outro",
  preview:        "Preview / recap",
  filler:         "Filler",
  music_offtopic: "Off-topic music",
};
const SB_ORDER = Object.keys(SB_LABELS);

const QUALITIES = [
  { id: "4k",    label: "4K"    },
  { id: "1080p", label: "1080p" },
  { id: "720p",  label: "720p"  },
  { id: "m4a",   label: "M4A"   },
  { id: "mp3",   label: "MP3"   },
];

const INDETERMINATE_MESSAGES = new Set([
  "Querying SponsorBlock",
  "Merging streams",
  "Extracting audio",
  "Embedding thumbnail",
  "Embedding subtitles",
  "Writing metadata",
  "Writing chapters",
  "Cutting segments",
  "Processing",
]);

const state = {
  mode: "youtube",    // youtube | podcast
  podcast: null,      // { name, feed_url, artwork } once a show is picked
  channelUrl: "",
  page: 1,
  totalPages: null,   // set when a filtered scrape reports it
  filtered: false,
  ignoreShorts: true,
  videos: [],
  filter: "",
  sort: "newest",
  filters: { durationMin: "", durationMax: "", viewsMin: "", viewsMax: "", dateFrom: "", dateTo: "" },
  // Clicking a card queues/unqueues it directly, so "selection" == queue
  // membership. queuedIds is recomputed from the live queue; pendingClicks
  // briefly holds optimistic toggles until the SSE event reconciles them.
  queuedIds: new Set(),
  videoById: new Map(),   // video_id -> payload, for unqueue/bulk lookups
  sbCategories: null,
  quality: "1080p",
  sponsorblock: new Set(["sponsor", "selfpromo"]),
  sbMode: "remove",
  queue: [],
  running: false,
  history: [],
  concurrency: 1,
  maxConcurrency: 4,
  embedMetadata: true,
  embedThumbnail: true,
  embedChapters: true,
  useArchive: false,
  subtitles: false,
  subtitleLangs: "en",
  subtitleAuto: false,
  subtitleEmbed: true,
  cookiesBrowser: "",
  cookiesFile: "",
  cookieBrowsers: [],
};

// ---------- DOM helpers ----------

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === false || v == null) {
      continue;
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function svgEl(inner, size = 14) {
  const wrap = el("span", { class: "icon" });
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return wrap.firstChild;
}

function fmtDuration(s) {
  if (s == null) return "—";
  const n = Math.max(0, Math.floor(s));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function fmtDate(yyyymmdd) {
  if (!yyyymmdd || typeof yyyymmdd !== "string" || yyyymmdd.length !== 8) return "";
  return `${yyyymmdd.slice(0, 4)}·${yyyymmdd.slice(4, 6)}·${yyyymmdd.slice(6, 8)}`;
}

function fmtViews(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, f = Number(n);
  while (f >= 1024 && i < units.length - 1) { f /= 1024; i++; }
  return (i === 0 ? `${Math.round(f)}` : f.toFixed(1)) + " " + units[i];
}

function fmtClock(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

let toastTimer = null;
function toast(msg, kind = "") {
  const existing = $(".toast");
  if (existing) existing.remove();
  const node = el("div", { class: `toast ${kind}` }, msg);
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4200);
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = (data && data.error) || `request failed (${resp.status})`;
    throw new Error(err);
  }
  return data;
}

// ---------- config controls ----------

function sbCategoryIds() {
  // Prefer the authoritative list from the server; fall back to the known
  // labels (sorted into a stable, human-friendly order) before settings load.
  const ids = state.sbCategories && state.sbCategories.length
    ? state.sbCategories
    : SB_ORDER;
  return SB_ORDER.filter((id) => ids.includes(id))
    .concat(ids.filter((id) => !SB_ORDER.includes(id)));
}

function renderSponsorBlock() {
  const grid = $("#sb-grid");
  grid.innerHTML = "";
  for (const catId of sbCategoryIds()) {
    const id = `sb-${catId}`;
    const input = el("input", { type: "checkbox", id });
    input.checked = state.sponsorblock.has(catId);
    input.addEventListener("change", () => {
      if (input.checked) state.sponsorblock.add(catId);
      else state.sponsorblock.delete(catId);
      persistChoices();
    });
    const box = el("span", { class: "box" }, [svgEl(`<path d="m5 12 5 5L20 7"/>`, 12)]);
    grid.appendChild(el("label", { class: "check", for: id }, [input, box, SB_LABELS[catId] || catId]));
  }
}

function selectQuality(id) {
  state.quality = id;
  renderQuality();
  updateQualityHint();
  persistChoices();
  const active = $("#quality-seg button.active");
  if (active) active.focus();
}

function renderQuality() {
  const seg = $("#quality-seg");
  seg.innerHTML = "";
  const activeIx = Math.max(0, QUALITIES.findIndex((q) => q.id === state.quality));
  QUALITIES.forEach((q, ix) => {
    const isActive = q.id === state.quality;
    const btn = el("button", {
      type: "button",
      role: "radio",
      "aria-checked": isActive ? "true" : "false",
      // Roving tabindex: only the checked radio is tab-reachable.
      tabindex: isActive || (activeIx < 0 && ix === 0) ? "0" : "-1",
      class: isActive ? "active" : "",
    }, q.label);
    btn.addEventListener("click", () => selectQuality(q.id));
    btn.addEventListener("keydown", (e) => {
      let delta = 0;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") delta = 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") delta = -1;
      else return;
      e.preventDefault();
      const next = (ix + delta + QUALITIES.length) % QUALITIES.length;
      selectQuality(QUALITIES[next].id);
    });
    seg.appendChild(btn);
  });
}

function updateQualityHint() {
  const hint = $("#quality-hint");
  const map = {
    "4k":    "Up to 2160p MP4 — large files, sharpest fidelity.",
    "1080p": "1080p MP4 — the default. Balance of fidelity and disk.",
    "720p":  "720p MP4 — modest file size, still legible on TV.",
    "m4a":   "M4A audio container, AAC stream. No transcode where possible.",
    "mp3":   "MP3 audio, 192kbps default. Requires ffmpeg transcoding.",
  };
  hint.textContent = map[state.quality] || "";
}

function renderHistory() {
  const dl = $("#channel-history");
  if (!dl) return;
  dl.innerHTML = "";
  for (const url of state.history) {
    dl.appendChild(el("option", { value: url }));
  }
}

function renderAdvancedPanel() {
  const m = $("#embed-metadata");
  const t = $("#embed-thumbnail");
  const c = $("#embed-chapters");
  const a = $("#use-archive");
  const n = $("#concurrency-input");
  if (m) m.checked = state.embedMetadata;
  if (t) t.checked = state.embedThumbnail;
  if (c) c.checked = state.embedChapters;
  if (a) a.checked = state.useArchive;
  if (n) {
    n.max = String(state.maxConcurrency || 4);
    n.value = String(state.concurrency || 1);
  }
  renderCookiesPanel();
}

function renderCookiesPanel() {
  const sel = $("#cookies-browser");
  if (sel) {
    const wanted = state.cookiesBrowser || "";
    const existing = new Set(Array.from(sel.options).map((o) => o.value));
    for (const b of state.cookieBrowsers || []) {
      if (!existing.has(b)) {
        sel.appendChild(el("option", { value: b }, b.charAt(0).toUpperCase() + b.slice(1)));
      }
    }
    sel.value = wanted;
  }
  const file = $("#cookies-file");
  if (file && document.activeElement !== file) file.value = state.cookiesFile || "";
}

// ---------- scrape / grid ----------

function filterPayload() {
  const f = state.filters;
  return {
    query: state.filter.trim() || undefined,
    sort: state.sort,
    duration_min: f.durationMin || undefined,
    duration_max: f.durationMax || undefined,
    views_min: f.viewsMin || undefined,
    views_max: f.viewsMax || undefined,
    date_from: f.dateFrom || undefined,
    date_to: f.dateTo || undefined,
  };
}

async function scrape() {
  const raw = $("#channel-url").value.trim();
  if (!raw) { toast("Enter a channel URL, @handle, or a name to search.", "notice"); return; }
  state.channelUrl = raw;
  state.page = 1;
  state.filter = "";
  $("#grid-filter").value = "";
  hideChannelResults();
  await loadPage();
}

// ---------- youtube ⇄ podcast mode ----------

function setMode(mode) {
  mode = mode === "podcast" ? "podcast" : "youtube";
  state.mode = mode;
  state.podcast = null;
  state.videos = [];
  state.page = 1;
  state.filter = "";
  document.documentElement.dataset.mode = mode;
  const seg = $("#mode-seg");
  if (seg) seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  const input = $("#channel-url");
  if (input) {
    input.value = "";
    input.placeholder = mode === "podcast"
      ? "Search podcasts by name…"
      : "URL, @handle, or a channel name to search…";
  }
  const gf = $("#grid-filter");
  if (gf) {
    gf.value = "";
    gf.placeholder = mode === "podcast" ? "Search episode titles…" : "Search titles across the whole channel…";
  }
  const sp = $("#select-page");
  if (sp) sp.title = mode === "podcast" ? "Queue every episode of this podcast" : "Queue every video on this page";
  $("#src-title").textContent = mode === "podcast" ? "Find a podcast" : "Channel or playlist";
  $("#scrape-hint").textContent = mode === "podcast"
    ? "Search a podcast, pick a show, then click episodes to queue them — or queue the whole feed."
    : "Paste a channel/playlist URL or an @handle, or type a name to search. Click a thumbnail to queue it.";
  hideChannelResults();
  $("#channel-meta").hidden = true;
  $("#grid-section").hidden = true;
}

function submitSource() {
  return state.mode === "podcast" ? podcastSearch() : scrape();
}

function loadCurrent() {
  return state.mode === "podcast" ? loadEpisodes() : loadPage();
}

async function podcastSearch() {
  const q = $("#channel-url").value.trim();
  if (!q) { toast("Type a podcast name to search.", "notice"); return; }
  state.podcast = null;
  $("#grid-section").hidden = true;
  $("#channel-meta").hidden = true;
  const box = $("#channel-results");
  box.hidden = false;
  box.innerHTML = "";
  box.appendChild(el("p", { class: "muted channel-results-note" }, `Searching podcasts for “${q}”…`));
  const btn = $("#scrape-btn");
  btn.disabled = true;
  try {
    const data = await api("/api/podcast/search", { method: "POST", body: JSON.stringify({ query: q }) });
    showPodcastResults(data.shows || []);
  } catch (err) {
    box.innerHTML = "";
    box.appendChild(el("p", { class: "muted channel-results-note" }, err.message || "Search failed."));
  } finally {
    btn.disabled = false;
  }
}

function showPodcastResults(shows) {
  const box = $("#channel-results");
  box.hidden = false;
  box.innerHTML = "";
  if (!shows.length) {
    box.appendChild(el("p", { class: "muted channel-results-note" }, "No podcasts found. Try a different name."));
    return;
  }
  box.appendChild(el("p", { class: "muted channel-results-note" }, "Pick a podcast:"));
  for (const s of shows) {
    const art = s.artwork
      ? el("img", { class: "pod-art", src: s.artwork, alt: "", loading: "lazy" })
      : el("span", { class: "pod-art pod-art-blank" });
    box.appendChild(el("button", {
      type: "button", class: "channel-result podcast-result",
      onclick: () => openPodcast(s),
    }, [
      art,
      el("span", { class: "pod-meta" }, [
        el("span", { class: "channel-result-name" }, s.name),
        el("span", { class: "channel-result-url" },
          [s.author, s.episode_count ? `· ${s.episode_count} episodes` : ""].filter(Boolean).join(" ")),
      ]),
    ]));
  }
}

function openPodcast(show) {
  state.podcast = { name: show.name, feed_url: show.feed_url, artwork: show.artwork };
  state.page = 1;
  state.filter = "";
  $("#grid-filter").value = "";
  hideChannelResults();
  loadEpisodes();
}

async function loadEpisodes() {
  if (!state.podcast) return;
  const hint = $("#scrape-hint");
  const prevHint = hint ? hint.textContent : "";
  if (hint) hint.textContent = `Loading “${state.podcast.name}”…`;
  try {
    const data = await api("/api/podcast/episodes", {
      method: "POST",
      body: JSON.stringify({
        feed_url: state.podcast.feed_url,
        page: state.page,
        query: state.filter.trim() || undefined,
      }),
    });
    if (typeof data.page === "number") state.page = data.page;
    state.videos = data.videos || [];
    for (const v of state.videos) state.videoById.set(v.video_id, v);
    state.filtered = true;
    state.totalPages = data.total_pages || 1;
    renderMeta({ ...data, filtered: true });
    renderGrid();
    $("#shorts-skip-note").textContent = "";
    $("#channel-meta").hidden = false;
    $("#grid-section").hidden = false;
    if (hint) hint.textContent = `Browsing “${state.podcast.name}” — click an episode to queue it, or use Queue all.`;
  } catch (err) {
    if (hint) hint.textContent = prevHint;
    toast(err.message || "Could not load episodes.", "error");
  }
}

async function queueWholePodcast() {
  if (!state.podcast) return;
  try {
    const data = await api("/api/podcast/episodes", {
      method: "POST",
      body: JSON.stringify({ feed_url: state.podcast.feed_url, page: 1, page_size: 5000 }),
    });
    const eps = (data.videos || []).filter((v) => !v.downloaded && !state.queuedIds.has(v.video_id));
    if (!eps.length) { toast("Every episode is already downloaded or queued.", "notice"); return; }
    for (const v of eps) { state.queuedIds.add(v.video_id); markCard(v.video_id, true); }
    updateSelectedCount();
    const r = await api("/api/queue/add", { method: "POST", body: queueAddBody(eps.map(videoPayload)) });
    toast(`Queued ${r.count || 0} episode${(r.count || 0) === 1 ? "" : "s"}.`);
  } catch (err) { toast(err.message, "error"); }
}

function videoPayload(v) {
  const p = {
    video_id: v.video_id, url: v.url, title: v.title,
    thumbnail: v.thumbnail, duration: v.duration,
  };
  if (v.collection) p.collection = v.collection;
  return p;
}

function queueAddBody(videos) {
  return JSON.stringify({
    videos,
    source: state.mode,
    quality: state.quality,
    sponsorblock: Array.from(state.sponsorblock),
    sponsorblock_mode: state.sbMode,
  });
}

async function loadPage() {
  const btn = $("#scrape-btn");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  const hint = $("#scrape-hint");
  const prevHint = hint ? hint.textContent : "";
  if (hint && (state.page > 1 || state.filtered)) {
    hint.textContent = "Scanning the channel… filtering the whole channel can take a moment.";
  }
  try {
    const data = await api("/api/scrape", {
      method: "POST",
      body: JSON.stringify({
        url: state.channelUrl,
        page: state.page,
        ignore_shorts: state.ignoreShorts,
        ...filterPayload(),
      }),
    });
    if (data.needs_search) {
      await showChannelSearch(data.query);
      return;
    }
    if (data.resolved_url) state.channelUrl = data.resolved_url;
    // The server may clamp the page (e.g. filtering shrank the result set).
    if (typeof data.page === "number") state.page = data.page;
    state.videos = data.videos || [];
    for (const v of state.videos) state.videoById.set(v.video_id, v);
    state.filtered = !!data.filtered;
    state.totalPages = data.total_pages != null ? data.total_pages : null;
    renderMeta(data);
    renderGrid();
    renderShortsNote(data);
    $("#channel-meta").hidden = false;
    $("#grid-section").hidden = false;
  } catch (err) {
    toast(err.message || String(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3-3"></path></svg>Fetch`;
    if (hint) hint.textContent = prevHint;
  }
}

function renderMeta(data) {
  $("#meta-page").textContent = data.total_pages
    ? `${data.page} / ${data.total_pages}`
    : String(data.page);
  $("#meta-count").textContent = String(data.count || 0);
  updateSelectedCount();
  $("#prev-page").disabled = state.page <= 1;
  if (data.filtered) {
    $("#next-page").disabled = state.page >= (data.total_pages || 1);
  } else {
    // Page off the raw window size, not the post-filter video count — a page
    // whose entries are all hidden Shorts still has more pages behind it.
    const windowSize = data.page_entries != null ? data.page_entries : (data.count || 0);
    $("#next-page").disabled = windowSize < (data.page_size || 50);
  }
  const count = $("#filter-count");
  if (count) {
    if (state.mode === "podcast" && data.total != null) {
      count.textContent = `${data.total} episode${data.total === 1 ? "" : "s"}`;
    } else {
      count.textContent = data.filtered
        ? `${data.total} match${data.total === 1 ? "" : "es"}${data.capped ? " (first 2000)" : ""}`
        : "";
    }
  }
}

function visibleVideos() {
  // Filtering now happens server-side across the whole channel.
  return state.videos;
}

function renderGrid() {
  const grid = $("#video-grid");
  grid.innerHTML = "";
  const items = visibleVideos();
  if (!items.length) {
    $("#grid-empty").hidden = false;
    $("#grid-empty").querySelector("p").textContent = state.mode === "podcast"
      ? "No episodes match."
      : (state.filter.trim() || state.filtered ? "No matches in this channel." : "No videos on this page.");
    return;
  }
  $("#grid-empty").hidden = true;
  for (const v of items) {
    const queued = state.queuedIds.has(v.video_id);
    // Already on disk (and not currently in the queue) → locked out.
    const downloaded = !!v.downloaded && !queued;
    const card = el("article", {
      class: `video-card${queued ? " selected" : ""}${downloaded ? " downloaded" : ""}`,
      "data-id": v.video_id,
      role: "button",
      tabindex: downloaded ? "-1" : "0",
      "aria-pressed": queued ? "true" : "false",
      "aria-disabled": downloaded ? "true" : "false",
      "aria-label": downloaded
        ? `Already downloaded: ${v.title || v.video_id}`
        : `${queued ? "Queued: " : "Queue "}${v.title || v.video_id}`,
    });
    if (!downloaded) {
      card.addEventListener("click", () => toggleCard(v.video_id));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleCard(v.video_id);
        }
      });
    }
    const thumb = el("div", { class: "thumb-wrap" });
    if (v.thumbnail) {
      thumb.appendChild(el("img", { src: v.thumbnail, alt: "", loading: "lazy" }));
    }
    if (v.duration) {
      thumb.appendChild(el("span", { class: "thumb-badge" }, fmtDuration(v.duration)));
    }
    const mark = el("span", { class: "thumb-mark" });
    mark.appendChild(svgEl(`<path d="m5 12 5 5L20 7"/>`, 14));
    thumb.appendChild(mark);
    if (downloaded) {
      thumb.appendChild(el("span", { class: "dl-badge" }, [
        svgEl(`<path d="m5 12 5 5L20 7"/>`, 12), "In library",
      ]));
    }

    const body = el("div", { class: "card-body" }, [
      el("h3", { class: "card-title" }, v.title),
      el("div", { class: "card-meta" }, [
        v.upload_date ? fmtDate(v.upload_date) : "",
        downloaded ? "· downloaded" : (queued ? "· queued" : (v.view_count ? `· ${fmtViews(v.view_count)} views` : "")),
      ].filter(Boolean).join(" ")),
    ]);
    card.appendChild(thumb);
    card.appendChild(body);
    grid.appendChild(card);
  }
  updateSelectedCount();
}

// Clicking a card queues it immediately; clicking a queued (still-pending)
// card removes it. Optimistic UI is reconciled by the SSE queue events.
async function toggleCard(videoId) {
  const v = state.videoById.get(videoId) || state.videos.find((x) => x.video_id === videoId);
  if (!v) return;
  if (state.queuedIds.has(videoId)) {
    const qi = state.queue.find(
      (q) => q.video_id === videoId && (q.status === "pending" || q.status === "paused"),
    );
    if (!qi) { toast("Already downloading or finished — can't unqueue.", "notice"); return; }
    state.queuedIds.delete(videoId);
    markCard(videoId, false);
    updateSelectedCount();
    try { await api("/api/queue/remove", { method: "POST", body: JSON.stringify({ id: qi.id }) }); }
    catch (err) { toast(err.message, "error"); }
  } else {
    state.queuedIds.add(videoId);
    markCard(videoId, true);
    updateSelectedCount();
    try { await api("/api/queue/add", { method: "POST", body: queueAddBody([videoPayload(v)]) }); }
    catch (err) { toast(err.message, "error"); }
  }
}

function markCard(videoId, on) {
  const card = document.querySelector(`.video-card[data-id="${videoId}"]`);
  if (!card) return;
  card.classList.toggle("selected", on);
  card.setAttribute("aria-pressed", on ? "true" : "false");
}

async function selectPage() {
  if (state.mode === "podcast") return queueWholePodcast();
  const toAdd = visibleVideos().filter((v) => !state.queuedIds.has(v.video_id) && !v.downloaded);
  if (!toAdd.length) { toast("Nothing new to queue on this page.", "notice"); return; }
  for (const v of toAdd) { state.queuedIds.add(v.video_id); markCard(v.video_id, true); }
  updateSelectedCount();
  try {
    const r = await api("/api/queue/add", { method: "POST", body: queueAddBody(toAdd.map(videoPayload)) });
    toast(`Queued ${r.count || 0} item${(r.count || 0) === 1 ? "" : "s"}.`);
  } catch (err) { toast(err.message, "error"); }
}

async function clearPageSelection() {
  const removable = state.queue.filter(
    (q) => (q.status === "pending" || q.status === "paused") &&
           state.videos.some((v) => v.video_id === q.video_id),
  );
  if (!removable.length) { toast("Nothing queued on this page to remove.", "notice"); return; }
  for (const q of removable) { state.queuedIds.delete(q.video_id); markCard(q.video_id, false); }
  updateSelectedCount();
  for (const q of removable) {
    try { await api("/api/queue/remove", { method: "POST", body: JSON.stringify({ id: q.id }) }); }
    catch (err) { /* reconciled by SSE */ }
  }
}

function renderShortsNote(data) {
  const note = $("#shorts-skip-note");
  if (!note) return;
  if (state.ignoreShorts && data.skipped_shorts > 0) {
    const scope = data.filtered ? "in this channel" : "on this page";
    note.textContent = `· ${data.skipped_shorts} short${data.skipped_shorts === 1 ? "" : "s"} hidden ${scope}`;
  } else {
    note.textContent = "";
  }
}

// ---------- plain-text channel search ----------

function hideChannelResults() {
  const box = $("#channel-results");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

async function showChannelSearch(query) {
  const box = $("#channel-results");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = "";
  box.appendChild(el("p", { class: "muted channel-results-note" }, `Searching channels for “${query}”…`));
  try {
    const data = await api("/api/search", { method: "POST", body: JSON.stringify({ query }) });
    box.innerHTML = "";
    const channels = data.channels || [];
    if (!channels.length) {
      box.appendChild(el("p", { class: "muted channel-results-note" },
        "No channels found. Try a more specific name or paste the channel URL."));
      return;
    }
    box.appendChild(el("p", { class: "muted channel-results-note" }, "Pick a channel:"));
    for (const c of channels) {
      const btn = el("button", {
        type: "button",
        class: "channel-result",
        onclick: () => {
          state.channelUrl = c.url;
          $("#channel-url").value = c.url;
          hideChannelResults();
          state.page = 1;
          loadPage();
        },
      }, [
        el("span", { class: "channel-result-name" }, c.name),
        el("span", { class: "channel-result-url mono" }, c.url),
      ]);
      box.appendChild(btn);
    }
  } catch (err) {
    box.innerHTML = "";
    box.appendChild(el("p", { class: "muted channel-results-note" }, err.message || "Search failed."));
  }
}

// ---------- SponsorBlock mode + subtitles ----------

function renderSbMode() {
  const seg = $("#sb-mode-seg");
  if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.mode === state.sbMode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function renderSubtitlesPanel() {
  const en = $("#subs-enabled");
  const langs = $("#subs-langs");
  const auto = $("#subs-auto");
  const embed = $("#subs-embed");
  if (en) en.checked = state.subtitles;
  if (langs && document.activeElement !== langs) langs.value = state.subtitleLangs || "en";
  if (auto) auto.checked = state.subtitleAuto;
  if (embed) embed.checked = state.subtitleEmbed;
}

async function saveSubtitles() {
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify({
      subtitles: state.subtitles,
      subtitle_langs: state.subtitleLangs,
      subtitle_auto: state.subtitleAuto,
      subtitle_embed: state.subtitleEmbed,
    }) });
  } catch (err) { toast(err.message, "error"); }
}

function updateSelectedCount() {
  // "Selected" now reflects how many videos on the current page are queued.
  const n = state.videos.filter((v) => state.queuedIds.has(v.video_id)).length;
  const cell = $("#meta-selected");
  if (cell) cell.textContent = String(n);
}

// ---------- settings ----------

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    applySettings(s);
  } catch (err) {
    // non-fatal
  }
  await checkHealth();
}

async function checkHealth() {
  const hint = $("#env-hint");
  if (!hint) return;
  try {
    const h = await api("/api/health");
    const warn = [];
    if (!h.yt_dlp) warn.push("yt-dlp not on PATH");
    if (!h.ffmpeg) warn.push("ffmpeg not on PATH");
    hint.textContent = warn.length
      ? `Missing: ${warn.join(" · ")}. Install before queueing downloads.`
      : "yt-dlp and ffmpeg detected on PATH.";
    hint.style.color = warn.length ? "var(--err-fg)" : "";
    renderEngineStrip(h);
    renderDisk(h);
  } catch (err) {
    // non-fatal
  }
}

function renderEngineStrip(h) {
  const yv = $("#ytdlp-ver");
  const fv = $("#ffmpeg-ver");
  if (yv) {
    yv.textContent = h.yt_dlp
      ? `${h.yt_dlp_version || "ok"}${h.yt_dlp_source === "binary" ? " · binary" : ""}`
      : "missing";
  }
  if (fv) fv.textContent = h.ffmpeg ? (h.ffmpeg_version || "ok") : "missing";
  const upd = $("#update-ytdlp");
  if (upd) upd.disabled = !h.yt_dlp;
  // The standalone binary buffers progress on Windows; nudge toward the module.
  const note = $("#ytdlp-note");
  if (note) {
    if (h.yt_dlp_source === "binary") {
      note.hidden = false;
      note.textContent = "Using the standalone yt-dlp binary — progress can stall on Windows. Run `pip install yt-dlp` so the server can use python -m yt_dlp for live progress.";
    } else {
      note.hidden = true;
    }
  }
}

function renderDisk(h) {
  const read = $("#disk-readout");
  if (read) {
    read.textContent = h.disk_free != null
      ? `${fmtBytes(h.disk_free)} free${h.disk_total ? " / " + fmtBytes(h.disk_total) : ""}`
      : "";
    read.classList.toggle("low", !!h.disk_low);
  }
  const banner = $("#disk-banner");
  if (banner) {
    if (h.disk_low && h.disk_free != null) {
      banner.hidden = false;
      banner.textContent = `Low disk space — only ${fmtBytes(h.disk_free)} free at the destination. Downloads stop below ${fmtBytes(500 * 1024 * 1024)}.`;
    } else {
      banner.hidden = true;
    }
  }
}

function applySettings(s) {
  if (s.download_dir) {
    $("#dest-path").textContent = s.download_dir;
    $("#dest-input").value = s.download_dir;
  }
  if (Array.isArray(s.history)) {
    state.history = s.history;
    renderHistory();
  }
  if (typeof s.concurrency === "number") state.concurrency = s.concurrency;
  if (typeof s.max_concurrency === "number") state.maxConcurrency = s.max_concurrency;
  if (typeof s.embed_metadata === "boolean") state.embedMetadata = s.embed_metadata;
  if (typeof s.embed_thumbnail === "boolean") state.embedThumbnail = s.embed_thumbnail;
  if (typeof s.embed_chapters === "boolean") state.embedChapters = s.embed_chapters;
  if (typeof s.use_archive === "boolean") state.useArchive = s.use_archive;
  if (typeof s.cookies_browser === "string") state.cookiesBrowser = s.cookies_browser;
  if (typeof s.cookies_file === "string") state.cookiesFile = s.cookies_file;
  if (Array.isArray(s.cookie_browsers)) state.cookieBrowsers = s.cookie_browsers;
  if (typeof s.last_quality === "string") state.quality = s.last_quality;
  if (Array.isArray(s.categories)) state.sbCategories = s.categories;
  if (Array.isArray(s.last_sponsorblock)) {
    state.sponsorblock = new Set(s.last_sponsorblock);
  }
  if (typeof s.last_sb_mode === "string") state.sbMode = s.last_sb_mode;
  if (typeof s.subtitles === "boolean") state.subtitles = s.subtitles;
  if (typeof s.subtitle_langs === "string") state.subtitleLangs = s.subtitle_langs;
  if (typeof s.subtitle_auto === "boolean") state.subtitleAuto = s.subtitle_auto;
  if (typeof s.subtitle_embed === "boolean") state.subtitleEmbed = s.subtitle_embed;
  renderSponsorBlock();
  renderSbMode();
  renderSubtitlesPanel();
  renderQuality();
  updateQualityHint();
  renderAdvancedPanel();
}

let persistTimer = null;
function persistChoices() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        last_quality: state.quality,
        last_sponsorblock: Array.from(state.sponsorblock),
        last_sb_mode: state.sbMode,
      }),
    }).catch(() => {});
  }, 300);
}

async function saveEmbedSettings() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        embed_metadata: state.embedMetadata,
        embed_thumbnail: state.embedThumbnail,
        embed_chapters: state.embedChapters,
      }),
    });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveUseArchive() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ use_archive: state.useArchive }),
    });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveCookies() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        cookies_browser: state.cookiesBrowser,
        cookies_file: state.cookiesFile,
      }),
    });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveConcurrency() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ concurrency: state.concurrency }),
    });
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- queue ----------

function recomputeQueuedIds() {
  state.queuedIds = new Set(
    state.queue
      .filter((i) => i.status === "pending" || i.status === "downloading" || i.status === "paused")
      .map((i) => i.video_id)
  );
}

function renderQueue() {
  const list = $("#queue-list");
  const empty = $("#queue-empty");
  $("#q-count").textContent = String(state.queue.length);
  $("#q-meta").textContent = state.queue.length === 1 ? "item" : "items";

  recomputeQueuedIds();
  renderQueueStats();

  list.querySelectorAll(".qitem").forEach((n) => n.remove());
  if (!state.queue.length) {
    if (empty.hidden !== false) freshEmptyLine();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of state.queue) list.appendChild(renderQItem(it));
}

// Roll the queue up into headline numbers, computed client-side from the
// per-item byte/speed fields the server attaches to each event.
function renderQueueStats() {
  const bar = $("#queue-stats");
  if (!bar) return;
  const q = state.queue;
  if (!q.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const active = q.filter((i) => i.status === "downloading");
  const pending = q.filter((i) => i.status === "pending" || i.status === "paused");
  const done = q.filter((i) => i.status === "completed");
  let speed = 0, downloaded = 0, remainingBytes = 0, measurable = false;
  for (const it of active) {
    if (it.speed_bps) speed += it.speed_bps;
    if (it.downloaded_bytes) downloaded += it.downloaded_bytes;
    if (it.total_bytes && it.downloaded_bytes != null) {
      remainingBytes += Math.max(0, it.total_bytes - it.downloaded_bytes);
      measurable = true;
    }
  }
  for (const it of done) if (it.total_bytes) downloaded += it.total_bytes;
  const eta = (measurable && speed > 0) ? remainingBytes / speed : null;
  $("#stat-remaining").textContent = String(active.length + pending.length);
  $("#stat-done").textContent = String(done.length);
  $("#stat-speed").textContent = speed > 0 ? `${fmtBytes(speed)}/s` : "—";
  $("#stat-size").textContent = fmtBytes(downloaded);
  $("#stat-eta").textContent = eta != null ? fmtClock(eta) : "—";
}

function renderQItem(it) {
  const indeterminate = it.status === "downloading" && INDETERMINATE_MESSAGES.has(it.message || "");
  const node = el("div", { class: `qitem ${it.status}`, "data-id": it.id, "data-status": it.status });
  const thumb = el("div", { class: "qthumb" });
  if (it.thumbnail) thumb.appendChild(el("img", { src: it.thumbnail, alt: "", loading: "lazy" }));
  const body = el("div", { class: "qbody" });
  body.appendChild(el("h3", { class: "qtitle" }, it.title || it.video_id));

  const meta = el("div", { class: "qmeta" });
  meta.appendChild(el("span", { class: `qstatus ${it.status}` }, [statusIcon(it.status), statusLabel(it)]));
  if (it.source === "podcast") {
    meta.appendChild(el("span", { class: "qchip qchip-pod" }, "Podcast"));
  } else {
    meta.appendChild(el("span", { class: "qchip" }, qualityLabel(it.quality)));
  }
  if (it.source !== "podcast" && it.status === "pending" && it.sponsorblock && it.sponsorblock.length) {
    const n = it.sponsorblock.length;
    meta.appendChild(el("span", { class: "qchip", title: it.sponsorblock.join(", ") },
      `SponsorBlock · ${n} categor${n === 1 ? "y" : "ies"}`));
  }
  if (it.status === "downloading") {
    const speedChip = el("span", { class: "qchip mono qchip-speed" }, it.speed || "");
    if (!it.speed) speedChip.hidden = true;
    meta.appendChild(speedChip);
    const etaChip = el("span", { class: "qchip mono qchip-eta" }, it.eta ? `eta ${it.eta}` : "");
    if (!it.eta) etaChip.hidden = true;
    meta.appendChild(etaChip);
    meta.appendChild(el("span", { class: "qchip mono qchip-pct" }, `${(it.progress || 0).toFixed(1)}%`));
  }
  if (it.status === "paused" && (it.progress || 0) > 0) {
    meta.appendChild(el("span", { class: "qchip mono" }, `${(it.progress || 0).toFixed(1)}% kept`));
  }
  body.appendChild(meta);

  const bar = el("div", { class: `qprogress${indeterminate ? " indeterminate" : ""}` }, el("div", { class: "bar" }));
  bar.firstChild.style.width = indeterminate ? "100%" : `${Math.max(0, Math.min(100, it.progress || 0))}%`;
  body.appendChild(bar);

  const actions = el("div", { class: "qactions" });
  if (it.status === "downloading" || it.status === "pending") {
    const pauseBtn = el("button", {
      type: "button",
      title: "Pause",
      onclick: () => pauseItem(it.id),
    }, svgEl(`<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`, 14));
    actions.appendChild(pauseBtn);
  }
  if (it.status === "paused") {
    const resumeBtn = el("button", {
      type: "button",
      title: "Resume",
      onclick: () => resumeItem(it.id),
    }, svgEl(`<polygon points="6 4 20 12 6 20 6 4"/>`, 14));
    actions.appendChild(resumeBtn);
  }
  if (it.status === "downloading") {
    const cancelBtn = el("button", {
      type: "button",
      title: "Cancel download",
      class: "danger",
      onclick: () => cancelItem(it.id),
    }, svgEl(`<rect x="6" y="6" width="12" height="12"/>`, 14));
    actions.appendChild(cancelBtn);
  }
  if (it.status === "failed" || it.status === "cancelled") {
    const retryBtn = el("button", {
      type: "button",
      title: "Retry",
      onclick: () => retryItem(it.id),
    }, svgEl(`<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>`, 14));
    actions.appendChild(retryBtn);
  }
  if (it.status === "completed") {
    const revealBtn = el("button", {
      type: "button",
      title: "Reveal in folder",
      onclick: () => revealItem(it.id),
    }, svgEl(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`, 14));
    actions.appendChild(revealBtn);
  }
  // Log viewer — available once a download has started (downloading/finished).
  if (["downloading", "completed", "failed", "cancelled", "paused"].includes(it.status)) {
    const logBtn = el("button", {
      type: "button",
      title: "View log",
      onclick: () => openLog(it.id, it.title || it.video_id),
    }, svgEl(`<path d="M4 6h16M4 12h16M4 18h10"/>`, 14));
    actions.appendChild(logBtn);
  }
  const removeBtn = el("button", {
    type: "button",
    title: "Remove",
    onclick: () => removeItem(it.id),
  }, svgEl(`<path d="M18 6 6 18M6 6l12 12"/>`, 14));
  removeBtn.disabled = it.status === "downloading";
  actions.appendChild(removeBtn);

  node.appendChild(thumb);
  node.appendChild(body);
  node.appendChild(actions);
  return node;
}

function statusIcon(status) {
  if (status === "downloading") return svgEl(`<path d="M12 5v14M5 12h7l3 3 3-3"/>`, 12);
  if (status === "completed")   return svgEl(`<path d="m5 12 5 5L20 7"/>`, 12);
  if (status === "failed")      return svgEl(`<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h0"/>`, 12);
  if (status === "cancelled")   return svgEl(`<path d="M18 6 6 18M6 6l12 12"/>`, 12);
  return svgEl(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`, 12);
}

function statusLabel(it) {
  let verb;
  if (it.status === "pending")          verb = "Queued";
  else if (it.status === "downloading") verb = it.message || "Downloading";
  else if (it.status === "paused")      verb = "Paused";
  else if (it.status === "completed")   verb = "Completed";
  else if (it.status === "failed")      verb = `Failed · ${it.message || ""}`.trim();
  else if (it.status === "cancelled")   verb = "Cancelled";
  else verb = it.status;
  return el("em", { class: "status-verb" }, verb);
}

function qualityLabel(q) {
  const map = { "4k": "4K", "1080p": "1080p", "720p": "720p", "m4a": "M4A", "mp3": "MP3" };
  return map[q] || q;
}

async function removeItem(id) {
  try { await api("/api/queue/remove", { method: "POST", body: JSON.stringify({ id }) }); }
  catch (err) { toast(err.message, "error"); }
}

async function retryItem(id) {
  try {
    await api("/api/queue/retry", { method: "POST", body: JSON.stringify({ id }) });
  } catch (err) { toast(err.message, "error"); }
}

async function cancelItem(id) {
  try {
    await api("/api/queue/cancel", { method: "POST", body: JSON.stringify({ id }) });
  } catch (err) { toast(err.message, "error"); }
}

async function pauseItem(id) {
  try {
    await api("/api/queue/pause-item", { method: "POST", body: JSON.stringify({ id }) });
  } catch (err) { toast(err.message, "error"); }
}

async function resumeItem(id) {
  try {
    await api("/api/queue/resume-item", { method: "POST", body: JSON.stringify({ id }) });
  } catch (err) { toast(err.message, "error"); }
}

async function revealItem(id) {
  try {
    await api("/api/queue/reveal", { method: "POST", body: JSON.stringify({ id }) });
  } catch (err) { toast(err.message, "error"); }
}

async function startQueue() {
  try { await api("/api/queue/start", { method: "POST" }); }
  catch (err) { toast(err.message, "error"); }
}

async function pauseQueue() {
  try { await api("/api/queue/pause", { method: "POST" }); }
  catch (err) { toast(err.message, "error"); }
}

async function clearFinished() {
  const finished = state.queue.filter(
    (i) => i.status === "completed" || i.status === "failed" || i.status === "cancelled"
  ).length;
  if (finished === 0) { toast("Nothing finished to clear.", "notice"); return; }
  if (!confirm(`Remove ${finished} finished item${finished === 1 ? "" : "s"} from the queue?`)) return;
  try { await api("/api/queue/clear", { method: "POST" }); }
  catch (err) { toast(err.message, "error"); }
}

function setRunning(running) {
  state.running = running;
  $("#q-start").hidden = running;
  $("#q-pause").hidden = !running;
}

// ---------- SSE event stream ----------

function setConn(stateName) {
  const pill = $("#conn-pill");
  if (!pill) return;
  pill.dataset.state = stateName;
  const label = pill.querySelector(".conn-label");
  if (label) {
    label.textContent = stateName === "live" ? "live"
      : stateName === "reconnecting" ? "reconnecting…" : "connecting…";
  }
}

function connectEvents() {
  setConn("connecting");
  const src = new EventSource("/api/events");
  src.onopen = () => setConn("live");
  src.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    setConn("live");
    handleEvent(payload);
  };
  // EventSource auto-reconnects; reflect the dropped connection in the meantime.
  src.onerror = () => { if (src.readyState !== EventSource.OPEN) setConn("reconnecting"); };
}

function handleEvent(payload) {
  switch (payload.type) {
    case "snapshot": {
      state.queue = payload.items || [];
      if (typeof payload.running === "boolean") setRunning(payload.running);
      renderQueue();
      renderGrid();
      break;
    }
    case "queued": {
      const it = payload.item;
      if (it) {
        const ix = state.queue.findIndex((x) => x.id === it.id);
        if (ix >= 0) state.queue[ix] = it; else state.queue.push(it);
        renderQueue();
        renderGrid();
      }
      break;
    }
    case "update":
    case "progress": {
      const it = payload.item;
      if (!it) return;
      const ix = state.queue.findIndex((x) => x.id === it.id);
      if (ix >= 0) state.queue[ix] = it;
      else state.queue.push(it);
      if (payload.type === "update") {
        recomputeQueuedIds();
        renderGrid();
      }
      patchQItem(it);
      renderQueueStats();
      // Do NOT infer running-state from progress here: an in-flight download
      // keeps emitting "downloading" events after the user clicks Hold, which
      // would flip the toggle straight back to running. The authoritative
      // running state arrives via "state" events and the reconnect snapshot.
      break;
    }
    case "disk": {
      if (payload.low) {
        toast("Low disk space at the destination — downloads may stop.", "error");
        checkHealth();
      }
      break;
    }
    case "removed": {
      state.queue = state.queue.filter((x) => x.id !== payload.id);
      renderQueue();
      renderGrid();
      break;
    }
    case "cleared": {
      api("/api/queue").then((d) => {
        state.queue = d.items || [];
        renderQueue();
        renderGrid();
      }).catch(() => {});
      break;
    }
    case "state": {
      setRunning(!!payload.running);
      break;
    }
    case "settings": {
      let advancedDirty = false;
      if (payload.download_dir) {
        $("#dest-path").textContent = payload.download_dir;
        $("#dest-input").value = payload.download_dir;
      }
      if (Array.isArray(payload.history)) {
        state.history = payload.history;
        renderHistory();
      }
      if (typeof payload.concurrency === "number") {
        state.concurrency = payload.concurrency;
        advancedDirty = true;
      }
      if ("embed_metadata" in payload) { state.embedMetadata = !!payload.embed_metadata; advancedDirty = true; }
      if ("embed_thumbnail" in payload) { state.embedThumbnail = !!payload.embed_thumbnail; advancedDirty = true; }
      if ("embed_chapters" in payload) { state.embedChapters = !!payload.embed_chapters; advancedDirty = true; }
      if ("use_archive" in payload) { state.useArchive = !!payload.use_archive; advancedDirty = true; }
      if ("cookies_browser" in payload) { state.cookiesBrowser = payload.cookies_browser || ""; advancedDirty = true; }
      if ("cookies_file" in payload) { state.cookiesFile = payload.cookies_file || ""; advancedDirty = true; }
      if (advancedDirty) renderAdvancedPanel();
      break;
    }
  }
}

function patchQItem(it) {
  const node = document.querySelector(`.qitem[data-id="${it.id}"]`);
  if (!node) { renderQueue(); return; }

  // Status changes (pending → downloading → completed/failed) restructure the
  // row enough that a full re-render is cleaner.
  const prevStatus = node.dataset.status || "";
  if (prevStatus !== it.status) {
    const fresh = renderQItem(it);
    node.replaceWith(fresh);
    return;
  }

  // Hot path: in-flight progress updates. Mutate fields in place so the bar
  // transitions smoothly instead of being torn down on every event.
  const indeterminate = it.status === "downloading" && INDETERMINATE_MESSAGES.has(it.message || "");
  const bar = node.querySelector(".qprogress");
  if (bar) {
    bar.classList.toggle("indeterminate", indeterminate);
    const inner = bar.firstChild;
    if (inner) {
      inner.style.width = indeterminate ? "100%" : `${Math.max(0, Math.min(100, it.progress || 0))}%`;
    }
  }
  const verb = node.querySelector(".qstatus .status-verb");
  if (verb) verb.textContent = it.status === "downloading" ? (it.message || "Downloading") : verb.textContent;

  const speedEl = node.querySelector(".qchip-speed");
  const etaEl = node.querySelector(".qchip-eta");
  const pctEl = node.querySelector(".qchip-pct");
  if (speedEl) speedEl.textContent = it.speed || "";
  if (speedEl) speedEl.hidden = !it.speed;
  if (etaEl) etaEl.textContent = it.eta ? `eta ${it.eta}` : "";
  if (etaEl) etaEl.hidden = !it.eta;
  if (pctEl) pctEl.textContent = `${(it.progress || 0).toFixed(1)}%`;
}

// ---------- log viewer ----------

let currentLog = { title: "", text: "" };

async function openLog(id, title) {
  const modal = $("#log-modal");
  const body = $("#log-modal-body");
  const head = $("#log-modal-title");
  if (!modal || !body) return;
  head.textContent = `Log · ${title}`;
  body.textContent = "Loading…";
  currentLog = { title, text: "" };
  modal.hidden = false;
  try {
    // Plain fetch (no JSON request headers on a GET) with explicit error
    // reporting — the shared api() helper masked transport failures as a bare
    // "NetworkError". Retry once: the dev server can drop a request when it is
    // busy streaming SSE + a download at the same moment.
    const url = `/api/queue/log?id=${encodeURIComponent(id)}`;
    let resp;
    try {
      resp = await fetch(url, { method: "GET", cache: "no-store" });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 400));
      resp = await fetch(url, { method: "GET", cache: "no-store" });
    }
    if (!resp.ok) throw new Error(`server returned HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.available) {
      body.textContent = "(no log for this item — per-item logs are kept only for the current server session and are cleared on restart. Run the server with YTARCHIVE_DEBUG=1 to also write timestamped log files to ~/.ytarchive/logs.)";
    } else if (!data.lines.length) {
      body.textContent = "(no output captured yet)";
    } else {
      currentLog.text = data.lines.join("\n");
      body.textContent = currentLog.text;
      body.scrollTop = body.scrollHeight;
    }
  } catch (err) {
    body.textContent =
      `Could not load the log: ${err.message || err}.\n\n` +
      `If this keeps happening, run the server with YTARCHIVE_DEBUG=1 and reproduce the ` +
      `download — a timestamped raw log is written to ~/.ytarchive/logs that you can share.`;
  }
}

function saveLog() {
  if (!currentLog.text) { toast("Nothing to save yet.", "notice"); return; }
  const safe = (currentLog.title || "log").replace(/[^\w.-]+/g, "_").slice(0, 60);
  const blob = new Blob([currentLog.text], { type: "text/plain" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `ytarchive-${safe}.log` });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function closeLog() {
  const modal = $("#log-modal");
  if (modal) modal.hidden = true;
}

// ---------- settings modal ----------

function openSettings() {
  const modal = $("#settings-modal");
  if (modal) modal.hidden = false;
  checkHealth();  // refresh versions / disk while the panel is open
}

function closeSettings() {
  const modal = $("#settings-modal");
  if (modal) modal.hidden = true;
}

// ---------- yt-dlp self-update ----------

async function updateYtdlp() {
  const btn = $("#update-ytdlp");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Updating…";
  try {
    const r = await api("/api/tools/update-ytdlp", { method: "POST" });
    toast(r.ok ? `yt-dlp: ${r.version || "updated"}` : "yt-dlp update reported an issue — see log.",
          r.ok ? "" : "notice");
    if (r.output) {
      const head = $("#log-modal-title");
      const body = $("#log-modal-body");
      if (head && body) { head.textContent = "yt-dlp update"; body.textContent = r.output; $("#log-modal").hidden = false; }
    }
    checkHealth();
  } catch (err) {
    toast(err.message || "Update failed.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- theme (Dusk ⇄ Dawn) ----------

const THEME_COLORS = { dark: "#0f0d0b", light: "#efe6d8" };

function applyTheme(mode) {
  const light = mode === "light";
  if (light) document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? THEME_COLORS.light : THEME_COLORS.dark);
  const tog = $("#theme-toggle");
  if (tog) {
    tog.setAttribute("aria-checked", light ? "true" : "false");
    tog.setAttribute(
      "aria-label",
      light ? "Switch to Dusk (dark) theme" : "Switch to Dawn (light) theme",
    );
  }
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem("theme", next); } catch (e) { /* private mode */ }
}

function initTheme() {
  // The inline <head> script has already set <html data-theme> before paint;
  // re-apply to sync the toggle's aria state and the theme-color meta.
  let stored = null;
  try { stored = localStorage.getItem("theme"); } catch (e) { /* private mode */ }
  const prefersLight = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(stored || (prefersLight ? "light" : "dark"));
}

// ---------- bindings ----------

function bind() {
  $("#scrape-form").addEventListener("submit", (e) => { e.preventDefault(); submitSource(); });
  const modeSeg = $("#mode-seg");
  if (modeSeg) modeSeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  });
  $("#ignore-shorts").addEventListener("change", (e) => {
    state.ignoreShorts = e.target.checked;
    if (state.channelUrl) loadPage();
  });
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page--; loadCurrent(); } });
  $("#next-page").addEventListener("click", () => { state.page++; loadCurrent(); });
  $("#select-page").addEventListener("click", selectPage);
  $("#clear-selection").addEventListener("click", clearPageSelection);

  // Title search (debounced) — whole-channel for YouTube, this feed for podcasts.
  let filterTimer = null;
  const filterInput = $("#grid-filter");
  if (filterInput) {
    filterInput.addEventListener("input", (e) => {
      state.filter = e.target.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { state.page = 1; loadCurrent(); }, 350);
    });
  }

  const sortSelect = $("#sort-select");
  if (sortSelect) sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value;
    state.page = 1;
    loadPage();
  });

  const toggleFilters = $("#toggle-filters");
  if (toggleFilters) toggleFilters.addEventListener("click", () => {
    const adv = $("#advanced-filters");
    if (adv) {
      adv.hidden = !adv.hidden;
      toggleFilters.classList.toggle("active", !adv.hidden);
    }
  });

  const readFilters = () => {
    state.filters = {
      durationMin: $("#f-dur-min").value.trim(),
      durationMax: $("#f-dur-max").value.trim(),
      viewsMin: $("#f-views-min").value.trim(),
      viewsMax: $("#f-views-max").value.trim(),
      dateFrom: $("#f-date-from").value.trim(),
      dateTo: $("#f-date-to").value.trim(),
    };
  };
  const applyBtn = $("#apply-filters");
  if (applyBtn) applyBtn.addEventListener("click", () => { readFilters(); state.page = 1; loadPage(); });
  const resetBtn = $("#reset-filters");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    for (const id of ["f-dur-min", "f-dur-max", "f-views-min", "f-views-max", "f-date-from", "f-date-to"]) {
      const n = document.getElementById(id);
      if (n) n.value = "";
    }
    state.filters = { durationMin: "", durationMax: "", viewsMin: "", viewsMax: "", dateFrom: "", dateTo: "" };
    state.page = 1;
    loadPage();
  });

  // SponsorBlock action mode.
  const sbModeSeg = $("#sb-mode-seg");
  if (sbModeSeg) sbModeSeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      state.sbMode = b.dataset.mode === "mark" ? "mark" : "remove";
      renderSbMode();
      persistChoices();
    });
  });

  // Subtitles.
  const subsEnabled = $("#subs-enabled");
  if (subsEnabled) subsEnabled.addEventListener("change", () => {
    state.subtitles = subsEnabled.checked;
    saveSubtitles();
  });
  const subsLangs = $("#subs-langs");
  if (subsLangs) subsLangs.addEventListener("change", () => {
    state.subtitleLangs = subsLangs.value.trim() || "en";
    saveSubtitles();
  });
  const subsAuto = $("#subs-auto");
  if (subsAuto) subsAuto.addEventListener("change", () => { state.subtitleAuto = subsAuto.checked; saveSubtitles(); });
  const subsEmbed = $("#subs-embed");
  if (subsEmbed) subsEmbed.addEventListener("change", () => { state.subtitleEmbed = subsEmbed.checked; saveSubtitles(); });

  // yt-dlp self-update + log modal.
  const updBtn = $("#update-ytdlp");
  if (updBtn) updBtn.addEventListener("click", updateYtdlp);
  const logClose = $("#log-modal-close");
  if (logClose) logClose.addEventListener("click", closeLog);
  const logSave = $("#log-modal-save");
  if (logSave) logSave.addEventListener("click", saveLog);
  const logModal = $("#log-modal");
  if (logModal) logModal.addEventListener("click", (e) => { if (e.target === logModal) closeLog(); });

  // Settings modal.
  const settingsBtn = $("#settings-btn");
  if (settingsBtn) settingsBtn.addEventListener("click", openSettings);
  const settingsClose = $("#settings-close");
  if (settingsClose) settingsClose.addEventListener("click", closeSettings);
  const settingsModal = $("#settings-modal");
  if (settingsModal) settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettings(); });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLog(); closeSettings(); } });

  $("#dest-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = $("#dest-input").value.trim();
    if (!v) return;
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ download_dir: v }) });
      toast("Destination updated.");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  for (const id of ["embed-metadata", "embed-thumbnail", "embed-chapters"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.addEventListener("change", () => {
      state.embedMetadata = $("#embed-metadata").checked;
      state.embedThumbnail = $("#embed-thumbnail").checked;
      state.embedChapters = $("#embed-chapters").checked;
      saveEmbedSettings();
    });
  }

  const archive = $("#use-archive");
  if (archive) archive.addEventListener("change", () => {
    state.useArchive = archive.checked;
    saveUseArchive();
  });

  const cookiesBrowser = $("#cookies-browser");
  if (cookiesBrowser) cookiesBrowser.addEventListener("change", () => {
    state.cookiesBrowser = cookiesBrowser.value || "";
    saveCookies();
  });
  const cookiesFile = $("#cookies-file");
  if (cookiesFile) cookiesFile.addEventListener("change", () => {
    state.cookiesFile = cookiesFile.value.trim();
    saveCookies();
  });

  const concurrency = $("#concurrency-input");
  if (concurrency) concurrency.addEventListener("change", () => {
    const v = parseInt(concurrency.value, 10);
    if (Number.isFinite(v)) {
      state.concurrency = Math.max(1, Math.min(state.maxConcurrency, v));
      concurrency.value = String(state.concurrency);
      saveConcurrency();
    }
  });

  $("#q-start").addEventListener("click", startQueue);
  $("#q-pause").addEventListener("click", pauseQueue);
  $("#q-clear").addEventListener("click", clearFinished);

  const themeToggle = $("#theme-toggle");
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
}

// ---------- easter eggs 🌱 ----------

// A little purple-pompom confetti, as if a chive flower went to seed.
function blossomBurst(n = 28) {
  const layer = el("div", { class: "blossom-layer", "aria-hidden": "true" });
  document.body.appendChild(layer);
  const glyphs = ["✿", "❀", "•", "✺", "🌱"];
  for (let i = 0; i < n; i++) {
    const p = el("span", { class: "blossom" }, glyphs[(Math.random() * glyphs.length) | 0]);
    p.style.left = Math.random() * 100 + "vw";
    p.style.animationDelay = Math.random() * 0.5 + "s";
    p.style.animationDuration = 2.4 + Math.random() * 1.8 + "s";
    p.style.fontSize = 0.7 + Math.random() * 1.1 + "rem";
    p.style.setProperty("--drift", (Math.random() * 2 - 1) * 140 + "px");
    layer.appendChild(p);
  }
  setTimeout(() => layer.remove(), 4800);
}

function initEasterEggs() {
  // 1. A hello in the console for the curious.
  try {
    console.log(
      "%c🌱 Chive %c— ar·chive everything, snip the fluff.",
      "font-weight:bold;color:#a7d65a",
      "color:#9a8",
    );
    console.log("%cpsst — try the Konami code: ↑ ↑ ↓ ↓ ← → ← → b a", "color:#c9a8e0;font-style:italic");
  } catch (e) { /* no console */ }

  // 2. Konami code → a secret garden of blossoms.
  const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
  let progress = 0;
  window.addEventListener("keydown", (e) => {
    // Don't hijack typing in inputs.
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    progress = key === KONAMI[progress] ? progress + 1 : (key === KONAMI[0] ? 1 : 0);
    if (progress === KONAMI.length) {
      progress = 0;
      blossomBurst(60);
      toast("🌿 Secret garden unlocked — go on, archive something lovely.");
    }
  });

  // 3. Click the wordmark → it blooms; keep clicking for a treat.
  const brand = $("#brand");
  if (brand) {
    let taps = 0, tapTimer = null;
    brand.addEventListener("click", () => {
      brand.classList.remove("bloom");
      void brand.offsetWidth;            // restart the animation
      brand.classList.add("bloom");
      taps++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 1200);
      if (taps >= 5) {
        taps = 0;
        blossomBurst(40);
        toast("🌱 you grew a whole chive. impressive.");
      }
    });
  }
}

// Playful lines for the empty queue — one is picked at random each time it empties.
const EMPTY_LINES = [
  "Nothing queued yet. Click a thumbnail above to plant one.",
  "An empty plot. Click a thumbnail above to start archiving.",
  "Quiet in here. Pick a video above and it lands in the queue.",
  "Nothing growing yet — click a thumbnail to queue it.",
];
function freshEmptyLine() {
  const node = $("#queue-empty");
  if (node) node.textContent = EMPTY_LINES[(Math.random() * EMPTY_LINES.length) | 0];
}

function init() {
  initTheme();
  document.documentElement.dataset.mode = state.mode;
  renderSponsorBlock();
  renderSbMode();
  renderSubtitlesPanel();
  renderQuality();
  updateQualityHint();
  renderAdvancedPanel();
  bind();
  initEasterEggs();
  freshEmptyLine();
  loadSettings();
  connectEvents();
  // Re-check the toolchain so installing yt-dlp/ffmpeg mid-session clears the
  // warning without a manual reload.
  setInterval(checkHealth, 30000);
  window.addEventListener("focus", checkHealth);
}

document.addEventListener("DOMContentLoaded", init);
