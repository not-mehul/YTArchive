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
  "Writing metadata",
  "Cutting segments",
]);

const state = {
  channelUrl: "",
  page: 1,
  ignoreShorts: true,
  videos: [],
  filter: "",
  selected: new Set(),
  // video_id -> video payload, kept across page navigation so a multi-page
  // selection survives until it is queued or cleared.
  selectedVideos: new Map(),
  queuedIds: new Set(),
  sbCategories: null,
  quality: "1080p",
  sponsorblock: new Set(["sponsor", "selfpromo"]),
  queue: [],
  running: false,
  history: [],
  concurrency: 1,
  maxConcurrency: 4,
  embedMetadata: true,
  embedThumbnail: true,
  embedChapters: true,
  useArchive: false,
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
      updateConfigSummary();
    });
    const box = el("span", { class: "box" }, [svgEl(`<path d="m5 12 5 5L20 7"/>`, 12)]);
    grid.appendChild(el("label", { class: "check", for: id }, [input, box, SB_LABELS[catId] || catId]));
  }
}

function selectQuality(id) {
  state.quality = id;
  renderQuality();
  updateQualityHint();
  updateConfigSummary();
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

function updateConfigSummary() {
  const node = $("#queue-config-summary");
  if (!node) return;
  const n = state.sponsorblock.size;
  const sb = n === 0 ? "no SponsorBlock cuts" : `cut ${n} SponsorBlock categor${n === 1 ? "y" : "ies"}`;
  node.textContent = `${qualityLabel(state.quality)} · ${sb}`;
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

async function scrape() {
  const url = $("#channel-url").value.trim();
  if (!url) { toast("Enter a channel or playlist URL.", "notice"); return; }
  state.channelUrl = url;
  state.page = 1;
  state.filter = "";
  $("#grid-filter").value = "";
  // A fresh search starts a fresh selection.
  state.selected.clear();
  state.selectedVideos.clear();
  await loadPage();
}

async function loadPage() {
  const btn = $("#scrape-btn");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  const hint = $("#scrape-hint");
  const prevHint = hint ? hint.textContent : "";
  if (hint && state.page > 1) {
    hint.textContent = "Scanning the channel… deep pages can take a moment on large channels.";
  }
  try {
    const data = await api("/api/scrape", {
      method: "POST",
      body: JSON.stringify({
        url: state.channelUrl,
        page: state.page,
        ignore_shorts: state.ignoreShorts,
      }),
    });
    state.videos = data.videos || [];
    // Selection persists across pages — see queueSelected / state.selectedVideos.
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
    if (hint && state.page > 1) hint.textContent = prevHint;
  }
}

function renderMeta(data) {
  $("#meta-channel").textContent = data.channel || "—";
  $("#meta-page").textContent = String(data.page);
  $("#meta-count").textContent = String(data.count || 0);
  $("#meta-selected").textContent = String(state.selected.size);
  $("#prev-page").disabled = state.page <= 1;
  // Page off the raw window size, not the post-filter video count — a page
  // whose entries are all hidden Shorts still has more pages behind it.
  const windowSize = data.page_entries != null ? data.page_entries : (data.count || 0);
  $("#next-page").disabled = windowSize < (data.page_size || 50);
}

function visibleVideos() {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.videos;
  return state.videos.filter((v) => (v.title || "").toLowerCase().includes(needle));
}

function renderGrid() {
  const grid = $("#video-grid");
  grid.innerHTML = "";
  const items = visibleVideos();
  const count = $("#filter-count");
  if (count) {
    if (state.filter.trim()) {
      count.textContent = `${items.length} / ${state.videos.length} match`;
    } else {
      count.textContent = "";
    }
  }
  if (!items.length) {
    $("#grid-empty").hidden = false;
    $("#grid-empty").querySelector("p").textContent =
      state.videos.length === 0 ? "No videos on this page." : "No matches on this page.";
    return;
  }
  $("#grid-empty").hidden = true;
  for (const v of items) {
    const queued = state.queuedIds.has(v.video_id);
    const selected = state.selected.has(v.video_id);
    const card = el("article", {
      class: `video-card${selected ? " selected" : ""}${queued ? " queued" : ""}`,
      "data-id": v.video_id,
      role: "button",
      tabindex: queued ? "-1" : "0",
      "aria-pressed": selected ? "true" : "false",
      "aria-label": `${queued ? "Queued: " : "Select "}${v.title || v.video_id}`,
    });
    if (!queued) {
      card.addEventListener("click", () => toggleSelect(v.video_id));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSelect(v.video_id);
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

    const body = el("div", { class: "card-body" }, [
      el("h3", { class: "card-title" }, v.title),
      el("div", { class: "card-meta" }, [
        v.upload_date ? fmtDate(v.upload_date) : "",
        queued ? "· queued" : (v.view_count ? `· ${fmtViews(v.view_count)} views` : ""),
      ].filter(Boolean).join(" ")),
    ]);
    card.appendChild(thumb);
    card.appendChild(body);
    grid.appendChild(card);
  }
  updateSelectedCount();
}

function renderShortsNote(data) {
  const note = $("#shorts-skip-note");
  if (!note) return;
  if (state.ignoreShorts && data.skipped_shorts > 0) {
    note.textContent = `· ${data.skipped_shorts} short${data.skipped_shorts === 1 ? "" : "s"} hidden on this page`;
  } else {
    note.textContent = "";
  }
}

function toggleSelect(videoId) {
  if (state.queuedIds.has(videoId)) return;
  if (state.selected.has(videoId)) {
    state.selected.delete(videoId);
    state.selectedVideos.delete(videoId);
  } else {
    state.selected.add(videoId);
    const v = state.videos.find((x) => x.video_id === videoId);
    if (v) state.selectedVideos.set(videoId, v);
  }
  const card = document.querySelector(`.video-card[data-id="${videoId}"]`);
  if (card) {
    const on = state.selected.has(videoId);
    card.classList.toggle("selected", on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  $("#meta-selected").textContent = String(state.selected.size);
  $("#queue-selected").disabled = state.selected.size === 0;
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
  } catch (err) {
    // non-fatal
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
  renderSponsorBlock();
  renderQuality();
  updateQualityHint();
  updateConfigSummary();
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

async function queueSelected() {
  if (state.selected.size === 0) return;
  // Pull from the cross-page selection map, not just the current page.
  const videos = Array.from(state.selectedVideos.values()).map((v) => ({
    video_id: v.video_id,
    url: v.url,
    title: v.title,
    thumbnail: v.thumbnail,
    duration: v.duration,
  }));
  try {
    const r = await api("/api/queue/add", {
      method: "POST",
      body: JSON.stringify({
        videos,
        quality: state.quality,
        sponsorblock: Array.from(state.sponsorblock),
      }),
    });
    for (const it of r.added || []) state.queuedIds.add(it.video_id);
    state.selected.clear();
    state.selectedVideos.clear();
    renderGrid();
    toast(`Queued ${r.count || 0} item${(r.count || 0) === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(err.message || String(err), "error");
  }
}

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

  list.querySelectorAll(".qitem").forEach((n) => n.remove());
  if (!state.queue.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of state.queue) list.appendChild(renderQItem(it));
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
  meta.appendChild(el("span", { class: "qchip" }, qualityLabel(it.quality)));
  if (it.status === "pending" && it.sponsorblock && it.sponsorblock.length) {
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

function connectEvents() {
  const src = new EventSource("/api/events");
  src.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    handleEvent(payload);
  };
  src.onerror = () => { /* auto-reconnects */ };
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
      if (it.status === "downloading") setRunning(true);
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
  $("#scrape-form").addEventListener("submit", (e) => { e.preventDefault(); scrape(); });
  $("#ignore-shorts").addEventListener("change", (e) => {
    state.ignoreShorts = e.target.checked;
    if (state.channelUrl) loadPage();
  });
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page--; loadPage(); } });
  $("#next-page").addEventListener("click", () => { state.page++; loadPage(); });
  $("#select-page").addEventListener("click", () => {
    for (const v of visibleVideos()) {
      if (!state.queuedIds.has(v.video_id)) {
        state.selected.add(v.video_id);
        state.selectedVideos.set(v.video_id, v);
      }
    }
    renderGrid();
  });
  $("#clear-selection").addEventListener("click", () => {
    state.selected.clear();
    state.selectedVideos.clear();
    renderGrid();
  });
  $("#queue-selected").addEventListener("click", queueSelected);

  const filterInput = $("#grid-filter");
  if (filterInput) {
    filterInput.addEventListener("input", (e) => {
      state.filter = e.target.value;
      renderGrid();
    });
  }

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

function init() {
  initTheme();
  renderSponsorBlock();
  renderQuality();
  updateQualityHint();
  updateConfigSummary();
  renderAdvancedPanel();
  bind();
  loadSettings();
  connectEvents();
  // Re-check the toolchain so installing yt-dlp/ffmpeg mid-session clears the
  // warning without a manual reload.
  setInterval(checkHealth, 30000);
  window.addEventListener("focus", checkHealth);
}

document.addEventListener("DOMContentLoaded", init);
