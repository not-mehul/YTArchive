// YTArchive frontend bridge client.

const SB_CATEGORIES = [
  { id: "sponsor",        label: "Sponsor",            on: true  },
  { id: "selfpromo",      label: "Self-promotion",     on: true  },
  { id: "interaction",    label: "Interaction prompt", on: false },
  { id: "intro",          label: "Intro",              on: false },
  { id: "outro",          label: "Outro",              on: false },
  { id: "preview",        label: "Preview / recap",    on: false },
  { id: "filler",         label: "Filler",             on: false },
  { id: "music_offtopic", label: "Off-topic music",    on: false },
];

const QUALITIES = [
  { id: "4k",    label: "4K"    },
  { id: "1080p", label: "1080p" },
  { id: "720p",  label: "720p"  },
  { id: "m4a",   label: "M4A"   },
  { id: "mp3",   label: "MP3"   },
];

const state = {
  channelUrl: "",
  page: 1,
  ignoreShorts: true,
  videos: [],
  selected: new Set(),  // video_ids currently checked in the grid
  queuedIds: new Set(), // video_ids already on the queue
  quality: "1080p",
  sponsorblock: new Set(SB_CATEGORIES.filter((c) => c.on).map((c) => c.id)),
  queue: [],
  running: false,
};

// ---------- DOM helpers ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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

// ---------- initial render: config controls ----------

function renderSponsorBlock() {
  const grid = $("#sb-grid");
  grid.innerHTML = "";
  for (const cat of SB_CATEGORIES) {
    const id = `sb-${cat.id}`;
    const input = el("input", { type: "checkbox", id });
    input.checked = state.sponsorblock.has(cat.id);
    input.addEventListener("change", () => {
      if (input.checked) state.sponsorblock.add(cat.id);
      else state.sponsorblock.delete(cat.id);
    });
    const box = el("span", { class: "box" }, [
      // check icon, hidden when unchecked
      svgEl(`<path d="m5 12 5 5L20 7"/>`, 12),
    ]);
    grid.appendChild(el("label", { class: "check", for: id }, [input, box, cat.label]));
  }
}

function svgEl(inner, size = 14) {
  const wrap = el("span", { class: "icon" });
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return wrap.firstChild;
}

function renderQuality() {
  const seg = $("#quality-seg");
  seg.innerHTML = "";
  for (const q of QUALITIES) {
    const btn = el("button", {
      type: "button",
      role: "radio",
      "aria-checked": q.id === state.quality ? "true" : "false",
      class: q.id === state.quality ? "active" : "",
    }, q.label);
    btn.addEventListener("click", () => {
      state.quality = q.id;
      renderQuality();
      updateQualityHint();
    });
    seg.appendChild(btn);
  }
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

// ---------- scrape / grid ----------

async function scrape() {
  const url = $("#channel-url").value.trim();
  if (!url) { toast("Enter a channel or playlist URL.", "notice"); return; }
  state.channelUrl = url;
  state.page = 1;
  await loadPage();
}

async function loadPage() {
  const btn = $("#scrape-btn");
  btn.disabled = true;
  btn.textContent = "Fetching…";
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
    state.selected.clear();
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
  }
}

function renderMeta(data) {
  $("#meta-channel").textContent = data.channel || "—";
  $("#meta-page").textContent = String(data.page);
  $("#meta-count").textContent = String(data.count || 0);
  $("#meta-selected").textContent = String(state.selected.size);
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = (data.count || 0) < (data.page_size || 50);
}

