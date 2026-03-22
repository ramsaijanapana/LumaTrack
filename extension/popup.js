const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:5000",
  token: "",
  autoCaptureEnabled: true
};

const baseUrlInput = document.getElementById("base-url");
const tokenInput = document.getElementById("token");
const autoCaptureInput = document.getElementById("auto-capture-enabled");
const autoStatusElement = document.getElementById("auto-status");
const lastDeliveryElement = document.getElementById("last-delivery");
const tabSummary = document.getElementById("tab-summary");
const statusElement = document.getElementById("status");
const titleInput = document.getElementById("title");
const kindInput = document.getElementById("kind");
const platformInput = document.getElementById("platform");
const currentUnitInput = document.getElementById("current-unit");
const deviceInput = document.getElementById("device");
const durationInput = document.getElementById("duration");
const progressDeltaInput = document.getElementById("progress-delta");
const summaryInput = document.getElementById("summary");

document.getElementById("settings-form").addEventListener("submit", saveSettings);
document.getElementById("capture-form").addEventListener("submit", sendObservation);
document.getElementById("refresh-tab").addEventListener("click", hydrateFromActiveTab);
document.getElementById("refresh-status").addEventListener("click", refreshRuntimeStatus);

initialize().catch((error) => setStatus(error.message || "Companion failed to initialize.", "error"));

async function initialize() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  baseUrlInput.value = stored.baseUrl;
  tokenInput.value = stored.token;
  autoCaptureInput.checked = Boolean(stored.autoCaptureEnabled);
  await hydrateFromActiveTab();
  await refreshRuntimeStatus();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const baseUrl = normalizeBaseUrl(baseUrlInput.value);
    const token = tokenInput.value.trim();
    if (!baseUrl || !token) {
      setStatus("App URL and companion token are required.", "error");
      return;
    }

    await ensureOriginPermission(baseUrl);
    await chrome.storage.sync.set({
      baseUrl,
      token,
      autoCaptureEnabled: autoCaptureInput.checked
    });
    setStatus(autoCaptureInput.checked ? "Connection saved. Auto-capture armed." : "Connection saved. Auto-capture paused.", "success");
    await refreshRuntimeStatus();
  } catch (error) {
    setStatus(error.message || "Could not save connection.", "error");
  }
}

async function hydrateFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      tabSummary.textContent = "No active tab detected.";
      return;
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: inspectPage
    });

    titleInput.value = result.title;
    kindInput.value = result.kind;
    platformInput.value = result.platformId;
    currentUnitInput.value = result.currentUnit;
    deviceInput.value = result.supportedAutoCapture ? "Browser extension" : "Manual fallback";
    if (result.kind === "movie" && Number(durationInput.value) === 42) {
      durationInput.value = 100;
      progressDeltaInput.value = 22;
    }
    summaryInput.value = result.summary;
    tabSummary.textContent = `${result.platformLabel} / ${result.pageTitle}${result.supportedAutoCapture ? " / auto-capture supported" : ""}`;
    await refreshRuntimeStatus();
  } catch (error) {
    tabSummary.textContent = "The current tab could not be inspected. Open a normal web page and try again.";
    setStatus(error.message || "Tab inspection failed.", "error");
  }
}

async function refreshRuntimeStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await chrome.runtime.sendMessage({
      type: "watchnest:get-status",
      tabUrl: tab?.url || ""
    });

    autoStatusElement.textContent = formatRuntimeStatus(status);
    lastDeliveryElement.textContent = formatLastDelivery(status.lastDelivery);
  } catch (error) {
    autoStatusElement.textContent = "Companion status is unavailable right now.";
    lastDeliveryElement.textContent = error.message || "Status refresh failed.";
  }
}

