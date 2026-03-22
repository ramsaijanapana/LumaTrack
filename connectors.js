import { CONNECTOR_DEFINITIONS } from "./seed.js";

const DEVICES = [
  "Living room TV",
  "Bedroom TV",
  "Tablet",
  "Laptop",
  "Phone",
  "Office display"
];

export function createConnectorEngine({ getState, onSession }) {
  let timerId = null;

  function start() {
    stop();
    timerId = window.setInterval(() => {
      const state = getState();
      const activeConnectors = state.connectors.filter(
        (connector) => connector.status === "connected" && connector.autoTrack
      );

      if (!activeConnectors.length || Math.random() < 0.42) {
        return;
      }

      const connector = activeConnectors[Math.floor(Math.random() * activeConnectors.length)];
      const session = createAutomaticSession(state, connector.id);
      if (session) {
        onSession(session);
      }
    }, 18000);
  }

  function stop() {
    if (timerId) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function pulse(connectorId) {
    const state = getState();
    return createAutomaticSession(state, connectorId);
  }

  return {
    start,
    stop,
    pulse
  };
}

export function createAutomaticSession(state, connectorId) {
  const title = pickTrackableTitle(state, connectorId);
  if (!title) {
    return null;
  }

  const connector = getConnectorDefinition(connectorId);
  const progressDelta = title.kind === "movie" ? randomBetween(16, 28) : randomBetween(12, 24);
  const durationMin = title.kind === "movie" ? randomBetween(54, 126) : randomBetween(28, 54);
  const progressAfter = Math.min(100, title.progress + progressDelta);

  return {
    id: createId("session"),
    titleId: title.id,
    platformId: title.platformId,
    startedAt: new Date().toISOString(),
    durationMin,
    progressBefore: title.progress,
    progressAfter,
    sourceType: "auto",
    sourceLabel: connector?.defaultMode || "Connector",
    device: DEVICES[Math.floor(Math.random() * DEVICES.length)],
    summary:
      progressAfter >= 100
        ? `${title.title} finished after a connector event from ${connector?.name || "the platform"}.`
        : `${connector?.name || "Connector"} reported fresh playback on ${title.title}.`
  };
}

export function createManualSession(title, options = {}) {
  const progressDelta = Number.isFinite(options.progressDelta)
    ? options.progressDelta
    : title.kind === "movie"
      ? 18
      : 16;
  const progressAfter = Math.min(100, title.progress + progressDelta);

  return {
    id: createId("session"),
    titleId: title.id,
    platformId: title.platformId,
    startedAt: new Date().toISOString(),
    durationMin: options.durationMin || (title.kind === "movie" ? 48 : 34),
    progressBefore: title.progress,
    progressAfter,
    sourceType: options.sourceType || "manual",
    sourceLabel: options.sourceLabel || "Manual check-in",
    device: options.device || "This device",
    summary:
      progressAfter >= 100
        ? `${title.title} was marked complete from inside LumaTrack.`
        : `${title.title} advanced with a manual progress check-in.`
  };
}

export function applySession(state, session) {
  const nextState = clone(state);
  const title = nextState.titles.find((item) => item.id === session.titleId);
  if (!title) {
    return nextState;
  }

  title.progress = session.progressAfter;
  title.lastActivityAt = session.startedAt;
  title.status = session.progressAfter >= 100 ? "completed" : "watching";

  if (title.kind === "show" && title.status !== "completed") {
    title.currentUnit = bumpEpisodeLabel(title.currentUnit);
  }

  nextState.sessions = [session, ...nextState.sessions]
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, 60);

  const connector = nextState.connectors.find((item) => item.id === session.platformId);
  if (connector) {
    connector.lastSeenAt = session.startedAt;
    connector.health = "live";
    if (connector.status !== "paused") {
      connector.status = "connected";
      connector.autoTrack = true;
    }
  }

  nextState.meta.updatedAt = new Date().toISOString();
  return nextState;
}

export function getConnectorDefinition(connectorId) {
  return CONNECTOR_DEFINITIONS.find((connector) => connector.id === connectorId) || null;
}

function pickTrackableTitle(state, connectorId) {
  const matches = state.titles
    .filter((title) => title.platformId === connectorId && title.status !== "completed")
    .sort((left, right) => compareTitlePriority(left, right));

  return matches[0] || null;
}

function compareTitlePriority(left, right) {
  const statusOrder = {
    watching: 0,
    paused: 1,
    queued: 2,
    completed: 3
  };

  const leftRank = statusOrder[left.status] ?? 4;
  const rightRank = statusOrder[right.status] ?? 4;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
}

function bumpEpisodeLabel(label) {
  const match = /S(\d+)\s+E(\d+)/i.exec(label || "");
  if (!match) {
    return label || "Next episode";
  }

  const season = Number(match[1]);
  const episode = Number(match[2]) + 1;
  return `S${season} E${episode}`;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 100000)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