function renderGrid() {
  const grid = $("#video-grid");
  grid.innerHTML = "";
  if (!state.videos.length) {
    $("#grid-empty").hidden = false;
    return;
  }
  $("#grid-empty").hidden = true;
  for (const v of state.videos) {
    const queued = state.queuedIds.has(v.video_id);
    const card = el("article", {
      class: `video-card${state.selected.has(v.video_id) ? " selected" : ""}${queued ? " queued" : ""}`,
      "data-id": v.video_id,
    });
    if (!queued) {
      card.addEventListener("click", () => toggleSelect(v.video_id));
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

function fmtViews(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function toggleSelect(videoId) {
  if (state.queuedIds.has(videoId)) return;
  if (state.selected.has(videoId)) state.selected.delete(videoId);
  else state.selected.add(videoId);
  const card = $(`.video-card[data-id="${videoId}"]`);
  if (card) card.classList.toggle("selected", state.selected.has(videoId));
  updateSelectedCount();
}

function updateSelectedCount() {
  $("#meta-selected").textContent = String(state.selected.size);
  $("#queue-selected").disabled = state.selected.size === 0;
}

// ---------- destination ----------

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("#dest-path").textContent = s.download_dir;
    $("#dest-input").value = s.download_dir;
  } catch (err) {
    // non-fatal
  }
  try {
    const h = await api("/api/health");
    const warn = [];
    if (!h.yt_dlp) warn.push("yt-dlp not on PATH");
    if (!h.ffmpeg) warn.push("ffmpeg not on PATH");
    $("#env-hint").textContent = warn.length
      ? `Missing: ${warn.join(" · ")}. Install before queueing downloads.`
      : "yt-dlp and ffmpeg detected on PATH.";
    if (warn.length) $("#env-hint").style.color = "var(--err-fg)";
  } catch (err) {
    // non-fatal
  }
}

// ---------- queue ----------

async function queueSelected() {
  if (state.selected.size === 0) return;
  const videos = state.videos
    .filter((v) => state.selected.has(v.video_id))
    .map((v) => ({
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
    renderGrid();
    toast(`Queued ${r.count || 0} item${(r.count || 0) === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(err.message || String(err), "error");
  }
}

function renderQueue() {
  const list = $("#queue-list");
  const empty = $("#queue-empty");
  $("#q-count").textContent = String(state.queue.length);
  $("#q-meta").textContent = state.queue.length === 1 ? "item" : "items";

  // recompute queuedIds for grid styling
  state.queuedIds = new Set(
    state.queue
      .filter((i) => i.status === "pending" || i.status === "downloading")
      .map((i) => i.video_id)
  );

  list.querySelectorAll(".qitem").forEach((n) => n.remove());
  if (!state.queue.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of state.queue) list.appendChild(renderQItem(it));
}

function renderQItem(it) {
  const node = el("div", { class: `qitem ${it.status}`, "data-id": it.id });
  const thumb = el("div", { class: "qthumb" });
  if (it.thumbnail) thumb.appendChild(el("img", { src: it.thumbnail, alt: "", loading: "lazy" }));
  const body = el("div", { class: "qbody" });
  body.appendChild(el("h3", { class: "qtitle" }, it.title || it.video_id));

  const meta = el("div", { class: "qmeta" });
  meta.appendChild(el("span", { class: `qstatus ${it.status}` }, [statusIcon(it.status), statusLabel(it)]));
  meta.appendChild(el("span", {}, qualityLabel(it.quality)));
  if (it.sponsorblock && it.sponsorblock.length) {
    meta.appendChild(el("span", {}, `cut ${it.sponsorblock.length}`));
  }
  if (it.status === "downloading") {
    if (it.speed) meta.appendChild(el("span", {}, it.speed));
    if (it.eta) meta.appendChild(el("span", {}, `eta ${it.eta}`));
  }
  if (it.status === "downloading" || it.status === "completed") {
    meta.appendChild(el("span", {}, `${(it.progress || 0).toFixed(1)}%`));
  }
  body.appendChild(meta);

  const bar = el("div", { class: "qprogress" }, el("div", { class: "bar" }));
  bar.firstChild.style.width = `${Math.max(0, Math.min(100, it.progress || 0))}%`;
  body.appendChild(bar);

  const actions = el("div", { class: "qactions" });
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
  if (it.status === "pending")     return "Pending";
  if (it.status === "downloading") return it.message || "Downloading";
  if (it.status === "completed")   return "Completed";
  if (it.status === "failed")      return `Failed · ${it.message || ""}`.trim();
  if (it.status === "cancelled")   return "Cancelled";
  return it.status;
}

function qualityLabel(q) {
  const map = { "4k": "4K", "1080p": "1080p", "720p": "720p", "m4a": "M4A", "mp3": "MP3" };
  return map[q] || q;
}

async function removeItem(id) {
  try { await api("/api/queue/remove", { method: "POST", body: JSON.stringify({ id }) }); }
  catch (err) { toast(err.message, "error"); }
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
  src.onerror = () => {
    // Browser auto-reconnects; nothing to do.
  };
}

function handleEvent(payload) {
  switch (payload.type) {
    case "snapshot": {
      state.queue = payload.items || [];
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
      patchQItem(it);
      // status changes can swap the running indicator
      if (it.status === "downloading") setRunning(true);
      break;
    }
    case "removed": {
      state.queue = state.queue.filter((x) => x.id !== payload.id);
      renderQueue();
      break;
    }
    case "cleared": {
      // server-driven full reconcile via a fresh snapshot
      api("/api/queue").then((d) => { state.queue = d.items || []; renderQueue(); }).catch(() => {});
      break;
    }
    case "state": {
      setRunning(!!payload.running);
      break;
    }
    case "settings": {
      if (payload.download_dir) {
        $("#dest-path").textContent = payload.download_dir;
        $("#dest-input").value = payload.download_dir;
      }
      break;
    }
  }
}

function patchQItem(it) {
  const node = document.querySelector(`.qitem[data-id="${it.id}"]`);
  if (!node) { renderQueue(); return; }
  // cheapest path: re-render this single row in place
  const fresh = renderQItem(it);
  node.replaceWith(fresh);
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
    for (const v of state.videos) {
      if (!state.queuedIds.has(v.video_id)) state.selected.add(v.video_id);
    }
    renderGrid();
  });
  $("#clear-selection").addEventListener("click", () => { state.selected.clear(); renderGrid(); });
  $("#queue-selected").addEventListener("click", queueSelected);

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

  $("#q-start").addEventListener("click", startQueue);
  $("#q-pause").addEventListener("click", pauseQueue);
  $("#q-clear").addEventListener("click", clearFinished);
}

function init() {
  renderSponsorBlock();
  renderQuality();
  updateQualityHint();
  bind();
  loadSettings();
  connectEvents();
}

document.addEventListener("DOMContentLoaded", init);