async function sendObservation(event) {
  event.preventDefault();
  try {
    const baseUrl = normalizeBaseUrl(baseUrlInput.value);
    const token = tokenInput.value.trim();
    if (!baseUrl || !token) {
      setStatus("App URL and companion token are required.", "error");
      return;
    }

    await ensureOriginPermission(baseUrl);

    const payload = {
      title: titleInput.value.trim(),
      kind: kindInput.value,
      platformId: platformInput.value,
      currentUnit: currentUnitInput.value.trim(),
      durationMin: Number(durationInput.value || 0),
      progressDelta: Number(progressDeltaInput.value || 0),
      summary: summaryInput.value.trim(),
      device: deviceInput.value.trim() || "Browser extension",
      sourceLabel: "Manual fallback"
    };

    const response = await fetch(`${baseUrl}/api/ingest/observation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(typeof data === "object" && data?.error ? data.error : `Request failed: ${response.status}`);
    }

    await chrome.storage.local.set({
      lastDelivery: {
        ok: true,
        at: new Date().toISOString(),
        title: payload.title,
        platformLabel: labelFromPlatform(payload.platformId),
        eventType: "manual"
      }
    });
    setStatus(`Observation sent for ${payload.title}.`, "success");
    await refreshRuntimeStatus();
  } catch (error) {
    setStatus(error.message || "Observation failed.", "error");
  }
}

function formatRuntimeStatus(status) {
  if (!status?.configured) {
    return "Add your Watchnest URL and token to arm the companion.";
  }
  if (!status.hasPermission) {
    return "Grant access to your Watchnest URL so the companion can post observations.";
  }
  if (!status.autoCaptureEnabled) {
    return "Auto-capture is configured but paused.";
  }
  if (status.supportedService?.label) {
    return `${status.supportedService.label} tab detected. Auto-capture is armed.`;
  }
  return "Auto-capture is armed for supported services. Use manual fallback elsewhere.";
}

function formatLastDelivery(lastDelivery) {
  if (!lastDelivery?.at) {
    return "No observation sent yet.";
  }
  const parts = [
    lastDelivery.platformLabel || "Watchnest",
    lastDelivery.title || "Recent observation",
    formatRelative(lastDelivery.at)
  ];
  if (Number.isFinite(lastDelivery.progressPercent)) {
    parts.splice(2, 0, `${lastDelivery.progressPercent}%`);
  }
  return `Last: ${parts.filter(Boolean).join(" / ")}`;
}

function setStatus(message, mode) {
  statusElement.textContent = message;
  statusElement.className = `status ${mode || ""}`.trim();
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

async function ensureOriginPermission(baseUrl) {
  const originPattern = originPatternFromBaseUrl(baseUrl);
  const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
  if (alreadyGranted) {
    return originPattern;
  }

  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error("Grant access to your Watchnest URL so the companion can send observations.");
  }
  return originPattern;
}

function labelFromPlatform(platformId) {
  switch (platformId) {
    case "netflix":
      return "Netflix";
    case "prime-video":
      return "Prime Video";
    case "disney-plus":
      return "Disney+";
    case "max":
      return "Max";
    case "apple-tv":
      return "Apple TV+";
    case "plex":
      return "Plex / Jellyfin";
    default:
      return "Streaming service";
  }
}

function inspectPage() {
  const pageTitle = document.title || "";
  const host = window.location.hostname.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  const metaTitle =
    document.querySelector("meta[property='og:title']")?.content ||
    document.querySelector("meta[name='twitter:title']")?.content ||
    "";
  const platform = inferPlatform(host, path);
  const chosenTitle = cleanTitle(metaTitle || pageTitle);
  const kind = /\b(movie|film)\b/i.test(pageTitle) || /\/movie\//.test(path) ? "movie" : "show";

  return {
    title: chosenTitle,
    kind,
    platformId: platform.id,
    platformLabel: platform.label,
    currentUnit: kind === "movie" ? "Movie" : inferEpisode(pageTitle),
    pageTitle,
    supportedAutoCapture: platform.supportedAutoCapture,
    summary: platform.supportedAutoCapture
      ? `Auto-capture supported on ${platform.label}.`
      : `Captured from ${platform.label} browser tab.`
  };
}

function inferPlatform(host, path) {
  if (host.includes("netflix")) return { id: "netflix", label: "Netflix", supportedAutoCapture: true };
  if (host.includes("primevideo") || (host.includes("amazon") && path.includes("/gp/video"))) {
    return { id: "prime-video", label: "Prime Video", supportedAutoCapture: true };
  }
  if (host.includes("disneyplus")) return { id: "disney-plus", label: "Disney+", supportedAutoCapture: true };
  if (host.includes("max.com") || host.includes("hbomax")) return { id: "max", label: "Max", supportedAutoCapture: true };
  if (host === "tv.apple.com") return { id: "apple-tv", label: "Apple TV+", supportedAutoCapture: true };
  if (host.includes("plex") || host.includes("jellyfin")) return { id: "plex", label: "Plex / Jellyfin", supportedAutoCapture: true };
  return { id: "netflix", label: "Streaming service", supportedAutoCapture: false };
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s*[\|\-].*$/, "")
    .replace(/\s+Watch.*$/i, "")
    .trim();
}

function inferEpisode(value) {
  const match = /S\d+\s*E\d+/i.exec(value || "");
  return match ? match[0].replace(/\s+/g, " ") : "S1 E1";
}

function formatRelative(value) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "just now";
  }
  const delta = Date.now() - timestamp;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
