// No Title Translate - content.js (Firefox MV3, content-script only)
// Restores original YouTube titles (+ channel names, tab title) via oEmbed.

(() => {
  "use strict";

  const DEBOUNCE_MS = 200;
  const MAX_CONCURRENT = 5;
  const PREFETCH_VIEWPORT_MARGIN = 1.5; // x viewport height

  const WATCH_TITLE_SELECTORS = [
    "h1.ytd-watch-metadata yt-formatted-string",
    "ytd-watch-metadata h1 yt-formatted-string",
    "h1.title yt-formatted-string",
    "ytd-watch-metadata #title yt-formatted-string",
  ];

  const SHORTS_TITLE_SELECTORS = [
    "ytd-reel-player-overlay-renderer h2",
    ".ytd-reel-player-overlay-renderer #title",
    "ytd-reel-player-overlay-renderer yt-formatted-string#title",
  ];

  // Feed title elements across home / search / sidebar / grids / playlists.
  const FEED_TITLE_SELECTOR = [
    "yt-formatted-string#video-title",
    "a#video-title",
    "ytd-video-renderer a#video-title",
    "ytd-compact-video-renderer a#video-title",
    "ytd-rich-item-renderer a#video-title",
    "ytd-playlist-video-renderer a#video-title",
    "ytd-grid-video-renderer a#video-title",
    "ytd-reel-item-renderer a#video-title",
  ].join(",");

  // Containers used to associate a title with its channel element.
  const FEED_CONTAINER_SELECTOR = [
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-rich-item-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-video-renderer",
    "ytd-reel-item-renderer",
  ].join(",");

  const CHANNEL_SELECTOR = [
    "ytd-channel-name a",
    "#channel-name a",
    "ytd-video-owner-renderer ytd-channel-name a",
    "#owner #channel-name a",
  ].join(",");

  const titleCache = new Map(); // videoId -> { title, author }
  const inflight = new Map(); // videoId -> Promise
  let activeFetches = 0;
  const pendingQueue = [];
  let debounceTimer = 0;

  const extApi = globalThis.browser ?? globalThis.chrome;
  let enabled = true; // default on; synced from storage.local below

  function getVideoIdFromHref(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1).split("/")[0];
        return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
      }
      if (!u.hostname.endsWith("youtube.com")) return null;
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[2];
      return null;
    } catch {
      return null;
    }
  }

  function getCurrentVideoId() {
    return getVideoIdFromHref(location.href);
  }

  function fetchOembed(videoId) {
    const cached = titleCache.get(videoId);
    if (cached) return Promise.resolve(cached);
    const running = inflight.get(videoId);
    if (running) return running;
    const p = (async () => {
      try {
        const url =
          "https://www.youtube.com/oembed?url=" +
          encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) +
          "&format=json";
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) return null;
        const data = await res.json();
        const entry = {
          title: typeof data.title === "string" ? data.title : null,
          author: typeof data.author_name === "string" ? data.author_name : null,
        };
        if (entry.title) titleCache.set(videoId, entry);
        return entry.title ? entry : null;
      } catch {
        return null;
      } finally {
        inflight.delete(videoId);
      }
    })();
    inflight.set(videoId, p);
    return p;
  }

  function enqueue(videoId, apply) {
    // De-dup: if already queued, just add callback.
    const existing = pendingQueue.find((q) => q.videoId === videoId);
    if (existing) {
      existing.callbacks.push(apply);
      return;
    }
    pendingQueue.push({ videoId, callbacks: [apply] });
    pumpQueue();
  }

  function pumpQueue() {
    while (activeFetches < MAX_CONCURRENT && pendingQueue.length > 0) {
      const job = pendingQueue.shift();
      activeFetches++;
      fetchOembed(job.videoId).then((entry) => {
        activeFetches--;
        if (entry) {
          for (const cb of job.callbacks) {
            try {
              cb(entry);
            } catch {
              // ignore per-node errors
            }
          }
        }
        pumpQueue();
      });
    }
  }

  function isInPrefetchViewport(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return (
      r.bottom >= -200 && r.top <= window.innerHeight * PREFETCH_VIEWPORT_MARGIN
    );
  }

  function setText(el, text) {
    if (!el || el.textContent === text) return;
    el.textContent = text;
  }

  function applyWatchTitle(entry) {
    for (const sel of WATCH_TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.textContent !== entry.title) setText(el, entry.title);
    }
    // Watch-page channel name (best effort via oEmbed author_name).
    if (entry.author) {
      const owner = document.querySelector(
        "ytd-video-owner-renderer ytd-channel-name a, #owner #channel-name a"
      );
      if (owner && owner.textContent.trim() !== entry.author) {
        setText(owner, entry.author);
      }
    }
    // Tab title.
    if (entry.title && !document.title.startsWith(entry.title)) {
      document.title = entry.title + " - YouTube";
    }
  }

  function processWatchPage() {
    const path = location.pathname;
    const isWatch =
      path.startsWith("/watch") ||
      path.startsWith("/shorts/") ||
      path.startsWith("/live/") ||
      path.startsWith("/embed/");
    if (!isWatch) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const cached = titleCache.get(videoId);
    if (cached) {
      applyWatchTitle(cached);
      return;
    }
    enqueue(videoId, (entry) => {
      // Guard against SPA navigation while fetching, and against disable.
      if (!enabled) return;
      if (getCurrentVideoId() !== videoId) return;
      applyWatchTitle(entry);
    });

    // Shorts overlay renders separately; still covered by applyWatchTitle
    // via WATCH selectors failing -> try shorts selectors immediately with cache.
    if (cached && path.startsWith("/shorts")) {
      for (const sel of SHORTS_TITLE_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) setText(el, cached.title);
      }
    }
  }

  function applyFeedTitleElement(titleEl, entry) {
    setText(titleEl, entry.title);
    const link = titleEl.closest("a") || (titleEl.tagName === "A" ? titleEl : null);
    if (link) {
      if (link.getAttribute("title") && link.getAttribute("title") !== entry.title) {
        link.setAttribute("title", entry.title);
      }
      if (link.getAttribute("aria-label")) {
        // Keep aria-label in sync only if it looks like a title label.
        link.setAttribute("aria-label", entry.title);
      }
    }
    // Associated channel in same container.
    if (entry.author) {
      const container = titleEl.closest(FEED_CONTAINER_SELECTOR);
      const chan =
        container?.querySelector("ytd-channel-name a, #channel-name a") ?? null;
      if (chan && chan.textContent.trim() !== entry.author) {
        setText(chan, entry.author);
      }
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (!enabled) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        io.unobserve(el);
        const videoId = el.dataset.nttVideo;
        if (!videoId) continue;
        enqueue(videoId, (entry) => applyFeedTitleElement(el, entry));
      }
    },
    { rootMargin: "600px 0px" }
  );

  function processFeeds() {
    const nodes = document.querySelectorAll(FEED_TITLE_SELECTOR);
    for (const el of nodes) {
      // Resolve video id from self or nested/parent link.
      let href = null;
      if (el.tagName === "A") href = el.getAttribute("href");
      if (!href) {
        const a = el.closest("a[href]") || el.querySelector("a[href]");
        href = a?.getAttribute("href") ?? null;
      }
      // Some renderers keep href on sibling thumbnail link; walk up to container.
      if (!href) {
        const container = el.closest(FEED_CONTAINER_SELECTOR);
        const a = container?.querySelector('a[href*="watch?v="], a[href*="/shorts/"]');
        href = a?.getAttribute("href") ?? null;
      }
      if (!href) continue;
      const videoId = getVideoIdFromHref(href);
      if (!videoId) continue;
      if (el.dataset.nttDone === videoId) continue;

      const cached = titleCache.get(videoId);
      if (cached) {
        applyFeedTitleElement(el, cached);
        el.dataset.nttDone = videoId;
        continue;
      }
      el.dataset.nttVideo = videoId;
      if (isInPrefetchViewport(el)) {
        el.dataset.nttDone = videoId; // mark queued to avoid duplicates
        enqueue(videoId, (entry) => applyFeedTitleElement(el, entry));
      } else {
        io.observe(el);
        el.dataset.nttDone = videoId; // observed; IO callback applies
      }
    }
  }

  // NOTE on descriptions: oEmbed exposes only title + author_name, so there is
  // no reliable "original description" source without authenticated Innertube
  // calls. YouTube descriptions are also not auto-translated in place (they
  // show a Translate button instead), so we intentionally leave them alone.

  function run() {
    if (!enabled) return;
    processWatchPage();
    processFeeds();
  }

  function resetMarkers() {
    // Allow re-processing of items seen while disabled.
    for (const el of document.querySelectorAll(
      "[data-ntt-done], [data-ntt-video]"
    )) {
      delete el.dataset.nttDone;
      delete el.dataset.nttVideo;
      try {
        io.unobserve(el);
      } catch {
        // not observed
      }
    }
  }

  function schedule() {
    if (debounceTimer) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = 0;
      run();
    }, DEBOUNCE_MS);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("yt-navigate-finish", schedule);
  window.addEventListener("yt-page-data-updated", schedule);
  window.addEventListener("popstate", schedule);

  // Sync on/off toggle (default on). No reload needed to enable;
  // disabling stops future fixes (reload tab to restore translated text).
  try {
    extApi?.storage?.local?.get?.("enabled").then?.((res) => {
      enabled = res?.enabled !== false;
      if (enabled) run();
    });
    extApi?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== "local" || !("enabled" in changes)) return;
      const wasOff = !enabled;
      enabled = changes.enabled.newValue !== false;
      if (enabled && wasOff) {
        resetMarkers();
        run();
      }
    });
  } catch {
    enabled = true;
  }

  run();
})();
