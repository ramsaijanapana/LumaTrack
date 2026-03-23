export const CONNECTOR_DEFINITIONS = [
  {
    id: "netflix",
    name: "Netflix",
    shortName: "Netflix",
    accent: "#e50914",
    defaultMode: "Browser auto-capture",
    summary: "Background browser capture for Netflix playback pages, with manual fallback when needed.",
    capabilities: ["Auto capture", "Manual fallback", "Activity merge"]
  },
  {
    id: "prime-video",
    name: "Prime Video",
    shortName: "Prime",
    accent: "#00a8e1",
    defaultMode: "Browser auto-capture",
    summary: "Background browser capture for Prime Video playback, plus manual fallback.",
    capabilities: ["Auto capture", "Manual fallback", "Queue sync"]
  },
  {
    id: "disney-plus",
    name: "Disney+",
    shortName: "Disney+",
    accent: "#113ccf",
    defaultMode: "Browser auto-capture",
    summary: "Background browser capture for Disney+ playback, with manual fallback kept available.",
    capabilities: ["Auto capture", "Manual fallback", "Watchlist merge"]
  },
  {
    id: "max",
    name: "Max",
    shortName: "Max",
    accent: "#0057ff",
    defaultMode: "Browser auto-capture",
    summary: "Background browser capture for Max playback and continue-watching updates.",
    capabilities: ["Auto capture", "Continue watching", "Manual fallback"]
  },
  {
    id: "apple-tv",
    name: "Apple TV+",
    shortName: "Apple TV+",
    accent: "#333333",
    defaultMode: "Browser auto-capture",
    summary: "Background browser capture for Apple TV+ playback, with manual fallback retained.",
    capabilities: ["Auto capture", "Manual fallback", "Drive sync"]
  },
  {
    id: "plex",
    name: "Plex / Jellyfin",
    shortName: "Plex",
    accent: "#d99000",
    defaultMode: "Webhook or auto-capture",
    summary: "Plex and Tautulli can post playback directly, with browser/manual fallback available.",
    capabilities: ["Plex webhook", "Tautulli", "Manual fallback"]
  }
];

export function createSeedState(displayName = "Viewer", connectorDefinitions = CONNECTOR_DEFINITIONS) {
  const now = new Date().toISOString();
  return {
    meta: {
      schemaVersion: 2,
      appName: "Watchnest",
      createdAt: now,
      updatedAt: now
    },
    profile: {
      name: displayName,
      timezone: getLocalTimezone(),
      posture: "Cloud-backed"
    },
    preferences: {
      density: "comfortable",
      theme: "daybreak"
    },
    sync: {
      mode: "cloud",
      fileName: "",
      linkedAt: null,
      lastSyncedAt: now,
      lastError: "",
      autoSync: true
    },
    filters: {
      search: "",
      status: "all",
      platform: "all",
      kind: "all"
    },
    connectors: connectorDefinitions.map((connector) => ({
      id: connector.id,
      mode: connector.defaultMode,
      status: "available",
      autoTrack: false,
      health: "idle",
      lastSeenAt: null
    })),
    titles: [],
    sessions: []
  };
}

export function normalizeState(candidate, connectorDefinitions = CONNECTOR_DEFINITIONS) {
  const base = createSeedState(candidate?.profile?.name || "Viewer", connectorDefinitions);
  if (!candidate || typeof candidate !== "object") {
    return base;
  }

  const connectorLookup = new Map(
    Array.isArray(candidate.connectors)
      ? candidate.connectors.map((connector) => [connector.id, connector])
      : []
  );

  return {
    meta: {
      ...base.meta,
      ...(candidate.meta || {}),
      schemaVersion: 2,
      appName: "Watchnest"
    },
    profile: {
      ...base.profile,
      ...(candidate.profile || {})
    },
    preferences: {
      ...base.preferences,
      ...(candidate.preferences || {})
    },
    sync: {
      ...base.sync,
      ...(candidate.sync || {})
    },
    filters: {
      ...base.filters,
      ...(candidate.filters || {})
    },
    connectors: connectorDefinitions.map((definition) => ({
      id: definition.id,
      status: "available",
      autoTrack: false,
      health: "idle",
      lastSeenAt: null,
      ...(connectorLookup.get(definition.id) || {}),
      mode: definition.defaultMode
    })),
    titles: normalizeTitles(Array.isArray(candidate.titles) ? candidate.titles : []),
    sessions: normalizeSessions(Array.isArray(candidate.sessions) ? candidate.sessions : [])
  };
}

