const baseUrlInput = document.getElementById("base-url");
const tokenInput = document.getElementById("token");
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

initialize().catch((error) => setStatus(error.message || "Companion failed to initialize.", "error"));

async function initialize() {
  const stored = await chrome.storage.sync.get({
    baseUrl: "http://127.0.0.1:5000",
    token: ""
  });
  baseUrlInput.value = stored.baseUrl;
  tokenInput.value = stored.token;
  await hydrateFromActiveTab();
}

async function saveSettings(event) {
  event.preventDefault();
  await chrome.storage.sync.set({
    baseUrl: baseUrlInput.value.trim(),
    token: tokenInput.value.trim()
  });
  setStatus("Connection settings saved.", "success");
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
    if (result.kind === "movie" && Number(durationInput.value) === 42) {
      durationInput.value = 100;
      progressDeltaInput.value = 22;
    }
    summaryInput.value = result.summary;
    tabSummary.textContent = `${result.platformLabel} / ${result.pageTitle}`;
  } catch (error) {
    tabSummary.textContent = "The current tab could not be inspected. Open a normal web page and try again.";
    setStatus(error.message || "Tab inspection failed.", "error");
  }
}

async function sendObservation(event) {
  event.preventDefault();
  try {
    const baseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
    const token = tokenInput.value.trim();
    if (!baseUrl || !token) {
      setStatus("App URL and companion token are required.", "error");
      return;
    }

    const payload = {
      title: titleInput.value.trim(),
      kind: kindInput.value,
      platformId: platformInput.value,
      currentUnit: currentUnitInput.value.trim(),
      durationMin: Number(durationInput.value || 0),
      progressDelta: Number(progressDeltaInput.value || 0),
      summary: summaryInput.value.trim(),
      device: deviceInput.value.trim() || "Browser extension",
      sourceLabel: "Browser companion"
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

    setStatus(`Observation sent for ${payload.title}.`, "success");
  } catch (error) {
    setStatus(error.message || "Observation failed.", "error");
  }
}

function setStatus(message, mode) {
  statusElement.textContent = message;
  statusElement.className = `status ${mode || ""}`.trim();
}

function inspectPage() {
  const pageTitle = document.title || "";
  const host = window.location.hostname.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  const metaTitle =
    document.querySelector("meta[property='og:title']")?.content ||
    document.querySelector("meta[name='twitter:title']")?.content ||
    "";
  const chosenTitle = cleanTitle(metaTitle || pageTitle);
  const platform = inferPlatform(host);
  const kind = /\b(movie|film)\b/i.test(pageTitle) || /\/movie\//.test(path) ? "movie" : "show";
  return {
    title: chosenTitle,
    kind,
    platformId: platform.id,
    platformLabel: platform.label,
    currentUnit: kind === "movie" ? "Movie" : inferEpisode(pageTitle),
    pageTitle,
    summary: `Captured from ${platform.label} browser tab.`
  };
}

function inferPlatform(host) {
  if (host.includes("netflix")) return { id: "netflix", label: "Netflix" };
  if (host.includes("primevideo") || host.includes("amazon")) return { id: "prime-video", label: "Prime Video" };
  if (host.includes("disneyplus")) return { id: "disney-plus", label: "Disney+" };
  if (host.includes("max.com") || host.includes("hbomax")) return { id: "max", label: "Max" };
  if (host.includes("apple")) return { id: "apple-tv", label: "Apple TV+" };
  if (host.includes("plex") || host.includes("jellyfin")) return { id: "plex", label: "Plex / Jellyfin" };
  return { id: "netflix", label: "Streaming service" };
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
