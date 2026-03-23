(function watchnestAutoCapture() {
  if (window.__watchnestAutoCaptureReady) {
    return;
  }
  window.__watchnestAutoCaptureReady = true;

  const platform = inferPlatform(window.location.hostname, window.location.pathname);
  if (!platform) {
    return;
  }

  const state = {
    video: null,
    videoHandler: null,
    lastDispatchAt: 0,
    lastDispatchSignature: "",
    lastUrl: window.location.href,
    lastTitle: document.title
  };

  const titleSelectors = {
    netflix: [
      "[data-uia='video-title']",
      "[data-uia*='title'] h4",
      "[data-uia*='title']",
      ".video-title h4",
      ".previewModal--player-titleTreatment-logo img",
      ".ltr-1v0p6f7 img",
      "h1",
      "h4"
    ],
    "prime-video": ["[data-automation-id='title']", ".atvwebplayersdk-title-text", "h1", "h2"],
    "disney-plus": ["[data-testid*='title']", "h1", "h2"],
    max: ["[data-testid*='title']", "h1", "h2"],
    "apple-tv": [".product-header__title", "[data-testid*='title']", "h1", "h2"],
    plex: ["[data-testid*='metadata-title']", "h1", "h2", ".metadata-title"]
  };

  const detailSelectors = {
    netflix: ["[data-uia*='episode']", "[data-uia*='subtitle']", "h2", "h3"],
    "prime-video": [".atvwebplayersdk-subtitle-text", "[data-automation-id='subtitle']", "h2", "h3"],
    "disney-plus": ["[data-testid*='subtitle']", "h2", "h3"],
    max: ["[data-testid*='subtitle']", "h2", "h3"],
    "apple-tv": [".product-header__metadata", ".typography-callout", "h2", "h3"],
    plex: [".metadata-subtitle", ".metadata-subtitle-lead", "h2", "h3"]
  };

  initialize();

  function initialize() {
    attachHistoryHooks();
    attachLifecycleHooks();
    watchDomChanges();
    refreshVideoBinding(true);
    window.setInterval(checkPageState, 2000);
    window.setInterval(() => {
      if (state.video && !state.video.paused && !state.video.ended) {
        dispatchSnapshot("heartbeat");
      }
    }, 60000);
  }

  function attachLifecycleHooks() {
    window.addEventListener("focus", () => refreshVideoBinding(false), true);
    window.addEventListener("popstate", () => {
      state.lastUrl = window.location.href;
      state.lastTitle = document.title;
      refreshVideoBinding(true);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refreshVideoBinding(false);
      }
    });
  }

  function attachHistoryHooks() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function") {
        continue;
      }
      history[method] = function wrappedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(() => {
          state.lastUrl = window.location.href;
          state.lastTitle = document.title;
          refreshVideoBinding(true);
        }, 350);
        return result;
      };
    }
  }

  function watchDomChanges() {
    const observer = new MutationObserver(() => {
      if (!state.video || !state.video.isConnected) {
        refreshVideoBinding(false);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function checkPageState() {
    if (window.location.href !== state.lastUrl || document.title !== state.lastTitle) {
      state.lastUrl = window.location.href;
      state.lastTitle = document.title;
      refreshVideoBinding(true);
      return;
    }

    if (!state.video || !state.video.isConnected) {
      refreshVideoBinding(false);
    }
  }

  function refreshVideoBinding(forceDispatch) {
    const nextVideo = pickActiveVideo();
    if (nextVideo !== state.video) {
      detachVideo();
      state.video = nextVideo;
      attachVideo();
    }

    if (forceDispatch) {
      dispatchSnapshot("navigate", true);
    }
  }

  function attachVideo() {
    if (!state.video) {
      return;
    }

    state.videoHandler = (event) => handleVideoEvent(event.type);
    for (const eventName of ["play", "playing", "pause", "ended", "loadedmetadata", "durationchange", "timeupdate"]) {
      state.video.addEventListener(eventName, state.videoHandler, true);
    }

    dispatchSnapshot(state.video.paused ? "loadedmetadata" : "play", true);
  }

  function detachVideo() {
    if (!state.video || !state.videoHandler) {
      return;
    }

    for (const eventName of ["play", "playing", "pause", "ended", "loadedmetadata", "durationchange", "timeupdate"]) {
      state.video.removeEventListener(eventName, state.videoHandler, true);
    }
    state.videoHandler = null;
  }

  function handleVideoEvent(trigger) {
    dispatchSnapshot(trigger);
  }

  function dispatchSnapshot(trigger, force = false) {
    const snapshot = buildSnapshot(trigger);
    if (!snapshot) {
      return;
    }

    const signature = [
      snapshot.title,
      snapshot.currentUnit,
      snapshot.eventType,
      Math.floor((snapshot.progressPercent || 0) / 6)
    ].join("|");
    const now = Date.now();

    if (!force) {
      if (trigger === "timeupdate" || trigger === "heartbeat") {
        if ((snapshot.progressPercent || 0) < 2) {
          return;
        }
        if (signature === state.lastDispatchSignature && now - state.lastDispatchAt < 120000) {
          return;
        }
        if (now - state.lastDispatchAt < 25000) {
          return;
        }
      } else if (signature === state.lastDispatchSignature && now - state.lastDispatchAt < 12000) {
        return;
      }
    }

    state.lastDispatchAt = now;
    state.lastDispatchSignature = signature;
    chrome.runtime.sendMessage(
      {
        type: "watchnest:auto-capture",
        payload: snapshot
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  function buildSnapshot(trigger) {
    if (!state.video) {
      return null;
    }

    const metadata = extractMetadata();
    if (!metadata?.title) {
      return null;
    }

    const durationSeconds = normalizeNumber(state.video.duration);
    const currentSeconds = normalizeNumber(state.video.currentTime);
    const progressPercent =
      durationSeconds > 0 ? clampNumber(Math.round((currentSeconds / durationSeconds) * 100), 0, 100) : 0;
    const kind = metadata.kind === "movie" ? "movie" : "show";
    const eventType = normalizeEventType(trigger);

    return {
      title: metadata.title,
      kind,
      platformId: platform.id,
      platformLabel: platform.label,
      currentUnit: metadata.currentUnit || (kind === "movie" ? "Movie" : "Episode"),
      durationMin: durationSeconds > 0 ? Math.max(1, Math.round(durationSeconds / 60)) : kind === "movie" ? 96 : 44,
      durationSeconds,
      progressPercent: eventType === "ended" ? 100 : progressPercent,
      eventType,
      summary: `Auto-captured from ${platform.label}.`,
      sessionSummary: `${platform.label} auto-captured ${metadata.title}${metadata.currentUnit && kind === "show" ? ` ${metadata.currentUnit}` : ""}.`,
      device: "Browser auto-capture",
      pageUrl: window.location.href
    };
  }

  function extractMetadata() {
    const structured = readStructuredData();
    const textCandidates = collectTextCandidates(titleSelectors[platform.id] || []);
    const detailCandidates = collectTextCandidates(detailSelectors[platform.id] || []);
    const imageAltCandidates = collectAttributeCandidates(
      [
        ".previewModal--player-titleTreatment-logo img",
        "[data-uia*='title'] img",
        "[aria-label*='title' i] img",
        "img[alt]"
      ],
      "alt"
    );
    const pageTitle = cleanTitle(document.title);

    const title = chooseBestTitle([
      structured?.title,
      ...textCandidates,
      ...imageAltCandidates,
      readMetaContent("meta[property='og:title']"),
      readMetaContent("meta[name='twitter:title']"),
      extractTitleFromPathOrHash(),
      pageTitle
    ]);

    if (!title) {
      return null;
    }

    const currentUnit =
      structured?.currentUnit ||
      extractEpisodeLabel([...detailCandidates, document.title, window.location.pathname].join(" | "));
    const kind = structured?.kind || inferKind(currentUnit, [...detailCandidates, document.title].join(" | "), state.video);

    return {
      title,
      kind,
      currentUnit: kind === "movie" ? "Movie" : currentUnit || "Episode"
    };
  }

  function collectTextCandidates(selectors) {
    const values = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = cleanTitle(node.textContent || "");
        if (text && !isGenericText(text)) {
          values.push(text);
        }
      }
    }
    return dedupe(values);
  }

  function collectAttributeCandidates(selectors, attributeName) {
    const values = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = cleanTitle(node.getAttribute(attributeName) || "");
        if (text && !isGenericText(text)) {
          values.push(text);
        }
      }
    }
    return dedupe(values);
  }

  function chooseBestTitle(candidates) {
    for (const candidate of candidates) {
      const cleaned = cleanTitle(candidate || "");
      if (!cleaned || isGenericText(cleaned)) {
        continue;
      }
      const stripped = stripEpisodeBits(cleaned);
      if (stripped && !isGenericText(stripped)) {
        return stripped;
      }
      return cleaned;
    }
    return "";
  }

  function readStructuredData() {
    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const parsed = JSON.parse(script.textContent || "");
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const type = String(item["@type"] || "").toLowerCase();
          if (type === "movie" && item.name) {
            return {
              title: cleanTitle(item.name),
              kind: "movie",
              currentUnit: "Movie"
            };
          }
          if (type === "tvepisode" && (item.partOfSeries?.name || item.name)) {
            return {
              title: cleanTitle(item.partOfSeries?.name || item.name),
              kind: "show",
              currentUnit:
                formatEpisodeLabel(item.partOfSeason?.seasonNumber, item.episodeNumber) || cleanTitle(item.name)
            };
          }
          if (type === "tvseries" && item.name) {
            return {
              title: cleanTitle(item.name),
              kind: "show",
              currentUnit: "Episode"
            };
          }
        }
      } catch (_error) {
        continue;
      }
    }
    return null;
  }

  function pickActiveVideo() {
    const videos = Array.from(document.querySelectorAll("video")).filter((video) => {
      if (!video.isConnected) {
        return false;
      }
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      const hasPlaybackSignal =
        normalizeNumber(video.currentTime) > 0
        || normalizeNumber(video.duration) > 0
        || video.readyState > 0
        || !video.paused;
      return area > 0 || hasPlaybackSignal;
    });

    videos.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftArea = leftRect.width * leftRect.height;
      const rightArea = rightRect.width * rightRect.height;
      const leftScore = (left.paused ? 0 : 100000000) + (normalizeNumber(left.currentTime) > 0 ? 1000000 : 0) + leftArea;
      const rightScore = (right.paused ? 0 : 100000000) + (normalizeNumber(right.currentTime) > 0 ? 1000000 : 0) + rightArea;
      return rightScore - leftScore;
    });

    return videos[0] || null;
  }

  function readMetaContent(selector) {
    return cleanTitle(document.querySelector(selector)?.content || "");
  }

  function extractTitleFromPathOrHash() {
    const raw = `${window.location.pathname} ${window.location.hash}`;
    const match = /title[=/:-]([^/?#&]+)/i.exec(raw) || /watch\/([^/?#&]+)/i.exec(raw);
    if (!match) {
      return "";
    }
    return cleanTitle(decodeURIComponent(match[1]).replace(/[-_]+/g, " "));
  }

  function extractEpisodeLabel(text) {
    const seasonEpisode = /S(?:eason)?\s*(\d+)\s*E(?:pisode)?\s*(\d+)/i.exec(text);
    if (seasonEpisode) {
      return `S${Number(seasonEpisode[1])} E${Number(seasonEpisode[2])}`;
    }

    const verbose = /Season\s*(\d+)\s*Episode\s*(\d+)/i.exec(text);
    if (verbose) {
      return `S${Number(verbose[1])} E${Number(verbose[2])}`;
    }

    const episodeOnly = /Episode\s*(\d+)/i.exec(text);
    if (episodeOnly) {
      return `Episode ${Number(episodeOnly[1])}`;
    }

    return "";
  }

  function inferKind(currentUnit, details, video) {
    if (currentUnit) {
      return "show";
    }
    if (/season|episode|series/i.test(details)) {
      return "show";
    }
    const durationMinutes = normalizeNumber(video?.duration) / 60;
    return durationMinutes >= 70 ? "movie" : "show";
  }

  function stripEpisodeBits(value) {
    return String(value || "")
      .replace(/\s*[:\-|]\s*season\s*\d+.*$/i, "")
      .replace(/\s*[:\-|]\s*episode\s*\d+.*$/i, "")
      .replace(/\s*[:\-|]\s*S\d+\s*E\d+.*$/i, "")
      .trim();
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[|:-]\s*(Netflix|Prime Video|Disney\+|Max|Apple TV\+|Plex).*$/i, "")
      .replace(/^Watch\s+/i, "")
      .replace(/\s+online.*$/i, "")
      .trim();
  }

  function isGenericText(value) {
    const lowered = String(value || "").toLowerCase();
    return [
      "",
      "netflix",
      "prime video",
      "disney+",
      "max",
      "apple tv+",
      "plex",
      "home",
      "browse"
    ].includes(lowered);
  }

  function formatEpisodeLabel(seasonNumber, episodeNumber) {
    const season = Number(seasonNumber);
    const episode = Number(episodeNumber);
    if (Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0) {
      return `S${season} E${episode}`;
    }
    if (Number.isFinite(episode) && episode > 0) {
      return `Episode ${episode}`;
    }
    return "";
  }

  function inferPlatform(hostname, pathname) {
    const host = String(hostname || "").toLowerCase();
    const path = String(pathname || "").toLowerCase();
    if (host.includes("netflix")) return { id: "netflix", label: "Netflix" };
    if (host.includes("primevideo") || (host.includes("amazon") && path.includes("/gp/video"))) {
      return { id: "prime-video", label: "Prime Video" };
    }
    if (host.includes("disneyplus")) return { id: "disney-plus", label: "Disney+" };
    if (host.includes("max.com") || host.includes("hbomax")) return { id: "max", label: "Max" };
    if (host === "tv.apple.com") return { id: "apple-tv", label: "Apple TV+" };
    if (host.includes("plex")) return { id: "plex", label: "Plex" };
    return null;
  }

  function normalizeEventType(trigger) {
    const raw = String(trigger || "").toLowerCase();
    if (["play", "playing", "loadedmetadata", "navigate"].includes(raw)) return "play";
    if (["pause"].includes(raw)) return "pause";
    if (["ended"].includes(raw)) return "ended";
    return "progress";
  }

  function normalizeNumber(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function clampNumber(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return minimum;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }

  function dedupe(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }
})();