export function createTitleFromMetadata(result, platformId = "netflix") {
  const now = new Date().toISOString();
  return {
    id: createId("title"),
    sourceId: inferSourceId(result),
    title: result.title || "Untitled",
    kind: result.kind === "movie" ? "movie" : "show",
    year: Number.isFinite(result.year) ? result.year : new Date().getFullYear(),
    runtimeMin: clampNumber(result.runtimeMin, 0, 600),
    platformId,
    serviceLabel: String(result.platformHint || "").trim(),
    status: "queued",
    progress: 0,
    genres: Array.isArray(result.genres) ? result.genres.slice(0, 3) : [],
    currentUnit: result.currentUnit || (result.kind === "movie" ? "Movie" : "S1 E1"),
    summary: result.summary || "Tracked in Watchnest.",
    lastActivityAt: now,
    favorite: false,
    image: result.image || "",
    externalUrl: result.externalUrl || "",
    source: result.source || "manual",
    ratings: normalizeRatings(result.ratings),
    ratingUpdatedAt: isValidDate(result.ratingUpdatedAt) ? result.ratingUpdatedAt : null,
    imdbId: result.imdbId || "",
    userRating: coerceUserRating(result.userRating),
    lastCompletedUnit: String(result.lastCompletedUnit || "").trim()
  };
}

function normalizeTitles(titles) {
  return titles.map((title) => ({
    id: title.id || createId("title"),
    sourceId: inferSourceId(title),
    title: title.title || "Untitled",
    kind: title.kind === "movie" ? "movie" : "show",
    year: Number.isFinite(title.year) ? title.year : new Date().getFullYear(),
    runtimeMin: clampNumber(title.runtimeMin, 0, 600),
    platformId: title.platformId || "netflix",
    serviceLabel: String(title.serviceLabel || "").trim(),
    status: ["watching", "queued", "paused", "completed"].includes(title.status) ? title.status : "queued",
    progress: clampNumber(title.progress, 0, 100),
    genres: Array.isArray(title.genres) ? title.genres.slice(0, 3) : [],
    currentUnit: title.currentUnit || (title.kind === "movie" ? "Movie" : "S1 E1"),
    summary: title.summary || "Tracked in Watchnest.",
    lastActivityAt: isValidDate(title.lastActivityAt) ? title.lastActivityAt : new Date().toISOString(),
    favorite: Boolean(title.favorite),
    image: title.image || "",
    externalUrl: title.externalUrl || "",
    source: title.source || "manual",
    ratings: normalizeRatings(title.ratings),
    ratingUpdatedAt: isValidDate(title.ratingUpdatedAt) ? title.ratingUpdatedAt : null,
    imdbId: title.imdbId || "",
    userRating: coerceUserRating(title.userRating),
    lastCompletedUnit: String(title.lastCompletedUnit || "").trim()
  }));
}

function normalizeSessions(sessions) {
  return sessions
    .map((session) => ({
      id: session.id || createId("session"),
      titleId: session.titleId || "",
      platformId: session.platformId || "netflix",
      startedAt: isValidDate(session.startedAt) ? session.startedAt : new Date().toISOString(),
      durationMin: clampNumber(session.durationMin, 1, 600),
      progressBefore: clampNumber(session.progressBefore, 0, 100),
      progressAfter: clampNumber(session.progressAfter, 0, 100),
      sourceType: ["auto", "manual", "import", "linked"].includes(session.sourceType) ? session.sourceType : "manual",
      sourceLabel: session.sourceLabel || "Tracked",
      device: session.device || "Unknown device",
      currentUnit: session.currentUnit || "",
      eventType: session.eventType || "",
      summary: session.summary || "Watch session tracked."
    }))
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeRatings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((rating) => ({
      source: String(rating?.source || "").trim(),
      value: String(rating?.value || "").trim()
    }))
    .filter((rating) => rating.source && rating.value)
    .slice(0, 4);
}

function coerceUserRating(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.min(10, Math.max(0, Math.round(numeric * 10) / 10));
}

function inferSourceId(value) {
  const explicit = String(value?.sourceId || "").trim();
  if (explicit) {
    return explicit;
  }

  const fallbackId = String(value?.id || "").trim();
  if (fallbackId.startsWith("tvmaze:") || fallbackId.startsWith("wikidata:")) {
    return fallbackId;
  }

  const externalUrl = String(value?.externalUrl || "").trim();
  const tvmazeMatch = /tvmaze\.com\/shows\/(\d+)/i.exec(externalUrl);
  if (tvmazeMatch) {
    return `tvmaze:${tvmazeMatch[1]}`;
  }

  return "";
}

function isValidDate(value) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    return "Local";
  }
}

function createId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 100000)}`;
}
