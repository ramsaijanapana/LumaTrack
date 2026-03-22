const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:5000",
  token: "",
  autoCaptureEnabled: true
};

const DELIVERY_STATE = new Map();
const PLATFORM_LABELS = {
  netflix: "Netflix",
  "prime-video": "Prime Video",
  "disney-plus": "Disney+",
  max: "Max",
  "apple-tv": "Apple TV+",
  plex: "Plex"
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({
    ...DEFAULT_SETTINGS,
    ...stored
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "watchnest:auto-capture") {
    handleAutoCapture(message.payload, sender)
      .then(sendResponse)
      .catch(async (error) => {
        const result = {
          ok: false,
          error: error.message || "Auto-capture failed."
        };
        await chrome.storage.local.set({
          lastDelivery: {
            ...result,
            at: new Date().toISOString()
          }
        });
        sendResponse(result);
      });
    return true;
  }

  if (message?.type === "watchnest:get-status") {
    getRuntimeStatus(message.tabUrl)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Status lookup failed."
        });
      });
    return true;
  }

  return false;
});

async function handleAutoCapture(payload, sender) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.autoCaptureEnabled) {
    return {
      ok: true,
      skipped: "disabled"
    };
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const token = String(settings.token || "").trim();
  if (!baseUrl || !token) {
    return {
      ok: true,
      skipped: "missing-config"
    };
  }

  const originPattern = originPatternFromBaseUrl(baseUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    return {
      ok: true,
      skipped: "permission-required"
    };
  }

  const observation = normalizeObservation(payload, sender?.tab?.url || "");
  if (!observation) {
    return {
      ok: true,
      skipped: "invalid-observation"
    };
  }

  const gate = shouldDeliver(observation);
  if (!gate.allowed) {
    return {
      ok: true,
      skipped: gate.reason || "throttled"
    };
  }

  const response = await fetch(`${baseUrl}/api/ingest/observation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(observation)
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(typeof data === "object" && data?.error ? data.error : `Request failed: ${response.status}`);
  }

  rememberDelivery(observation);

  const result = {
    ok: true,
    at: new Date().toISOString(),
    title: observation.title,
    platformLabel: observation.platformLabel || PLATFORM_LABELS[observation.platformId] || observation.platformId,
    progressPercent: observation.progressPercent,
    eventType: observation.eventType
  };
  await chrome.storage.local.set({ lastDelivery: result });
  return result;
}

async function getRuntimeStatus(tabUrl) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const originPattern = baseUrl ? originPatternFromBaseUrl(baseUrl) : "";
  const hasPermission = originPattern
    ? await chrome.permissions.contains({ origins: [originPattern] })
    : false;
  const { lastDelivery = null } = await chrome.storage.local.get({ lastDelivery: null });

  return {
    ok: true,
    autoCaptureEnabled: Boolean(settings.autoCaptureEnabled),
    configured: Boolean(baseUrl && settings.token),
    hasPermission,
    supportedService: inferPlatformFromUrl(tabUrl),
    lastDelivery
  };
}

function normalizeObservation(payload, tabUrl) {
  const title = String(payload?.title || "").trim();
  if (!title) {
    return null;
  }

  const tabPlatform = inferPlatformFromUrl(tabUrl);
  const platformId = payload.platformId || tabPlatform?.id || "netflix";
  const kind = payload.kind === "movie" ? "movie" : "show";
  const progressPercent = clampNumber(payload.progressPercent, 0, 100);
  const eventType = normalizeEventType(payload.eventType);
  const platformLabel = payload.platformLabel || PLATFORM_LABELS[platformId] || tabPlatform?.label || platformId;

  return {
    title,
    kind,
    platformId,
    platformLabel,
    currentUnit: String(payload.currentUnit || (kind === "movie" ? "Movie" : "Episode")).trim(),
    durationMin: clampNumber(payload.durationMin, 1, 600) || (kind === "movie" ? 96 : 44),
    durationSeconds: clampNumber(payload.durationSeconds, 0, 24 * 60 * 60),
    progressPercent: eventType === "ended" ? 100 : progressPercent,
    eventType,
    summary: payload.summary || `Auto-captured from ${platformLabel}.`,
    sessionSummary:
      payload.sessionSummary ||
      `${platformLabel} auto-captured ${title}${payload.currentUnit && kind === "show" ? ` ${payload.currentUnit}` : ""}.`,
    device: payload.device || "Browser auto-capture",
    source: payload.source || "companion-auto",
    sourceLabel: payload.sourceLabel || "Auto capture",
    externalUrl: payload.pageUrl || tabUrl || ""
  };
}

function shouldDeliver(observation) {
  const key = [
    observation.platformId,
    slug(observation.title),
    slug(observation.currentUnit),
    observation.externalUrl || ""
  ].join("::");
  const now = Date.now();
  const progressPercent = Number.isFinite(observation.progressPercent) ? observation.progressPercent : 0;
  const previous = DELIVERY_STATE.get(key);

  if (!previous) {
    if (observation.eventType === "progress" && progressPercent < 3) {
      return { allowed: false, reason: "waiting-for-progress" };
    }
    return { allowed: true };
  }

  if (observation.eventType === "ended" && previous.progressPercent < 100) {
    return { allowed: true };
  }

  if (progressPercent >= previous.progressPercent + 8) {
    return { allowed: true };
  }

  if (observation.eventType !== previous.eventType && now - previous.sentAt > 45_000 && progressPercent >= previous.progressPercent) {
    return { allowed: true };
  }

  if (now - previous.sentAt > 10 * 60 * 1000 && progressPercent > previous.progressPercent) {
    return { allowed: true };
  }

  return { allowed: false, reason: "throttled" };
}

function rememberDelivery(observation) {
  const key = [
    observation.platformId,
    slug(observation.title),
    slug(observation.currentUnit),
    observation.externalUrl || ""
  ].join("::");
  DELIVERY_STATE.set(key, {
    progressPercent: Number.isFinite(observation.progressPercent) ? observation.progressPercent : 0,
    eventType: observation.eventType,
    sentAt: Date.now()
  });
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const trimmedPath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${trimmedPath}`;
  } catch (_error) {
    return "";
  }
}

function originPatternFromBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/*`;
}

function inferPlatformFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host.includes("netflix")) return { id: "netflix", label: "Netflix" };
    if (host.includes("primevideo") || (host.includes("amazon") && path.includes("/gp/video"))) {
      return { id: "prime-video", label: "Prime Video" };
    }
    if (host.includes("disneyplus")) return { id: "disney-plus", label: "Disney+" };
    if (host.includes("max.com") || host.includes("hbomax")) return { id: "max", label: "Max" };
    if (host === "tv.apple.com") return { id: "apple-tv", label: "Apple TV+" };
    if (host.includes("plex")) return { id: "plex", label: "Plex" };
  } catch (_error) {
    return null;
  }
  return null;
}

function normalizeEventType(value) {
  const raw = String(value || "").toLowerCase();
  if (["play", "playing", "loadedmetadata", "navigate"].includes(raw)) return "play";
  if (["resume"].includes(raw)) return "resume";
  if (["pause"].includes(raw)) return "pause";
  if (["ended", "stop"].includes(raw)) return "ended";
  return "progress";
}

function clampNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
