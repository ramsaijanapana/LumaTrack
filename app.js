import {
  createToken,
  deleteToken,
  fetchEpisodeOptions,
  fetchBootstrap,
  loginAccount,
  lookupRatings,
  logoutAccount,
  registerAccount,
  saveState,
  searchMetadata
} from "./api.js";
import { applySession, createManualSession, getConnectorDefinition } from "./connectors.js";
import { CONNECTOR_DEFINITIONS, createSeedState, createTitleFromMetadata, normalizeState } from "./seed.js";
import {
  clearLinkedSyncFile,
  downloadSnapshot,
  hasLinkedSyncFile,
  isFileSyncSupported,
  linkSyncFile,
  readLinkedSyncFile,
  readSnapshotFile,
  writeLinkedSyncFile
} from "./store.js";

const appElement = document.getElementById("app");
const snapshotInput = document.getElementById("snapshot-input");
const toastRegion = document.getElementById("toast-region");
const PRIMARY_TOOLS_SELECTOR = "#library-tools";

let connectorDefinitions = CONNECTOR_DEFINITIONS;
let auth = {
  authenticated: false,
  user: null,
  providers: [],
  error: ""
};
let tokens = [];
let state = createSeedState();
let appConfig = {
  baseUrl: "",
  schemaVersion: 2,
  companionReady: true,
  ratingsReady: false,
  ratingsProvider: ""
};
let toastTimer;
let metadataSearchTimer = 0;
let metadataSearchRequestId = 0;
const episodeOptionsCache = new Map();
const episodeOptionsPending = new Set();
const THEME_OPTIONS = [
  { id: "daybreak", label: "Daybreak" },
  { id: "studio", label: "Studio" },
  { id: "midnight", label: "Midnight" }
];

const ui = {
  activeTab: "watchlist",
  authMode: "login",
  authError: "",
  authBusy: false,
  appError: "",
  saveBusy: false,
  metadataQuery: "",
  metadataKind: "all",
  metadataBusy: false,
  metadataError: "",
  metadataResults: [],
  editor: createEmptyEditor(),
  tokenLabel: "Auto capture",
  tokenBusy: false,
  tokenError: "",
  lastCreatedToken: "",
  lastCreatedPreview: "",
  selectedPanel: "search",
  sessionDraft: createEmptySessionDraft(),
  showAdvanced: false
};

initialize().catch((error) => {
  appElement.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>App failed to initialize</h2>
          <p>The server-backed tracker hit an error before rendering.</p>
        </div>
      </div>
      <div class="empty-state">
        <h3>${escapeHtml(error.message || "Unknown error")}</h3>
        <p>Reload the page. If the problem persists, restart the Python server and try again.</p>
      </div>
    </section>
  `;
});

async function initialize() {
  const bootstrap = await fetchBootstrap();
  connectorDefinitions = bootstrap.connectors || CONNECTOR_DEFINITIONS;
  auth = bootstrap.auth || auth;
  ui.authError = auth.error || "";
  appConfig = bootstrap.app || appConfig;
  tokens = Array.isArray(bootstrap.tokens) ? bootstrap.tokens : [];
  if (auth.authenticated && bootstrap.state) {
    state = normalizeState(bootstrap.state, connectorDefinitions);
    await repairLinkedSyncState();
  } else {
    state = createSeedState("Viewer", connectorDefinitions);
  }

  bindEvents();
  render();
  registerServiceWorker();
}

async function repairLinkedSyncState() {
  if (state.sync.mode === "linked-file" && !(await hasLinkedSyncFile())) {
    state.sync.mode = "cloud";
    state.sync.fileName = "";
    state.sync.linkedAt = null;
    state.sync.lastError = "Linked file access needs to be re-authorized on this device.";
    await persistAndRender({ saveRemote: true, toast: null });
  }
}

function bindEvents() {
  appElement.addEventListener("click", handleClick);
  appElement.addEventListener("input", handleInput);
  appElement.addEventListener("change", handleChange);
  appElement.addEventListener("submit", handleSubmit);
  snapshotInput.addEventListener("change", handleSnapshotImport);
}

async function handleClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const {
    action,
    titleId,
    value,
    resultId,
    tokenId,
    url
  } = actionTarget.dataset;

  try {
    switch (action) {
      case "switch-auth-mode":
        ui.authMode = value;
        ui.authError = "";
        render();
        break;
      case "nav":
        ui.activeTab = value || "watchlist";
        render();
        break;
      case "logout":
        await performLogout();
        break;
      case "export-snapshot":
        downloadSnapshot(state);
        showToast("Snapshot exported.");
        break;
      case "import-snapshot":
        snapshotInput.click();
        break;
      case "link-sync-file":
        await connectLinkedFile();
        break;
      case "sync-now":
        await pushLinkedSync();
        break;
      case "pull-linked":
        await pullLinkedSync();
        break;
      case "clear-sync-link":
        await unlinkSyncFile();
        break;
      case "toggle-auto-sync":
        state.sync.autoSync = !state.sync.autoSync;
        await persistAndRender({
          saveRemote: true,
          syncLinked: false,
          toast: state.sync.autoSync ? "Auto sync enabled." : "Auto sync paused."
        });
        break;
      case "filter-status":
        state.filters.status = value;
        render({ domState: captureDomState(event.target) });
        break;
      case "editor-blank":
        ui.editor = createEmptyEditor();
        ui.selectedPanel = "editor";
        render();
        scrollToPrimaryTools();
        break;
      case "editor-cancel":
        resetEditorFlow();
        break;
      case "history-cancel":
        resetHistoryFlow();
        break;
      case "theme-set":
        await setTheme(value);
        break;
      case "editor-edit":
        loadEditorFromTitle(titleId);
        render();
        break;
      case "editor-delete":
        await deleteTitle(titleId);
        break;
      case "title-advance":
        await bumpTitle(titleId);
        break;
      case "title-log-session":
        loadSessionDraftFromTitle(titleId);
        render();
        scrollToPrimaryTools();
        break;
      case "title-mark-next":
        await markNextUnitWatched(titleId);
        break;
      case "title-choose-unit":
        loadSessionDraftFromTitle(titleId);
        ui.activeTab = "search";
        ui.selectedPanel = "history";
        render();
        scrollToPrimaryTools();
        break;
      case "title-ratings-refresh":
        await refreshTitleRatings(titleId, true);
        break;
      case "title-status":
        await cycleTitleStatus(titleId);
        break;
      case "title-favorite":
        await toggleFavorite(titleId);
        break;
      case "select-result":
        loadEditorFromMetadata(resultId);
        render();
        scrollToPrimaryTools();
        break;
      case "quick-add-result":
        await quickAddMetadataResult(resultId);
        break;
      case "panel":
        ui.selectedPanel = value;
        render();
        scrollToPrimaryTools();
        break;
      case "toggle-advanced":
        ui.showAdvanced = !ui.showAdvanced;
        render();
        break;
      case "create-token":
        await createCompanionToken();
        break;
      case "delete-token":
        await removeCompanionToken(tokenId);
        break;
      case "clear-token-reveal":
        ui.lastCreatedToken = "";
        ui.lastCreatedPreview = "";
        render();
        break;
      case "open-external":
        openExternalUrl(url);
        break;
      default:
        break;
    }
  } catch (error) {
    ui.appError = error.message || "Action failed.";
    render();
    showToast(error.message || "Action failed.");
  }
}

function handleInput(event) {
  if (event.target.matches("[data-filter-input='search']")) {
    state.filters.search = event.target.value;
    render({ domState: captureDomState(event.target) });
    return;
  }

  if (event.target.matches("[data-metadata-input='query']")) {
    ui.metadataQuery = event.target.value;
    scheduleMetadataSearch(event.target);
    return;
  }

  if (event.target.matches("[data-token-input='label']")) {
    ui.tokenLabel = event.target.value;
    return;
  }

  if (event.target.matches("[data-editor-field]")) {
    const field = event.target.dataset.editorField;
    ui.editor[field] = event.target.value;
    return;
  }

  if (event.target.matches("[data-session-field]")) {
    const field = event.target.dataset.sessionField;
    ui.sessionDraft[field] = event.target.value;
    return;
  }
}

function handleChange(event) {
  if (event.target.matches("[data-filter-select='platform']")) {
    state.filters.platform = event.target.value;
    render({ domState: captureDomState(event.target) });
    return;
  }

  if (event.target.matches("[data-filter-select='kind']")) {
    state.filters.kind = event.target.value;
    render({ domState: captureDomState(event.target) });
    return;
  }

  if (event.target.matches("[data-metadata-select='kind']")) {
    ui.metadataKind = event.target.value;
    scheduleMetadataSearch(event.target, true);
    return;
  }

  if (event.target.matches("[data-editor-field]")) {
    const field = event.target.dataset.editorField;
    ui.editor[field] = event.target.value;
    if (field === "kind") {
      ui.editor.currentUnit = event.target.value === "movie" ? "Movie" : (ui.editor.currentUnit || "S1 E1");
      render({ domState: captureDomState(event.target) });
      if (ui.editor.kind === "show" && ui.editor.sourceId) {
        void ensureEpisodeOptions(ui.editor.sourceId);
      }
    }
    return;
  }

  if (event.target.matches("[data-session-field]")) {
    const field = event.target.dataset.sessionField;
    ui.sessionDraft[field] = event.target.value;
    return;
  }

  if (event.target.matches("[data-session-title]")) {
    loadSessionDraftFromTitle(event.target.value, true);
    render();
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form.matches("form[data-form]")) {
    return;
  }

  event.preventDefault();
  const { form: formName } = form.dataset;

  try {
    switch (formName) {
      case "login":
        await submitLogin(form);
        break;
      case "register":
        await submitRegister(form);
        break;
      case "metadata-search":
        await runMetadataSearch({ immediate: true, domState: captureDomState(document.activeElement) });
        break;
      case "title-editor":
        await saveEditorTitle();
        break;
      case "token":
        await createCompanionToken();
        break;
      case "manual-session":
        await saveManualSession();
        break;
      default:
        break;
    }
  } catch (error) {
    if (formName === "login" || formName === "register") {
      ui.authBusy = false;
      ui.authError = error.message || "Authentication failed.";
    } else if (formName === "metadata-search") {
      ui.metadataBusy = false;
      ui.metadataError = error.message || "Metadata search failed.";
    } else if (formName === "token") {
      ui.tokenBusy = false;
      ui.tokenError = error.message || "Token action failed.";
    } else if (formName === "manual-session") {
      ui.appError = error.message || "Session entry failed.";
    } else {
      ui.appError = error.message || "Action failed.";
    }
    render();
    showToast(error.message || "Action failed.");
  }
}

async function submitLogin(form) {
  ui.authBusy = true;
  ui.authError = "";
  render();
  const formData = new FormData(form);
  const response = await loginAccount({
    email: formData.get("email"),
    password: formData.get("password")
  });
  auth.authenticated = true;
  auth.user = response.user;
  tokens = response.tokens || [];
  state = normalizeState(response.state, connectorDefinitions);
  ui.authBusy = false;
  ui.appError = "";
  ui.editor = createEmptyEditor();
  ui.sessionDraft = createEmptySessionDraft();
  render();
  showToast(`Signed in as ${response.user.displayName}.`);
}

async function submitRegister(form) {
  ui.authBusy = true;
  ui.authError = "";
  render();
  const formData = new FormData(form);
  const response = await registerAccount({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password")
  });
  auth.authenticated = true;
  auth.user = response.user;
  tokens = response.tokens || [];
  state = normalizeState(response.state, connectorDefinitions);
  ui.authBusy = false;
  ui.appError = "";
  ui.editor = createEmptyEditor();
  ui.sessionDraft = createEmptySessionDraft();
  render();
  showToast(`Account created for ${response.user.displayName}.`);
}

async function performLogout() {
  clearMetadataSearchState();
  await logoutAccount();
  auth = {
    authenticated: false,
    user: null,
    providers: auth.providers
  };
  tokens = [];
  state = createSeedState("Viewer", connectorDefinitions);
  ui.editor = createEmptyEditor();
  ui.sessionDraft = createEmptySessionDraft();
  ui.metadataResults = [];
  ui.metadataError = "";
  render();
  showToast("Signed out.");
}

async function runMetadataSearch({ immediate = false } = {}) {
  const query = ui.metadataQuery.trim();
  const kind = ui.metadataKind;
  clearTimeout(metadataSearchTimer);

  if (query.length < 2) {
    ui.metadataBusy = false;
    ui.metadataError = "";
    ui.metadataResults = [];
    syncSearchPanelUi();
    return;
  }

  const requestId = ++metadataSearchRequestId;
  ui.metadataBusy = true;
  ui.metadataError = "";
  syncSearchPanelUi();

  const executeSearch = async () => {
    try {
      const response = await searchMetadata(query, kind);
      if (requestId !== metadataSearchRequestId || query !== ui.metadataQuery.trim() || kind !== ui.metadataKind) {
        return;
      }
      ui.metadataBusy = false;
      ui.metadataResults = response.results || [];
      ui.metadataError = "";
      syncSearchPanelUi();
    } catch (error) {
      if (requestId !== metadataSearchRequestId) {
        return;
      }
      ui.metadataBusy = false;
      ui.metadataResults = [];
      ui.metadataError = error.message || "Metadata search failed.";
      syncSearchPanelUi();
    }
  };

  if (immediate) {
    await executeSearch();
    return;
  }

  metadataSearchTimer = window.setTimeout(() => {
    void executeSearch();
  }, 220);
}

function scheduleMetadataSearch(_target, immediate = false) {
  void runMetadataSearch({ immediate });
}

function clearMetadataSearchState() {
  clearTimeout(metadataSearchTimer);
  metadataSearchRequestId += 1;
  ui.metadataBusy = false;
  ui.metadataError = "";
  ui.metadataResults = [];
}

function openExternalUrl(url) {
  const normalizedUrl = normalizeExternalUrl(url);
  if (!normalizedUrl) {
    throw new Error("That link is unavailable right now.");
  }

  const anchor = document.createElement("a");
  anchor.href = normalizedUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function resetEditorFlow() {
  ui.editor = createEmptyEditor();
  ui.selectedPanel = "search";
  render();
  scrollToPrimaryTools();
}

function resetHistoryFlow() {
  ui.sessionDraft = createEmptySessionDraft();
  ui.selectedPanel = "search";
  render();
  scrollToPrimaryTools();
}

async function ensureEpisodeOptions(sourceId) {
  if (!sourceId || episodeOptionsCache.has(sourceId) || episodeOptionsPending.has(sourceId)) {
    return;
  }
  episodeOptionsPending.add(sourceId);
  render();
  try {
    const response = await fetchEpisodeOptions(sourceId);
    episodeOptionsCache.set(sourceId, Array.isArray(response.episodes) ? response.episodes : []);
    const show = response.show || {};
    for (const title of state.titles) {
      if (title.sourceId !== sourceId) {
        continue;
      }
      if (!title.image && show.image) {
        title.image = show.image;
      }
      if (!title.externalUrl && show.externalUrl) {
        title.externalUrl = show.externalUrl;
      }
      if ((!Array.isArray(title.ratings) || !title.ratings.length) && Array.isArray(show.ratings) && show.ratings.length) {
        title.ratings = show.ratings;
      }
      if (!title.imdbId && show.imdbId) {
        title.imdbId = show.imdbId;
      }
      if (!title.summary && show.summary) {
        title.summary = show.summary;
      }
    }
  } catch (_error) {
    episodeOptionsCache.set(sourceId, []);
  } finally {
    episodeOptionsPending.delete(sourceId);
    render();
  }
}

async function quickAddMetadataResult(resultId) {
  const result = ui.metadataResults.find((item) => item.id === resultId);
  if (!result) {
    throw new Error("That search result is no longer available.");
  }

  const platformId = inferPlatformId(result.platformHint) || ui.editor.platformId || "netflix";
  const existing = findExistingTitle(result, platformId);
  if (existing) {
    ui.selectedPanel = "editor";
    loadEditorFromTitle(existing.id);
    render();
    scrollToPrimaryTools();
    showToast(`${existing.title} is already in your library.`);
    return;
  }

  const payload = createTitleFromMetadata(result, platformId);
  await maybePopulateRatings(payload, {
    force: appConfig.ratingsReady && (!Array.isArray(payload.ratings) || !payload.ratings.length)
  });
  state.titles.unshift(payload);
  if (payload.kind === "show" && payload.sourceId) {
    void ensureEpisodeOptions(payload.sourceId);
  }
  ui.selectedPanel = "search";
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${payload.title} added to your library.`
  });
}

async function setTheme(themeId) {
  const nextTheme = THEME_OPTIONS.some((theme) => theme.id === themeId) ? themeId : "daybreak";
  if (state.preferences.theme === nextTheme) {
    return;
  }
  state.preferences.theme = nextTheme;
  await persistAndRender({
    saveRemote: auth.authenticated,
    syncLinked: shouldAutoSync(),
    toast: `${labelFromTheme(nextTheme)} theme applied.`
  });
}

async function maybePopulateRatings(payload, { force = false } = {}) {
  if (!appConfig.ratingsReady) {
    return payload;
  }
  if (!force && Array.isArray(payload.ratings) && payload.ratings.length) {
    return payload;
  }

  try {
    const result = await lookupRatings({
      title: payload.title,
      year: payload.year,
      kind: payload.kind,
      imdbId: payload.imdbId || ""
    });
    payload.ratings = Array.isArray(result.ratings) ? result.ratings : [];
    payload.ratingUpdatedAt = result.ratingUpdatedAt || null;
    payload.imdbId = result.imdbId || payload.imdbId || "";
    if (!payload.externalUrl && result.externalUrl) {
      payload.externalUrl = result.externalUrl;
    }
  } catch (_error) {
    // Keep title save resilient even if the optional ratings provider is unavailable.
  }

  return payload;
}

async function saveEditorTitle() {
  const existingTitle = ui.editor.mode === "edit" && ui.editor.titleId ? lookupTitle(ui.editor.titleId) : null;
  const payload = buildTitlePayloadFromEditor();
  const shouldRefreshRatings = Boolean(
    appConfig.ratingsReady && (
      !Array.isArray(payload.ratings)
      || !payload.ratings.length
      || (
        existingTitle
        && (
          existingTitle.title !== payload.title
          || Number(existingTitle.year) !== Number(payload.year)
          || existingTitle.kind !== payload.kind
        )
      )
    )
  );
  await maybePopulateRatings(payload, { force: shouldRefreshRatings });
  if (ui.editor.mode === "edit" && ui.editor.titleId) {
    const title = lookupTitle(ui.editor.titleId);
    if (!title) {
      throw new Error("That title could not be found.");
    }
    Object.assign(title, payload, {
      lastActivityAt: new Date().toISOString()
    });
    if (title.kind === "show" && title.sourceId) {
      void ensureEpisodeOptions(title.sourceId);
    }
    await persistAndRender({
      saveRemote: true,
      syncLinked: shouldAutoSync(),
      toast: `${title.title} updated.`
    });
  } else {
    state.titles.unshift(payload);
    if (payload.kind === "show" && payload.sourceId) {
      void ensureEpisodeOptions(payload.sourceId);
    }
    await persistAndRender({
      saveRemote: true,
      syncLinked: shouldAutoSync(),
      toast: `${payload.title} added to your library.`
    });
  }

  ui.editor = createEmptyEditor();
  ui.selectedPanel = "search";
  render();
}

async function refreshTitleRatings(titleId, toastOnSuccess = false) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }
  if (!appConfig.ratingsReady) {
    showToast("Configure OMDb ratings on the server first.");
    return;
  }

  const payload = await maybePopulateRatings({ ...title }, { force: true });
  title.ratings = payload.ratings || [];
  title.ratingUpdatedAt = payload.ratingUpdatedAt || null;
  title.imdbId = payload.imdbId || title.imdbId || "";
  if (!title.externalUrl && payload.externalUrl) {
    title.externalUrl = payload.externalUrl;
  }
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: toastOnSuccess ? `${title.title} ratings refreshed.` : null
  });
}

async function deleteTitle(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }
  const shouldDelete = window.confirm(`Remove ${title.title} from your library?`);
  if (!shouldDelete) {
    return;
  }
  state.titles = state.titles.filter((item) => item.id !== titleId);
  state.sessions = state.sessions.filter((session) => session.titleId !== titleId);
  if (ui.editor.titleId === titleId) {
    ui.editor = createEmptyEditor();
  }
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${title.title} removed.`
  });
}

async function bumpTitle(titleId) {
  await markNextUnitWatched(titleId);
}

async function cycleTitleStatus(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }

  const nextStatus = nextStatusValue(title.status);
  title.status = nextStatus;
  title.lastActivityAt = new Date().toISOString();

  if (nextStatus === "queued") {
    title.progress = 0;
    title.currentUnit = title.kind === "movie" ? "Movie" : "S1 E1";
  }

  if (nextStatus === "watching" && title.progress === 0) {
    title.progress = 12;
  }

  if (nextStatus === "completed") {
    title.progress = 100;
    title.currentUnit = "Completed";
  }

  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${title.title} marked ${nextStatus}.`
  });
}

async function toggleFavorite(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }

  title.favorite = !title.favorite;
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: title.favorite ? `${title.title} pinned.` : `${title.title} unpinned.`
  });
}

async function createCompanionToken() {
  if (!auth.authenticated) {
    return;
  }
  ui.tokenBusy = true;
  ui.tokenError = "";
  render();
  try {
    const response = await createToken(ui.tokenLabel);
    tokens = [response.created, ...tokens.filter((item) => item.id !== response.created?.id)].filter(Boolean);
    ui.tokenBusy = false;
    ui.lastCreatedToken = response.token;
    ui.lastCreatedPreview = response.created?.preview || "";
    ui.tokenLabel = "Auto capture";
    render();
    showToast("Ingest token created.");
  } catch (error) {
    ui.tokenBusy = false;
    ui.tokenError = error.message || "Token action failed.";
    render();
    throw error;
  }
}

async function removeCompanionToken(tokenId) {
  const numericId = Number(tokenId);
  if (!numericId) {
    return;
  }
  const shouldDelete = window.confirm("Delete this companion token?");
  if (!shouldDelete) {
    return;
  }
  const response = await deleteToken(numericId);
  tokens = response.tokens || [];
  render();
  showToast("Companion token deleted.");
}

async function handleSnapshotImport(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const imported = normalizeState(await readSnapshotFile(file), connectorDefinitions);
    imported.sync = {
      ...imported.sync,
      mode: state.sync.mode,
      fileName: state.sync.fileName,
      linkedAt: state.sync.linkedAt,
      lastSyncedAt: state.sync.lastSyncedAt,
      lastError: "",
      autoSync: state.sync.autoSync
    };
    state = imported;
    await persistAndRender({
      saveRemote: true,
      syncLinked: shouldAutoSync(),
      toast: "Snapshot imported into your account."
    });
  } catch (error) {
    showToast(error.message || "Snapshot import failed.");
  } finally {
    snapshotInput.value = "";
  }
}

async function connectLinkedFile() {
  const result = await linkSyncFile(state);
  state.sync.mode = "linked-file";
  state.sync.fileName = result.fileName;
  state.sync.linkedAt = result.linkedAt;
  state.sync.lastSyncedAt = result.lastSyncedAt;
  state.sync.lastError = "";
  await persistAndRender({
    saveRemote: true,
    syncLinked: false,
    toast: `Linked sync file connected: ${result.fileName}`
  });
}

async function pushLinkedSync() {
  if (state.sync.mode !== "linked-file") {
    showToast("Link a sync file before pushing snapshots.");
    return;
  }

  const result = await writeLinkedSyncFile(state);
  state.sync.lastSyncedAt = result.lastSyncedAt;
  state.sync.fileName = result.fileName;
  state.sync.lastError = "";
  await persistAndRender({
    saveRemote: true,
    syncLinked: false,
    toast: `Snapshot pushed to ${result.fileName}.`
  });
}

async function pullLinkedSync() {
  if (state.sync.mode !== "linked-file") {
    showToast("Link a sync file before pulling remote state.");
    return;
  }

  const imported = normalizeState(await readLinkedSyncFile(), connectorDefinitions);
  imported.sync = {
    ...imported.sync,
    mode: "linked-file",
    fileName: state.sync.fileName,
    linkedAt: state.sync.linkedAt,
    lastSyncedAt: new Date().toISOString(),
    lastError: "",
    autoSync: state.sync.autoSync
  };
  state = imported;
  await persistAndRender({
    saveRemote: true,
    syncLinked: false,
    toast: "State refreshed from the linked sync file."
  });
}

async function unlinkSyncFile() {
  await clearLinkedSyncFile();
  state.sync.mode = "cloud";
  state.sync.fileName = "";
  state.sync.linkedAt = null;
  state.sync.lastSyncedAt = new Date().toISOString();
  state.sync.lastError = "";
  await persistAndRender({
    saveRemote: true,
    syncLinked: false,
    toast: "Linked sync file removed."
  });
}

async function persistAndRender({ saveRemote = false, syncLinked = false, toast = null } = {}) {
  state.meta.updatedAt = new Date().toISOString();
  ui.appError = "";

  if (saveRemote && auth.authenticated) {
    const response = await saveState(state);
    state = normalizeState(response.state, connectorDefinitions);
  }

  if (syncLinked && state.sync.mode === "linked-file") {
    try {
      const result = await writeLinkedSyncFile(state);
      state.sync.lastSyncedAt = result.lastSyncedAt;
      state.sync.fileName = result.fileName;
      state.sync.lastError = "";
      if (saveRemote && auth.authenticated) {
        const response = await saveState(state);
        state = normalizeState(response.state, connectorDefinitions);
      }
    } catch (error) {
      state.sync.lastError = error.message || "Linked file sync failed.";
    }
  }

  render();
  if (toast) {
    showToast(toast);
  }
}

function render({ domState = null } = {}) {
  applyTheme();
  if (!auth.authenticated) {
    document.title = "Watchnest | Your watch home";
    appElement.innerHTML = renderAuthView();
    if (domState) {
      restoreDomState(domState);
    }
    return;
  }

  const filteredTitles = getFilteredTitles();
  const recentSessions = state.sessions.slice(0, 8);
  const stats = getStats();
  const linkedStatus = state.sync.mode === "linked-file" ? "Linked file" : "Cloud account";
  const fileSyncAvailable = isFileSyncSupported();
  const editedTitle = ui.editor.mode === "edit" && ui.editor.titleId ? lookupTitle(ui.editor.titleId) : null;
  primeVisibleEpisodeCaches(filteredTitles);
  appElement.innerHTML = renderAuthenticatedApp({
    filteredTitles,
    recentSessions,
    stats,
    linkedStatus,
    fileSyncAvailable,
    editedTitle
  });
  document.title = `Watchnest | ${stats.totalTitles} tracked`;
  if (domState) {
    restoreDomState(domState);
  }
}

function renderAuthenticatedApp({ filteredTitles, recentSessions, stats, linkedStatus, fileSyncAvailable, editedTitle }) {
  return `
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-row">
          <span class="brand-mark" aria-hidden="true">WN</span>
          <div>
            <span class="eyebrow">Watch home</span>
            <h1 class="brand-title">Watchnest</h1>
          </div>
        </div>
        <p class="brand-copy">Pick up the right episode, rate what you watched, and keep upcoming releases in view.</p>
      </div>
      <div class="status-strip">
        <span class="status-pill"><strong>${escapeHtml(auth.user.displayName)}</strong> signed in</span>
        <span class="status-pill"><strong>${stats.totalTitles}</strong> titles</span>
        <span class="status-pill"><strong>${escapeHtml(formatRelative(state.meta.updatedAt))}</strong> updated</span>
        <div class="theme-switch" aria-label="Theme switcher">
          ${THEME_OPTIONS.map((theme) => `
            <button class="chip-button ${state.preferences.theme === theme.id ? "primary" : ""}" data-action="theme-set" data-value="${theme.id}">
              ${escapeHtml(theme.label)}
            </button>
          `).join("")}
        </div>
        <button class="button ghost" data-action="logout">Sign out</button>
      </div>
    </header>

    <nav class="main-tabs" aria-label="Primary navigation">
      ${renderMainTabButton("watchlist", "Watchlist")}
      ${renderMainTabButton("search", "Add & update")}
      ${renderMainTabButton("setup", "Setup")}
    </nav>

    ${ui.appError ? `<div class="panel-note app-inline-note">${escapeHtml(ui.appError)}</div>` : ""}

    ${ui.activeTab === "search"
      ? renderSearchTab(editedTitle)
      : ui.activeTab === "setup"
        ? renderSetupTab(linkedStatus, fileSyncAvailable)
        : renderWatchlistTab(filteredTitles, recentSessions)}
  `;
}

function renderMainTabButton(tabId, label) {
  return `<button class="main-tab ${ui.activeTab === tabId ? "active" : ""}" data-action="nav" data-value="${tabId}">${escapeHtml(label)}</button>`;
}

function renderWatchlistTab(filteredTitles, recentSessions) {
  const watchStates = filteredTitles.map((title) => ({ title, state: getTitleWatchState(title) }));
  const activeTitles = watchStates.filter((entry) => !entry.state.comingSoon && entry.title.status !== "completed");
  const completedTitles = watchStates.filter((entry) => entry.title.status === "completed" && !entry.state.comingSoon);
  const comingSoonTitles = watchStates.filter((entry) => entry.state.comingSoon);

  return `
    <section class="dashboard-grid">
      <section class="panel section-panel" data-section="library">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Watchlist</span>
            <h2>Keep moving forward.</h2>
            <p>See what to watch next, what is coming soon, and what you already finished.</p>
          </div>
          <div class="panel-actions library-tools-inline">
            <input class="search-bar" data-filter-input="search" type="search" value="${escapeAttribute(state.filters.search)}" placeholder="Filter your library">
            <select class="select-field" data-filter-select="platform" aria-label="Filter by platform">
              ${renderPlatformOptions(state.filters.platform)}
            </select>
            <select class="select-field" data-filter-select="kind" aria-label="Filter by type">
              <option value="all" ${state.filters.kind === "all" ? "selected" : ""}>All types</option>
              <option value="show" ${state.filters.kind === "show" ? "selected" : ""}>Shows</option>
              <option value="movie" ${state.filters.kind === "movie" ? "selected" : ""}>Movies</option>
            </select>
          </div>
        </div>
        <div class="filter-row" aria-label="Status filters">
          ${["all", "watching", "queued", "paused", "completed"]
            .map((filter) => `<button class="filter-chip ${state.filters.status === filter ? "active" : ""}" data-action="filter-status" data-value="${filter}">${labelFromStatus(filter)}</button>`)
            .join("")}
        </div>

        ${activeTitles.length ? `
          <div class="section-subhead">
            <h3>Watch next</h3>
            <p>Quick actions move each title to the next episode automatically.</p>
          </div>
          <div class="library-rail">
            ${activeTitles.map(({ title }) => renderTitleCard(title)).join("")}
          </div>
        ` : renderEmptyState(
          "Nothing in progress yet.",
          "Search on the right, add a title, and your next episode will appear here."
        )}

        ${comingSoonTitles.length ? `
          <div class="section-subhead">
            <h3>Coming soon</h3>
            <p>Upcoming episodes and next seasons stay visible until release day.</p>
          </div>
          <div class="library-rail">
            ${comingSoonTitles.map(({ title }) => renderTitleCard(title)).join("")}
          </div>
        ` : ""}

        ${completedTitles.length ? `
          <div class="section-subhead">
            <h3>Completed</h3>
            <p>Finished titles stay compact, with ratings and source links intact.</p>
          </div>
          <div class="library-rail completed">
            ${completedTitles.slice(0, 12).map(({ title }) => renderTitleCard(title)).join("")}
          </div>
        ` : ""}
      </section>

      <aside class="stacked-panels">
        <section class="panel section-panel" data-section="search" id="library-tools">
          <div class="panel-head">
            <div>
              <span class="eyebrow">Add titles</span>
              <h2>Search on the side.</h2>
              <p>Add something new or update where you are in one place.</p>
            </div>
          </div>
          ${renderSearchWorkspace(ui.editor.mode === "edit" && ui.editor.titleId ? lookupTitle(ui.editor.titleId) : null, true)}
        </section>

        <section class="panel section-panel" data-section="activity">
          <div class="panel-head">
            <div>
              <span class="eyebrow">Recent</span>
              <h2>Latest watch updates.</h2>
              <p>Episode completions and manual check-ins only.</p>
            </div>
          </div>
          <div class="timeline-list compact">
            ${recentSessions.length ? recentSessions.map((session) => renderSessionCard(session)).join("") : renderEmptyState("No watch updates yet.", "Mark an episode watched and it will show up here.")}
          </div>
        </section>
      </aside>
    </section>
  `;
}

function renderSearchTab(editedTitle) {
  return `
    <section class="panel section-panel search-tab-shell" data-section="search" id="library-tools">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Add and update</span>
          <h2>Search, add, or mark watched.</h2>
          <p>Use the tabs below to add something new or jump a title forward by episode.</p>
        </div>
      </div>
      ${renderSearchWorkspace(editedTitle, false)}
    </section>
  `;
}

function renderSetupTab(linkedStatus, fileSyncAvailable) {
  return `
    <section class="support-grid">
      <section class="panel section-panel" data-section="account">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Account</span>
            <h2>Your account</h2>
            <p>${escapeHtml(auth.user.email || "Signed in")}</p>
          </div>
        </div>
        <div class="sync-grid">
          <div class="stat-block">
            <span class="label">Profile</span>
            <strong class="stat-value">${escapeHtml(auth.user.displayName)}</strong>
            <p class="stat-caption">${escapeHtml(auth.user.email || "Account ready")}</p>
          </div>
          <div class="stat-block">
            <span class="label">Storage</span>
            <strong class="stat-value">${escapeHtml(linkedStatus)}</strong>
            <p class="stat-caption">${state.sync.mode === "linked-file" ? `Linked to ${escapeHtml(state.sync.fileName || "selected file")}` : "Saved to your account."}</p>
          </div>
          <div class="stat-block">
            <span class="label">Last update</span>
            <strong class="stat-value">${escapeHtml(formatRelative(state.meta.updatedAt))}</strong>
            <p class="stat-caption">${escapeHtml(formatTimestamp(state.meta.updatedAt))}</p>
          </div>
          <div class="stat-block">
            <span class="label">File sync</span>
            <strong class="stat-value">${fileSyncAvailable ? "Ready" : "Export only"}</strong>
            <p class="stat-caption">${fileSyncAvailable ? "Optional local backup is available." : "Snapshot export is available."}</p>
          </div>
        </div>
        <div class="panel-actions">
          <button class="button secondary" data-action="export-snapshot">Export</button>
          <button class="button ghost" data-action="import-snapshot">Import</button>
          <button class="button ghost" data-action="link-sync-file">Link file</button>
          <button class="button ghost" data-action="sync-now">Push sync now</button>
          <button class="button ghost" data-action="pull-linked">Pull linked file</button>
          <button class="button ghost" data-action="toggle-auto-sync">${state.sync.autoSync ? "Pause auto sync" : "Resume auto sync"}</button>
          <button class="button ghost" data-action="clear-sync-link">Remove link</button>
        </div>
        ${state.sync.lastError ? `<div class="panel-note">${escapeHtml(state.sync.lastError)}</div>` : ""}
      </section>

      <section class="panel section-panel" data-section="setup">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Connectors</span>
            <h2>Playback inputs</h2>
            <p>Optional browser, Plex, and Tautulli ingestion.</p>
          </div>
        </div>
        <div class="connector-grid">
          ${state.connectors.map((connector) => renderConnectorCard(connector)).join("")}
        </div>
      </section>

      <section class="panel section-panel" data-section="tokens">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Tokens</span>
            <h2>Companion tokens</h2>
            <p>Create a token only if you want browser capture or webhook setup.</p>
          </div>
        </div>
        ${renderTokensPanel()}
      </section>
    </section>
  `;
}

function renderSearchWorkspace(editedTitle, compact = false) {
  return `
    <div class="search-workspace ${compact ? "compact" : ""}">
      <div class="workspace-tabs">
        <button class="chip-button ${ui.selectedPanel === "search" ? "primary" : ""}" data-action="panel" data-value="search">Search</button>
        <button class="chip-button ${ui.selectedPanel === "editor" ? "primary" : ""}" data-action="panel" data-value="editor">Add manually</button>
        <button class="chip-button ${ui.selectedPanel === "history" ? "primary" : ""}" data-action="panel" data-value="history">Mark watched</button>
      </div>
      ${ui.selectedPanel === "search"
        ? renderSearchPanel()
        : ui.selectedPanel === "history"
          ? renderSessionEntryPanel()
          : renderEditorPanel(editedTitle)}
    </div>
  `;
}

function primeVisibleEpisodeCaches(titles) {
  const candidates = titles
    .filter((title) => title.kind === "show" && title.sourceId)
    .slice(0, 8);

  for (const title of candidates) {
    if (!episodeOptionsCache.has(title.sourceId) && !episodeOptionsPending.has(title.sourceId)) {
      void ensureEpisodeOptions(title.sourceId);
    }
  }
}

function renderAuthView() {
  const availableProviders = auth.providers.filter((provider) => provider.configured);
  const providerButtons = availableProviders.length
    ? `
        <div class="support-copy">Or use</div>
        <div class="provider-grid">
          ${availableProviders.map((provider) => `<a class="button secondary provider-button" href="${provider.loginUrl}">Continue with ${escapeHtml(provider.label)}</a>`).join("")}
        </div>
      `
    : "";

  return `
    <section class="hero-grid auth-grid">
      <article class="hero-card auth-hero">
        <span class="eyebrow">Watch home</span>
        <h1 class="hero-title">Everything you watch.</h1>
        <p class="hero-copy">Track. Resume. Repeat.</p>
        <div class="auth-word-row">
          <span>Movies</span>
          <span>Shows</span>
          <span>Queue</span>
        </div>
      </article>

      <aside class="hero-card auth-card">
        <div class="panel-head">
          <div>
            <h2>${ui.authMode === "login" ? "Welcome back" : "Create your space"}</h2>
            <p>${ui.authMode === "login" ? "Sign in." : "Get started."}</p>
          </div>
        </div>
        <div class="filter-row">
          <button class="filter-chip ${ui.authMode === "login" ? "active" : ""}" data-action="switch-auth-mode" data-value="login">Sign in</button>
          <button class="filter-chip ${ui.authMode === "register" ? "active" : ""}" data-action="switch-auth-mode" data-value="register">Register</button>
        </div>
        ${ui.authMode === "login" ? renderLoginForm() : renderRegisterForm()}
        ${ui.authError ? `<div class="panel-note">${escapeHtml(ui.authError)}</div>` : ""}
        ${providerButtons}
      </aside>
    </section>
  `;
}

function renderLoginForm() {
  return `
    <form class="stack-form" data-form="login">
      <label class="form-field">
        <span>Email</span>
        <input class="search-bar" name="email" type="email" placeholder="you@example.com" required>
      </label>
      <label class="form-field">
        <span>Password</span>
        <input class="search-bar" name="password" type="password" placeholder="At least 12 characters" required>
      </label>
      <button class="button" type="submit" ${ui.authBusy ? "disabled" : ""}>${ui.authBusy ? "Signing in..." : "Sign in"}</button>
    </form>
  `;
}

function renderRegisterForm() {
  return `
    <form class="stack-form" data-form="register">
      <label class="form-field">
        <span>Display name</span>
        <input class="search-bar" name="displayName" type="text" placeholder="Your name">
      </label>
      <label class="form-field">
        <span>Email</span>
        <input class="search-bar" name="email" type="email" placeholder="you@example.com" required>
      </label>
      <label class="form-field">
        <span>Password</span>
        <input class="search-bar" name="password" type="password" placeholder="At least 12 characters" required>
      </label>
      <button class="button" type="submit" ${ui.authBusy ? "disabled" : ""}>${ui.authBusy ? "Creating..." : "Create account"}</button>
    </form>
  `;
}

function renderSearchPanelLegacy() {
  const trimmedQuery = ui.metadataQuery.trim();
  const resultMarkup = ui.metadataBusy
    ? renderEmptyState("Searching…", "Live results are loading.")
    : ui.metadataResults.length
      ? ui.metadataResults.map((result) => renderMetadataResult(result)).join("")
      : trimmedQuery.length >= 2
        ? renderEmptyState("No results yet.", "Try a different title, or switch between shows and movies.")
        : renderEmptyState("Start typing to search.", "Search updates as you type.");
  return `
    <div class="stack-form">
      <form class="stack-form" data-form="metadata-search">
        <div class="panel-actions">
          <input class="search-bar" data-metadata-input="query" type="search" value="${escapeAttribute(ui.metadataQuery)}" placeholder="Search movies or shows" required>
          <select class="select-field" data-metadata-select="kind" aria-label="Search type">
            <option value="all" ${ui.metadataKind === "all" ? "selected" : ""}>Movies and shows</option>
            <option value="show" ${ui.metadataKind === "show" ? "selected" : ""}>Shows only</option>
            <option value="movie" ${ui.metadataKind === "movie" ? "selected" : ""}>Movies only</option>
          </select>
          <button class="button" type="submit" ${ui.metadataBusy ? "disabled" : ""}>${ui.metadataBusy ? "Searching..." : "Search"}</button>
        </div>
      </form>
      <div class="support-copy">Live search. Results update as you type.</div>
      ${ui.metadataError ? `<div class="panel-note">${escapeHtml(ui.metadataError)}</div>` : ""}
      <div class="search-results">
        ${resultMarkup}
      </div>
    </div>
  `;
}

function getMetadataSearchStatusCopy() {
  const trimmedQuery = ui.metadataQuery.trim();
  if (ui.metadataBusy) {
    return "Searching live results.";
  }
  if (trimmedQuery.length < 2) {
    return "Live search. Results update as you type.";
  }
  if (ui.metadataResults.length) {
    return `${ui.metadataResults.length} match${ui.metadataResults.length === 1 ? "" : "es"} found.`;
  }
  return "No close matches yet. Try another title.";
}

function getMetadataSearchResultsMarkup() {
  const trimmedQuery = ui.metadataQuery.trim();
  if (ui.metadataBusy) {
    return renderEmptyState("Searching...", "Live results are loading.");
  }
  if (ui.metadataResults.length) {
    return ui.metadataResults.map((result) => renderMetadataResult(result)).join("");
  }
  if (trimmedQuery.length >= 2) {
    return renderEmptyState("No results yet.", "Try a different title, or switch between shows and movies.");
  }
  return renderEmptyState("Start typing to search.", "Search updates as you type.");
}

function syncSearchPanelUi() {
  const panel = appElement.querySelector("[data-search-panel='metadata']");
  if (!(panel instanceof HTMLElement)) {
    return false;
  }

  const status = panel.querySelector("[data-search-status]");
  const error = panel.querySelector("[data-search-error]");
  const results = panel.querySelector("[data-search-results]");
  const submit = panel.querySelector("[data-search-submit]");

  if (!(status instanceof HTMLElement) || !(error instanceof HTMLElement) || !(results instanceof HTMLElement) || !(submit instanceof HTMLButtonElement)) {
    return false;
  }

  status.textContent = getMetadataSearchStatusCopy();
  error.textContent = ui.metadataError || "";
  error.hidden = !ui.metadataError;
  results.innerHTML = getMetadataSearchResultsMarkup();
  submit.disabled = ui.metadataBusy;
  submit.textContent = ui.metadataBusy ? "Searching..." : "Search";
  return true;
}

function renderSearchPanel() {
  return `
    <div class="stack-form" data-search-panel="metadata">
      <form class="stack-form" data-form="metadata-search">
        <div class="panel-actions">
          <input class="search-bar" data-metadata-input="query" type="search" value="${escapeAttribute(ui.metadataQuery)}" placeholder="Search movies or shows" required>
          <select class="select-field" data-metadata-select="kind" aria-label="Search type">
            <option value="all" ${ui.metadataKind === "all" ? "selected" : ""}>Movies and shows</option>
            <option value="show" ${ui.metadataKind === "show" ? "selected" : ""}>Shows only</option>
            <option value="movie" ${ui.metadataKind === "movie" ? "selected" : ""}>Movies only</option>
          </select>
          <button class="button" data-search-submit type="submit" ${ui.metadataBusy ? "disabled" : ""}>${ui.metadataBusy ? "Searching..." : "Search"}</button>
        </div>
      </form>
      <div class="support-copy" data-search-status>${escapeHtml(getMetadataSearchStatusCopy())}</div>
      <div class="panel-note" data-search-error ${ui.metadataError ? "" : "hidden"}>${escapeHtml(ui.metadataError)}</div>
      <div class="search-results" data-search-results>
        ${getMetadataSearchResultsMarkup()}
      </div>
    </div>
  `;
}

function renderCurrentUnitControl({ kind, sourceId, value, inputMode, label = "Current unit", placeholder = "S1 E1 or Movie" }) {
  const episodeOptions = sourceId ? (episodeOptionsCache.get(sourceId) || []) : [];
  const loadingEpisodes = sourceId ? episodeOptionsPending.has(sourceId) : false;
  const fieldAttribute = inputMode === "session" ? "data-session-field" : "data-editor-field";

  if (kind === "show" && episodeOptions.length) {
    return `
      <label class="form-field form-span">
        <span>${escapeHtml(label)}</span>
        <select class="select-field" ${fieldAttribute}="currentUnit">
          ${episodeOptions.map((episode) => `
            <option
              value="${escapeAttribute(episode.value)}"
              ${episode.value === value ? "selected" : ""}
              ${inputMode === "session" && episode.available === false ? "disabled" : ""}
            >
              ${escapeHtml(`${episode.label}${episode.available === false && episode.airstamp ? ` (Coming ${formatEpisodeAirLabel(episode)})` : ""}`)}
            </option>
          `).join("")}
        </select>
      </label>
    `;
  }

  return `
    <label class="form-field form-span">
      <span>${escapeHtml(label)}</span>
      <input class="search-bar" ${fieldAttribute}="currentUnit" type="text" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}">
      ${loadingEpisodes ? `<span class="support-copy">Loading episode list…</span>` : ""}
    </label>
  `;
}

function renderEditorPanel(editedTitle) {
  const titleLabel = ui.editor.mode === "edit" ? `Edit ${editedTitle?.title || "title"}` : "Add a title";
  return `
    <form class="stack-form" data-form="title-editor">
      <div class="panel-note">${escapeHtml(titleLabel)}</div>
      <div class="form-grid">
        <label class="form-field">
          <span>Title</span>
          <input class="search-bar" data-editor-field="title" type="text" value="${escapeAttribute(ui.editor.title)}" required>
        </label>
        <label class="form-field">
          <span>Type</span>
          <select class="select-field" data-editor-field="kind">
            <option value="show" ${ui.editor.kind === "show" ? "selected" : ""}>Show</option>
            <option value="movie" ${ui.editor.kind === "movie" ? "selected" : ""}>Movie</option>
          </select>
        </label>
        <label class="form-field">
          <span>Year</span>
          <input class="search-bar" data-editor-field="year" type="number" min="1888" max="2100" value="${escapeAttribute(String(ui.editor.year || ""))}">
        </label>
        <label class="form-field">
          <span>Platform</span>
          <select class="select-field" data-editor-field="platformId">
            ${renderPlatformOptions(ui.editor.platformId, false)}
          </select>
        </label>
        <label class="form-field">
          <span>Status</span>
          <select class="select-field" data-editor-field="status">
            <option value="queued" ${ui.editor.status === "queued" ? "selected" : ""}>Queued</option>
            <option value="watching" ${ui.editor.status === "watching" ? "selected" : ""}>Watching</option>
            <option value="completed" ${ui.editor.status === "completed" ? "selected" : ""}>Completed</option>
          </select>
        </label>
        <label class="form-field">
          <span>Your rating</span>
          <input class="search-bar" data-editor-field="userRating" type="number" min="0.5" max="10" step="0.5" value="${escapeAttribute(String(ui.editor.userRating ?? ""))}" placeholder="8.5">
        </label>
        ${renderCurrentUnitControl({
          kind: ui.editor.kind,
          sourceId: ui.editor.sourceId,
          value: ui.editor.currentUnit,
          inputMode: "editor",
          label: ui.editor.kind === "movie" ? "Watch state" : "Next episode to watch",
          placeholder: ui.editor.kind === "movie" ? "Movie" : "S1 E1"
        })}
        <label class="form-field form-span">
          <span>Genres</span>
          <input class="search-bar" data-editor-field="genres" type="text" value="${escapeAttribute(ui.editor.genres)}" placeholder="Drama, Mystery">
        </label>
        <label class="form-field form-span">
          <span>Summary</span>
          <textarea class="textarea-field" data-editor-field="summary" rows="4" placeholder="Short note or metadata summary">${escapeHtml(ui.editor.summary)}</textarea>
        </label>
      </div>
      <div class="panel-actions">
        <button class="button" type="submit">${ui.editor.mode === "edit" ? "Save" : "Add to library"}</button>
        <button class="button ghost" type="button" data-action="editor-cancel">Cancel</button>
        <button class="button ghost" type="button" data-action="editor-blank">Reset editor</button>
        ${ui.editor.mode === "edit" && ui.editor.titleId ? `<button class="button ghost" type="button" data-action="editor-delete" data-title-id="${escapeAttribute(ui.editor.titleId)}">Delete</button>` : ""}
        ${ui.editor.mode === "edit" && appConfig.ratingsReady ? `<button class="button ghost" type="button" data-action="title-ratings-refresh" data-title-id="${escapeAttribute(ui.editor.titleId || "")}">Refresh ratings</button>` : ""}
      </div>
      ${renderRatingsPanel(ui.editor.ratings, ui.editor.ratingUpdatedAt, ui.editor.imdbId, false, normalizeUserRating(ui.editor.userRating))}
    </form>
  `;
}

function renderSessionEntryPanel() {
  const availableTitles = getFilteredTitles().length ? getFilteredTitles() : state.titles;
  if (!availableTitles.length) {
    return renderEmptyState("No titles to update yet.", "Add a title first, then mark an episode or movie watched.");
  }

  const selectedTitle = lookupTitle(ui.sessionDraft.titleId) || availableTitles[0];
  const draft = selectedTitle && selectedTitle.id !== ui.sessionDraft.titleId
    ? { ...ui.sessionDraft, titleId: selectedTitle.id, currentUnit: getSuggestedCompletedUnit(selectedTitle) }
    : ui.sessionDraft;
  ui.sessionDraft = draft;

  return `
    <form class="stack-form" data-form="manual-session">
      <div class="panel-note">Pick the episode or movie you finished. Watchnest will move the title forward for you.</div>
      <div class="form-grid">
        <label class="form-field form-span">
          <span>Title</span>
          <select class="select-field" data-session-title="titleId">
            ${availableTitles.map((title) => `<option value="${title.id}" ${draft.titleId === title.id ? "selected" : ""}>${escapeHtml(title.title)} (${escapeHtml(labelFromStatus(title.status))})</option>`).join("")}
          </select>
        </label>
        <label class="form-field">
          <span>Finished at</span>
          <input class="search-bar" data-session-field="watchedAtLocal" type="datetime-local" value="${escapeAttribute(draft.watchedAtLocal)}">
        </label>
        <label class="form-field">
          <span>Device</span>
          <input class="search-bar" data-session-field="device" type="text" value="${escapeAttribute(draft.device)}" placeholder="Living room TV">
        </label>
        ${renderCurrentUnitControl({
          kind: selectedTitle.kind,
          sourceId: selectedTitle.sourceId,
          value: draft.currentUnit,
          inputMode: "session",
          label: selectedTitle.kind === "movie" ? "Mark as watched" : "Episode completed",
          placeholder: selectedTitle.kind === "movie" ? "Movie" : "S1 E1"
        })}
        <label class="form-field form-span">
          <span>Note</span>
          <textarea class="textarea-field" data-session-field="summary" rows="3" placeholder="Optional note about this watch update">${escapeHtml(draft.summary)}</textarea>
        </label>
      </div>
      <div class="panel-actions">
        <button class="button" type="submit">Mark watched</button>
        <button class="button ghost" type="button" data-action="history-cancel">Cancel</button>
        <button class="button ghost" type="button" data-action="title-log-session" data-title-id="${selectedTitle.id}">Use next up</button>
      </div>
      ${renderRatingsPanel(selectedTitle.ratings, selectedTitle.ratingUpdatedAt, selectedTitle.imdbId, false, selectedTitle.userRating)}
    </form>
  `;
}

function renderTokensPanel() {
  return `
    <div class="stack-form">
      <form class="stack-form" data-form="token">
        <label class="form-field">
          <span>New token label</span>
          <div class="panel-actions">
            <input class="search-bar" data-token-input="label" type="text" value="${escapeAttribute(ui.tokenLabel)}" placeholder="Auto capture">
            <button class="button" type="submit" ${ui.tokenBusy ? "disabled" : ""}>${ui.tokenBusy ? "Creating..." : "Create token"}</button>
          </div>
        </label>
      </form>
      ${ui.tokenError ? `<div class="panel-note">${escapeHtml(ui.tokenError)}</div>` : ""}
      ${ui.lastCreatedToken ? `
        <div class="storage-card">
          <div class="storage-row">
            <div>
              <h3>Copy this token now</h3>
              <p>This value is only shown once.</p>
            </div>
            <button class="chip-button" data-action="clear-token-reveal">Hide</button>
          </div>
          <div class="token-secret">${escapeHtml(ui.lastCreatedToken)}</div>
        </div>
      ` : ""}
      <div class="storage-card">
        <h3>Where to use it</h3>
        <p>Use the token in the Watchnest browser companion, or in Plex / Tautulli setup if you want automatic playback tracking.</p>
        <details class="support-disclosure">
          <summary>Show technical setup URLs</summary>
          <div class="disclosure-copy">
            <p>POST observations to <span class="code-chip">${escapeHtml(`${appConfig.baseUrl}/api/ingest/observation`)}</span></p>
            <p>Plex webhook: <span class="code-chip">${escapeHtml(`${appConfig.baseUrl}/api/integrations/plex/webhook?token=YOUR_TOKEN`)}</span></p>
            <p>Tautulli webhook: <span class="code-chip">${escapeHtml(`${appConfig.baseUrl}/api/integrations/tautulli/webhook?token=YOUR_TOKEN`)}</span></p>
          </div>
        </details>
      </div>
      <div class="storage-list">
        ${tokens.length ? tokens.map((token) => `
          <article class="storage-card">
            <div class="storage-row">
              <div>
                <h3>${escapeHtml(token.label)}</h3>
                <p>${escapeHtml(token.preview)} / created ${escapeHtml(formatRelative(token.createdAt))}${token.lastUsedAt ? ` / last used ${escapeHtml(formatRelative(token.lastUsedAt))}` : ""}</p>
              </div>
              <button class="chip-button" data-action="delete-token" data-token-id="${token.id}">Delete</button>
            </div>
          </article>
        `).join("") : renderEmptyState("No ingest tokens yet.", "Create one token and use it from the browser extension, Plex, Tautulli, or any local helper.")}
      </div>
    </div>
  `;
}

function renderMetricCard(label, value, caption) {
  return `
    <article class="panel metric-card">
      <span class="label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <p>${escapeHtml(caption)}</p>
    </article>
  `;
}

function renderMetadataResultLegacy(result) {
  const resultImage = proxyImageUrl(result.image);
  const platformId = inferPlatformId(result.platformHint) || ui.editor.platformId;
  return `
    <article class="result-card">
      <div class="result-media" style="${resultImage ? `background-image: linear-gradient(rgba(31,35,39,0.18), rgba(31,35,39,0.32)), url('${escapeAttribute(resultImage)}');` : ""}">
        <span class="poster-platform">${escapeHtml(result.kind === "movie" ? "Movie" : "Show")}</span>
      </div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <h3>${escapeHtml(result.title)}</h3>
            <p>${escapeHtml(result.year ? String(result.year) : "Year unknown")}${result.platformHint ? ` / ${escapeHtml(result.platformHint)}` : ""}</p>
          </div>
        </div>
        <div class="chip-row">
          <span class="tag">${escapeHtml(result.source)}</span>
          <span class="tag">${escapeHtml(platformId)}</span>
          ${(result.genres || []).slice(0, 2).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("")}
        </div>
        <p class="blurb">${escapeHtml(result.summary || "No summary available.")}</p>
        <div class="card-actions">
          <button class="chip-button primary" data-action="quick-add-result" data-result-id="${escapeAttribute(result.id)}">Add</button>
          <button class="chip-button" data-action="select-result" data-result-id="${escapeAttribute(result.id)}">Review</button>
        </div>
      </div>
    </article>
  `;
}

function renderTitleCardLegacy(title) {
  const connector = getConnectorDefinition(title.platformId);
  const progress = `${Math.round(title.progress)}%`;
  const titleImage = proxyImageUrl(title.image);
  const posterStyle = titleImage
    ? `background-image: linear-gradient(rgba(31,35,39,0.14), rgba(31,35,39,0.4)), url('${escapeAttribute(titleImage)}'); background-size: cover; background-position: center;`
    : `--poster-accent: ${connector?.accent || "#0f766e"};`;

  return `
    <article class="panel title-card">
      <div class="poster ${title.image ? "poster-image" : ""}" style="${posterStyle}">
        <span class="poster-platform">${escapeHtml(connector?.shortName || title.platformId)}</span>
        <strong class="poster-title">${escapeHtml(title.title)}</strong>
        <span class="poster-copy">${escapeHtml(title.currentUnit)}</span>
      </div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <h3>${escapeHtml(title.title)}</h3>
            <p>${escapeHtml(connector?.name || title.platformId)} / ${escapeHtml(String(title.year || ""))}</p>
          </div>
          <div class="chip-row">
            <button class="icon-button" data-action="title-favorite" data-title-id="${title.id}">${title.favorite ? "Pinned" : "Pin"}</button>
            <button class="icon-button" data-action="editor-edit" data-title-id="${title.id}">Edit</button>
          </div>
        </div>
        <div class="chip-row">
          <span class="tag status-${title.status}">${escapeHtml(labelFromStatus(title.status))}</span>
          <span class="tag">${escapeHtml(title.kind === "movie" ? "Movie" : "Series")}</span>
          ${title.genres.slice(0, 2).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("")}
        </div>
        ${renderRatingsPanel(title.ratings, title.ratingUpdatedAt, title.imdbId, true)}
        <p class="blurb">${escapeHtml(title.summary)}</p>
        <div class="progress-stack">
          <div class="progress-head">
            <span>${escapeHtml(title.currentUnit)}</span>
            <strong>${escapeHtml(progress)}</strong>
          </div>
          <div class="progress-track" aria-hidden="true">
            <div class="progress-fill" style="width: ${Math.round(title.progress)}%;"></div>
          </div>
          <p class="progress-copy">Last activity ${escapeHtml(formatRelative(title.lastActivityAt))}</p>
        </div>
        <div class="card-actions">
          <button class="chip-button primary" data-action="title-advance" data-title-id="${title.id}">Log progress</button>
          <button class="chip-button" data-action="title-log-session" data-title-id="${title.id}">Log session</button>
          <button class="chip-button" data-action="title-status" data-title-id="${title.id}">Cycle status</button>
          ${appConfig.ratingsReady ? `<button class="chip-button" data-action="title-ratings-refresh" data-title-id="${title.id}">${title.ratings.length ? "Refresh ratings" : "Get ratings"}</button>` : ""}
          <button class="chip-button" data-action="editor-delete" data-title-id="${title.id}">Delete</button>
          ${title.externalUrl ? `<button class="chip-button" type="button" data-action="open-external" data-url="${escapeAttribute(title.externalUrl)}">Source</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderRatingsPanel(ratings, ratingUpdatedAt, imdbId, compact = false, userRating = null) {
  const items = [];
  const normalizedUserRating = normalizeUserRating(userRating);
  if (normalizedUserRating !== null) {
    items.push(`<span class="tag rating-tag user-rating"><strong>You</strong> ${escapeHtml(formatUserRating(normalizedUserRating))}</span>`);
  }
  if (Array.isArray(ratings)) {
    items.push(...ratings.map((rating) => `<span class="tag rating-tag"><strong>${escapeHtml(rating.source)}</strong> ${escapeHtml(rating.value)}</span>`));
  }

  if (!items.length) {
    return compact ? "" : `<div class="ratings-panel empty"><span class="support-copy">Add your rating, and external ratings will appear when available.</span></div>`;
  }

  return `
    <div class="ratings-panel ${compact ? "compact" : ""}">
      <div class="chip-row">
        ${items.join("")}
      </div>
      ${!compact ? `<p class="support-copy">${escapeHtml(ratingUpdatedAt ? `Updated ${formatRelative(ratingUpdatedAt)}` : "Ratings update when metadata is available")}${imdbId ? ` / ${escapeHtml(imdbId)}` : ""}</p>` : ""}
    </div>
  `;
}

function renderConnectorCardLegacy(connector) {
  const definition = getConnectorDefinition(connector.id);
  return `
    <article class="connector-card" style="--connector-accent: ${definition?.accent || "#0f766e"};">
      <div class="connector-head">
        <div>
          <h3>${escapeHtml(definition?.name || connector.id)}</h3>
          <div class="connector-meta">${escapeHtml(connector.mode)} / ${escapeHtml(labelFromConnectorStatus(connector.status))}</div>
        </div>
        <span class="micro-pill"><strong>${escapeHtml(connector.health)}</strong></span>
      </div>
      <p class="connector-copy">${escapeHtml(definition?.summary || "Connector ready for OTT activity ingestion.")}</p>
      <div class="chip-row">
        ${(definition?.capabilities || []).map((capability) => `<span class="tag">${escapeHtml(capability)}</span>`).join("")}
      </div>
      <div class="connector-meta">Last signal ${connector.lastSeenAt ? escapeHtml(formatRelative(connector.lastSeenAt)) : "never"}</div>
    </article>
  `;
}

function renderPosterImage(imageUrl, altText, className) {
  if (!imageUrl) {
    return "";
  }
  return `<img class="${className}" src="${escapeAttribute(imageUrl)}" alt="${escapeAttribute(altText)}" loading="eager" decoding="async" referrerpolicy="no-referrer">`;
}

function renderMetadataResult(result) {
  const resultImage = proxyImageUrl(result.image);
  const platformId = inferPlatformId(result.platformHint) || ui.editor.platformId || "all";
  const connector = getConnectorDefinition(platformId);
  return `
    <article class="result-card">
      <div class="result-media ${resultImage ? "has-image" : ""}" data-platform="${escapeAttribute(platformId)}">
        ${renderPosterImage(resultImage, `${result.title} poster`, "media-image")}
        <div class="media-scrim" aria-hidden="true"></div>
        <span class="poster-platform">${escapeHtml(result.kind === "movie" ? "Movie" : "Show")}</span>
        <button class="poster-quick-action subtle" type="button" data-action="quick-add-result" data-result-id="${escapeAttribute(result.id)}">Add</button>
      </div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <h3>${escapeHtml(result.title)}</h3>
            <p>${escapeHtml(result.year ? String(result.year) : "Year unknown")}${result.platformHint ? ` / ${escapeHtml(result.platformHint)}` : ""}</p>
          </div>
        </div>
        <div class="chip-row">
          <span class="tag">${escapeHtml(result.source)}</span>
          <span class="tag">${escapeHtml(connector?.shortName || platformId)}</span>
          ${(result.genres || []).slice(0, 2).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("")}
        </div>
        ${renderRatingsPanel(result.ratings || [], result.ratingUpdatedAt || null, result.imdbId || "", true)}
        <p class="blurb clamp-2">${escapeHtml(result.summary || "No summary available.")}</p>
        <div class="card-actions">
          <button class="chip-button" data-action="select-result" data-result-id="${escapeAttribute(result.id)}">Review</button>
        </div>
      </div>
    </article>
  `;
}

function renderTitleCard(title) {
  const connector = getConnectorDefinition(title.platformId);
  const titleImage = proxyImageUrl(title.image);
  const watchState = getTitleWatchState(title);
  const availabilityLabel = watchState.comingSoon
    ? `Coming ${watchState.nextAirLabel}${connector?.name ? ` on ${connector.name}` : ""}`
    : watchState.nextUnit
      ? `Up next ${watchState.nextUnit}${connector?.name ? ` on ${connector.name}` : ""}`
      : watchState.completed
        ? "All caught up"
        : "Ready to start";
  const primaryAction = watchState.quickActionLabel;

  return `
    <article class="panel title-card compact">
      <div class="poster ${titleImage ? "poster-image" : ""}" data-platform="${escapeAttribute(title.platformId || "all")}">
        ${renderPosterImage(titleImage, `${title.title} poster`, "poster-art")}
        <div class="poster-scrim" aria-hidden="true"></div>
        <span class="poster-platform">${escapeHtml(connector?.shortName || title.platformId)}</span>
        <strong class="poster-title">${escapeHtml(title.title)}</strong>
        <span class="poster-copy">${escapeHtml(watchState.posterCopy)}</span>
        ${primaryAction ? `<button class="poster-quick-action" type="button" data-action="title-mark-next" data-title-id="${title.id}" ${watchState.quickActionDisabled ? "disabled" : ""}>Done</button>` : ""}
      </div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <h3>${escapeHtml(title.title)}</h3>
            <p>${escapeHtml(connector?.name || title.platformId)} / ${escapeHtml(String(title.year || ""))}</p>
          </div>
          <div class="chip-row">
            <button class="icon-button" data-action="title-favorite" data-title-id="${title.id}">${title.favorite ? "Pinned" : "Pin"}</button>
            <button class="icon-button" data-action="editor-edit" data-title-id="${title.id}">Edit</button>
          </div>
        </div>
        <div class="chip-row">
          <span class="tag status-${watchState.statusTone}">${escapeHtml(watchState.statusLabel)}</span>
          <span class="tag">${escapeHtml(watchState.kindLabel)}</span>
          ${title.genres.slice(0, 2).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("")}
        </div>
        ${renderRatingsPanel(title.ratings, title.ratingUpdatedAt, title.imdbId, true, title.userRating)}
        <div class="watch-meta">
          <div class="watch-line"><strong>${escapeHtml(availabilityLabel)}</strong></div>
          ${watchState.lastCompletedLabel ? `<div class="watch-line soft">Last watched ${escapeHtml(watchState.lastCompletedLabel)}</div>` : ""}
          <div class="watch-line soft">${escapeHtml(watchState.metaCopy)}</div>
        </div>
        <div class="card-actions">
          ${title.kind === "show" ? `<button class="chip-button" data-action="title-choose-unit" data-title-id="${title.id}">Choose episode</button>` : `<button class="chip-button" data-action="title-choose-unit" data-title-id="${title.id}">Update</button>`}
          ${title.externalUrl ? `<button class="chip-button" type="button" data-action="open-external" data-url="${escapeAttribute(title.externalUrl)}">Source</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderConnectorCard(connector) {
  const definition = getConnectorDefinition(connector.id);
  return `
    <article class="connector-card" data-connector="${escapeAttribute(connector.id)}">
      <div class="connector-head">
        <div>
          <h3>${escapeHtml(definition?.name || connector.id)}</h3>
          <div class="connector-meta">${escapeHtml(connector.mode)} / ${escapeHtml(labelFromConnectorStatus(connector.status))}</div>
        </div>
        <span class="micro-pill"><strong>${escapeHtml(connector.health)}</strong></span>
      </div>
      <p class="connector-copy">${escapeHtml(definition?.summary || "Connector ready for OTT activity ingestion.")}</p>
      <div class="chip-row">
        ${(definition?.capabilities || []).map((capability) => `<span class="tag">${escapeHtml(capability)}</span>`).join("")}
      </div>
      <div class="connector-meta">Last signal ${connector.lastSeenAt ? escapeHtml(formatRelative(connector.lastSeenAt)) : "never"}</div>
    </article>
  `;
}

function renderSessionCard(session) {
  const title = lookupTitle(session.titleId);
  const connector = getConnectorDefinition(session.platformId);
  return `
    <article class="timeline-item">
      <div class="timeline-head">
        <div>
          <h3>${escapeHtml(title?.title || "Unknown title")}</h3>
          <div class="timeline-meta">${escapeHtml(connector?.name || session.platformId)} / ${escapeHtml(formatTimestamp(session.startedAt))}</div>
        </div>
        <span class="session-pill ${session.sourceType}">${escapeHtml(session.sourceLabel)}</span>
      </div>
      <p class="timeline-copy">${escapeHtml(session.summary)}</p>
      <div class="chip-row">
        <span class="tag">${escapeHtml(session.device)}</span>
        ${session.currentUnit ? `<span class="tag">${escapeHtml(session.currentUnit)}</span>` : ""}
      </div>
    </article>
  `;
}

function renderSupportCard(kicker, title, copy) {
  return `
    <article class="support-card">
      <span class="support-kicker">${escapeHtml(kicker)}</span>
      <h3>${escapeHtml(title)}</h3>
      <p class="support-copy">${escapeHtml(copy)}</p>
    </article>
  `;
}

function normalizeUserRating(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.min(10, Math.max(0, Math.round(numeric * 10) / 10));
}

function formatUserRating(value) {
  return `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)}/10`;
}

function normalizeEpisodeValue(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function findEpisodeIndex(options, value) {
  const normalized = normalizeEpisodeValue(value);
  return options.findIndex((episode) => normalizeEpisodeValue(episode.value) === normalized);
}

function computeEpisodeProgressFromIndex(index, total) {
  if (!Number.isFinite(index) || index < 0 || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(((index + 1) / total) * 100)));
}

function getNextEpisodeLabelFallback(value) {
  const match = /S(\d+)\s*E(\d+)/i.exec(String(value || ""));
  if (!match) {
    return String(value || "Next episode").trim() || "Next episode";
  }
  return `S${Number(match[1])} E${Number(match[2]) + 1}`;
}

function getEpisodeOptionsForTitle(title) {
  if (!title || title.kind !== "show" || !title.sourceId) {
    return [];
  }
  return episodeOptionsCache.get(title.sourceId) || [];
}

function parseEpisodeTimestamp(episode) {
  const candidate = episode?.airstamp || episode?.airdate || "";
  const timestamp = new Date(candidate).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function isFutureEpisode(episode) {
  const timestamp = parseEpisodeTimestamp(episode);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function formatEpisodeAirLabel(episode) {
  const timestamp = parseEpisodeTimestamp(episode);
  if (!Number.isFinite(timestamp)) {
    return "soon";
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function getSuggestedCompletedUnit(title) {
  if (!title || title.kind === "movie") {
    return "Movie";
  }

  const watchState = getTitleWatchState(title);
  if (watchState.comingSoon) {
    if (title.lastCompletedUnit) {
      return title.lastCompletedUnit;
    }
    const episodeOptions = getEpisodeOptionsForTitle(title);
    const nextIndex = findEpisodeIndex(episodeOptions, watchState.nextUnit);
    if (nextIndex > 0) {
      return episodeOptions[nextIndex - 1].value;
    }
  }

  return watchState.nextUnit || title.lastCompletedUnit || title.currentUnit || "S1 E1";
}

function getTitleWatchState(title) {
  if (!title) {
    return {
      completed: false,
      comingSoon: false,
      nextUnit: "",
      nextAirLabel: "",
      kindLabel: "Show",
      statusLabel: "Queued",
      statusTone: "queued",
      posterCopy: "",
      lastCompletedLabel: "",
      metaCopy: "",
      quickActionLabel: "",
      quickActionDisabled: true
    };
  }

  if (title.kind === "movie") {
    const completed = title.status === "completed";
    return {
      completed,
      comingSoon: false,
      nextUnit: completed ? "" : "Movie",
      nextAirLabel: "",
      kindLabel: "Movie",
      statusLabel: completed ? "Completed" : title.status === "queued" ? "Queued" : "Ready",
      statusTone: completed ? "completed" : title.status === "watching" ? "watching" : "queued",
      posterCopy: completed ? "Completed" : "Movie night",
      lastCompletedLabel: completed ? "Movie" : "",
      metaCopy: `Last updated ${formatRelative(title.lastActivityAt)}`,
      quickActionLabel: completed ? "" : "Mark watched",
      quickActionDisabled: completed
    };
  }

  const episodeOptions = getEpisodeOptionsForTitle(title);
  let nextIndex = findEpisodeIndex(episodeOptions, title.currentUnit);
  const lastCompletedIndex = findEpisodeIndex(episodeOptions, title.lastCompletedUnit);
  if (nextIndex < 0 && lastCompletedIndex >= 0) {
    nextIndex = Math.min(lastCompletedIndex + 1, episodeOptions.length - 1);
  }
  if (nextIndex < 0 && episodeOptions.length) {
    nextIndex = 0;
  }

  const nextEpisode = nextIndex >= 0 ? episodeOptions[nextIndex] : null;
  const noMoreEpisodes = episodeOptions.length > 0 && nextIndex >= episodeOptions.length;
  const completed = title.status === "completed" || (!nextEpisode && episodeOptions.length > 0 && lastCompletedIndex === episodeOptions.length - 1);
  const comingSoon = Boolean(nextEpisode && isFutureEpisode(nextEpisode));
  const nextUnit = completed ? "" : (nextEpisode?.value || title.currentUnit || "S1 E1");
  const nextAirLabel = nextEpisode ? formatEpisodeAirLabel(nextEpisode) : "";

  return {
    completed,
    comingSoon,
    nextUnit,
    nextAirLabel,
    kindLabel: "Series",
    statusLabel: completed ? "Completed" : comingSoon ? "Coming soon" : title.status === "queued" ? "Queued" : "Watching",
    statusTone: completed ? "completed" : comingSoon ? "coming-soon" : title.status === "queued" ? "queued" : "watching",
    posterCopy: completed ? "All caught up" : comingSoon ? `${nextUnit} soon` : nextUnit,
    lastCompletedLabel: title.lastCompletedUnit || "",
    metaCopy: completed
      ? `Last updated ${formatRelative(title.lastActivityAt)}`
      : comingSoon
        ? `${nextUnit} lands ${nextAirLabel}`
        : `Start from ${nextUnit}`,
    quickActionLabel: completed || comingSoon || !nextUnit ? "" : "Mark watched",
    quickActionDisabled: completed || comingSoon || !nextUnit,
    nextEpisode,
    noMoreEpisodes
  };
}

async function markNextUnitWatched(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }
  const watchState = getTitleWatchState(title);
  const targetUnit = watchState.nextUnit || (title.kind === "movie" ? "Movie" : title.currentUnit);
  if (!targetUnit || watchState.quickActionDisabled) {
    return;
  }

  await markTitleThroughUnit(title, targetUnit, {
    startedAt: new Date().toISOString(),
    device: "This device",
    summary: `${title.title} was marked watched in Watchnest.`,
    sourceLabel: "Quick update",
    sourceType: "manual"
  });
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${title.title} moved to the next episode.`
  });
}

async function markTitleThroughUnit(title, targetUnit, {
  startedAt = new Date().toISOString(),
  device = "This device",
  summary = "",
  sourceLabel = "Manual update",
  sourceType = "manual"
} = {}) {
  if (!title) {
    return;
  }
  const progressBefore = Number.isFinite(Number(title.progress)) ? Number(title.progress) : 0;

  if (title.kind === "movie") {
    title.status = "completed";
    title.progress = 100;
    title.lastCompletedUnit = "Movie";
    title.currentUnit = "Completed";
    title.lastActivityAt = startedAt;
  } else {
    if (title.sourceId) {
      await ensureEpisodeOptions(title.sourceId);
    }

    const episodeOptions = getEpisodeOptionsForTitle(title);
    if (!episodeOptions.length) {
      title.lastCompletedUnit = targetUnit;
      title.currentUnit = getNextEpisodeLabelFallback(targetUnit);
      title.status = "watching";
      title.progress = Math.min(100, Math.max(Number(title.progress) || 0, 12));
      title.lastActivityAt = startedAt;
    } else {
    const targetIndex = findEpisodeIndex(episodeOptions, targetUnit);
    if (targetIndex < 0) {
      throw new Error("That episode could not be found.");
    }

    const currentIndex = findEpisodeIndex(episodeOptions, title.currentUnit);
    if (targetIndex > currentIndex && currentIndex >= 0) {
      const firstPending = episodeOptions[currentIndex]?.value || title.currentUnit;
      const shouldCatchUp = window.confirm(`Mark ${firstPending} through ${targetUnit} as watched?`);
      if (!shouldCatchUp) {
        return;
      }
    }

    title.lastCompletedUnit = episodeOptions[targetIndex]?.value || targetUnit;
    const nextEpisode = episodeOptions[targetIndex + 1] || null;
    title.currentUnit = nextEpisode ? nextEpisode.value : "Completed";
    title.progress = computeEpisodeProgressFromIndex(targetIndex, episodeOptions.length);
    title.status = nextEpisode ? "watching" : "completed";
    title.lastActivityAt = startedAt;
    }
  }

  state.sessions = [
    {
      id: createId("session"),
      titleId: title.id,
      platformId: title.platformId,
      startedAt,
      durationMin: title.kind === "movie" ? 120 : 42,
      progressBefore,
      progressAfter: title.progress,
      sourceType,
      sourceLabel,
      device,
      currentUnit: targetUnit,
      eventType: "watched",
      summary: summary || `${title.title} updated to ${targetUnit}.`
    },
    ...state.sessions
  ].slice(0, 60);

  state.meta.updatedAt = new Date().toISOString();
}

function renderEmptyState(title, copy, actions = "") {
  return `
    <div class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(copy)}</p>
      ${actions}
    </div>
  `;
}

function captureDomState(target = document.activeElement) {
  const snapshot = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    focus: null
  };

  if (!target || !(target instanceof HTMLElement)) {
    return snapshot;
  }

  const selector = getDomRestoreSelector(target);
  if (!selector) {
    return snapshot;
  }

  snapshot.focus = {
    selector,
    selectionStart: typeof target.selectionStart === "number" ? target.selectionStart : null,
    selectionEnd: typeof target.selectionEnd === "number" ? target.selectionEnd : null
  };
  return snapshot;
}

function restoreDomState(snapshot) {
  if (!snapshot) {
    return;
  }

  requestAnimationFrame(() => {
    if (snapshot.focus?.selector) {
      const element = appElement.querySelector(snapshot.focus.selector);
      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
        if (
          typeof element.setSelectionRange === "function"
          && Number.isInteger(snapshot.focus.selectionStart)
          && Number.isInteger(snapshot.focus.selectionEnd)
        ) {
          element.setSelectionRange(snapshot.focus.selectionStart, snapshot.focus.selectionEnd);
        }
      }
    }
    window.scrollTo(snapshot.scrollX || 0, snapshot.scrollY || 0);
    requestAnimationFrame(() => {
      window.scrollTo(snapshot.scrollX || 0, snapshot.scrollY || 0);
    });
  });
}

function getDomRestoreSelector(element) {
  if (element.matches("[data-filter-input='search']")) {
    return "[data-filter-input='search']";
  }
  if (element.matches("[data-filter-select='platform']")) {
    return "[data-filter-select='platform']";
  }
  if (element.matches("[data-filter-select='kind']")) {
    return "[data-filter-select='kind']";
  }
  if (element.matches("[data-metadata-input='query']")) {
    return "[data-metadata-input='query']";
  }
  if (element.matches("[data-metadata-select='kind']")) {
    return "[data-metadata-select='kind']";
  }
  return "";
}

function scrollToPrimaryTools() {
  const panel = document.querySelector(PRIMARY_TOOLS_SELECTOR);
  if (panel instanceof HTMLElement) {
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function findExistingTitle(result, platformId) {
  const targetTitle = normalizeLookupTitle(result.title);
  return state.titles.find((title) => (
    normalizeLookupTitle(title.title) === targetTitle
    && title.kind === (result.kind === "movie" ? "movie" : "show")
    && Number(title.year || 0) === Number(result.year || 0)
    && title.platformId === platformId
  )) || null;
}

function normalizeLookupTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function proxyImageUrl(imageUrl) {
  const value = String(imageUrl || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("./api/image?") || value.startsWith("/api/image?")) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return `./api/image?url=${encodeURIComponent(value)}`;
  }
  return value;
}

function normalizeExternalUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function getFilteredTitles() {
  const search = state.filters.search.trim().toLowerCase();
  return state.titles
    .filter((title) => {
      if (state.filters.status !== "all" && title.status !== state.filters.status) {
        return false;
      }
      if (state.filters.platform !== "all" && title.platformId !== state.filters.platform) {
        return false;
      }
      if (state.filters.kind !== "all" && title.kind !== state.filters.kind) {
        return false;
      }
      if (!search) {
        return true;
      }
      const connector = getConnectorDefinition(title.platformId);
      const haystack = [
        title.title,
        title.summary,
        title.currentUnit,
        ...(title.genres || []),
        connector?.name || ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    })
    .sort((left, right) => compareTitleOrder(left, right));
}

function getStats() {
  const watchingTitles = state.titles.filter((title) => title.status === "watching").length;
  const completedTitles = state.titles.filter((title) => title.status === "completed").length;
  const sessionsThisWeek = state.sessions.filter((session) => daysBetween(session.startedAt, new Date().toISOString()) <= 7);
  const connectedConnectors = state.connectors.filter((connector) => connector.status === "connected").length;
  return {
    totalTitles: state.titles.length,
    watchingTitles,
    completedTitles,
    weeklyMinutes: sessionsThisWeek.reduce((total, session) => total + session.durationMin, 0),
    weeklySessions: sessionsThisWeek.length,
    connectedConnectors,
    idleConnectors: state.connectors.length - connectedConnectors,
    streakDays: computeStreakDays(state.sessions)
  };
}

function compareTitleOrder(left, right) {
  const statusOrder = {
    watching: 0,
    paused: 1,
    queued: 2,
    completed: 3
  };
  const favoriteDelta = Number(right.favorite) - Number(left.favorite);
  if (favoriteDelta !== 0) {
    return favoriteDelta;
  }
  const statusDelta = (statusOrder[left.status] ?? 4) - (statusOrder[right.status] ?? 4);
  if (statusDelta !== 0) {
    return statusDelta;
  }
  return new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
}

function computeStreakDays(sessions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sessionDays = new Set(
    sessions.map((session) => {
      const day = new Date(session.startedAt);
      day.setHours(0, 0, 0, 0);
      return day.toISOString();
    })
  );
  let streak = 0;
  for (let offset = 0; offset < 30; offset += 1) {
    const day = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
    if (!sessionDays.has(day.toISOString())) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function createEmptyEditor() {
  return {
    mode: "create",
    titleId: null,
    sourceId: "",
    title: "",
    kind: "show",
    year: "",
    platformId: "netflix",
    status: "queued",
    progress: 0,
    currentUnit: "S1 E1",
    genres: "",
    summary: "",
    image: "",
    externalUrl: "",
    source: "manual",
    ratings: [],
    ratingUpdatedAt: null,
    imdbId: "",
    userRating: ""
  };
}

function createEmptySessionDraft() {
  return {
    titleId: "",
    watchedAtLocal: toDateTimeLocalValue(new Date().toISOString()),
    currentUnit: "S1 E1",
    device: "This device",
    summary: ""
  };
}

function loadEditorFromMetadata(resultId) {
  const result = ui.metadataResults.find((item) => item.id === resultId);
  if (!result) {
    return;
  }
  const starter = createTitleFromMetadata(result, inferPlatformId(result.platformHint) || "netflix");
  ui.editor = {
    mode: "create",
    titleId: null,
    sourceId: starter.sourceId || result.sourceId || result.id || "",
    title: starter.title,
    kind: starter.kind,
    year: starter.year,
    platformId: starter.platformId,
    status: starter.status,
    progress: starter.progress,
    currentUnit: starter.currentUnit,
    genres: starter.genres.join(", "),
    summary: starter.summary,
    image: starter.image || "",
    externalUrl: starter.externalUrl || "",
    source: starter.source || "metadata",
    ratings: starter.ratings || [],
    ratingUpdatedAt: starter.ratingUpdatedAt || null,
    imdbId: starter.imdbId || "",
    userRating: starter.userRating ?? ""
  };
  ui.selectedPanel = "editor";
  if (ui.editor.kind === "show" && ui.editor.sourceId) {
    void ensureEpisodeOptions(ui.editor.sourceId);
  }
}

function loadEditorFromTitle(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }
  ui.editor = {
    mode: "edit",
    titleId: title.id,
    sourceId: title.sourceId || "",
    title: title.title,
    kind: title.kind,
    year: title.year,
    platformId: title.platformId,
    status: title.status,
    progress: title.progress,
    currentUnit: title.currentUnit,
    genres: title.genres.join(", "),
    summary: title.summary,
    image: title.image || "",
    externalUrl: title.externalUrl || "",
    source: title.source || "manual",
    ratings: title.ratings || [],
    ratingUpdatedAt: title.ratingUpdatedAt || null,
    imdbId: title.imdbId || "",
    userRating: title.userRating ?? ""
  };
  ui.selectedPanel = "editor";
  if (ui.editor.kind === "show" && ui.editor.sourceId) {
    void ensureEpisodeOptions(ui.editor.sourceId);
  }
}

function buildTitlePayloadFromEditor() {
  const title = ui.editor.title.trim();
  if (!title) {
    throw new Error("Title name is required.");
  }
  const kind = ui.editor.kind === "movie" ? "movie" : "show";
  const status = ui.editor.status || "queued";
  const sourceId = ui.editor.sourceId || lookupTitle(ui.editor.titleId)?.sourceId || "";
  const nextUnit = ui.editor.currentUnit || (kind === "movie" ? "Movie" : "S1 E1");
  const episodeOptions = kind === "show" && sourceId ? (episodeOptionsCache.get(sourceId) || []) : [];
  const currentIndex = kind === "show" ? findEpisodeIndex(episodeOptions, nextUnit) : -1;
  const inferredLastCompletedUnit = currentIndex > 0 ? episodeOptions[currentIndex - 1]?.value || "" : "";
  return {
    id: ui.editor.titleId || createId("title"),
    sourceId,
    title,
    kind,
    year: Number.isFinite(Number(ui.editor.year)) ? Number(ui.editor.year) : new Date().getFullYear(),
    platformId: ui.editor.platformId || "netflix",
    status,
    progress: status === "completed" ? 100 : kind === "movie" ? 0 : computeEpisodeProgressFromIndex(Math.max(0, currentIndex - 1), episodeOptions.length),
    genres: ui.editor.genres
      .split(",")
      .map((genre) => genre.trim())
      .filter(Boolean)
      .slice(0, 3),
    currentUnit: status === "completed" && kind === "movie" ? "Completed" : nextUnit,
    summary: ui.editor.summary || "Tracked in Watchnest.",
    lastActivityAt: new Date().toISOString(),
    favorite: lookupTitle(ui.editor.titleId)?.favorite || false,
    image: ui.editor.image || "",
    externalUrl: ui.editor.externalUrl || "",
    source: ui.editor.source || "manual",
    ratings: Array.isArray(ui.editor.ratings) ? ui.editor.ratings : lookupTitle(ui.editor.titleId)?.ratings || [],
    ratingUpdatedAt: ui.editor.ratingUpdatedAt || lookupTitle(ui.editor.titleId)?.ratingUpdatedAt || null,
    imdbId: ui.editor.imdbId || lookupTitle(ui.editor.titleId)?.imdbId || "",
    userRating: normalizeUserRating(ui.editor.userRating),
    lastCompletedUnit: status === "completed" && kind === "show"
      ? episodeOptions[episodeOptions.length - 1]?.value || nextUnit
      : inferredLastCompletedUnit
  };
}

function loadSessionDraftFromTitle(titleId, preserveTimestamp = false) {
  const title = lookupTitle(titleId) || state.titles[0];
  if (!title) {
    ui.sessionDraft = createEmptySessionDraft();
    ui.selectedPanel = "history";
    return;
  }

  ui.sessionDraft = {
    titleId: title.id,
    watchedAtLocal: preserveTimestamp && ui.sessionDraft.watchedAtLocal
      ? ui.sessionDraft.watchedAtLocal
      : toDateTimeLocalValue(new Date().toISOString()),
    currentUnit: getSuggestedCompletedUnit(title),
    device: ui.sessionDraft.device || "This device",
    summary: ""
  };
  ui.selectedPanel = "history";
  if (title.kind === "show" && title.sourceId) {
    void ensureEpisodeOptions(title.sourceId);
  }
}

async function saveManualSession() {
  const title = lookupTitle(ui.sessionDraft.titleId);
  if (!title) {
    throw new Error("Choose a title before marking something watched.");
  }
  await markTitleThroughUnit(title, ui.sessionDraft.currentUnit || title.currentUnit, {
    startedAt: fromDateTimeLocalValue(ui.sessionDraft.watchedAtLocal),
    device: ui.sessionDraft.device || "This device",
    summary: ui.sessionDraft.summary || `${title.title} was updated manually in Watchnest.`,
    sourceLabel: "Manual update",
    sourceType: "manual"
  });
  ui.sessionDraft = createEmptySessionDraft();
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${title.title} updated.`
  });
}

function lookupTitle(titleId) {
  return state.titles.find((title) => title.id === titleId) || null;
}

function inferPlatformId(platformHint) {
  if (!platformHint) {
    return null;
  }
  const lowered = platformHint.toLowerCase();
  if (lowered.includes("netflix")) return "netflix";
  if (lowered.includes("amazon") || lowered.includes("prime")) return "prime-video";
  if (lowered.includes("disney")) return "disney-plus";
  if (lowered.includes("max") || lowered.includes("hbo")) return "max";
  if (lowered.includes("apple")) return "apple-tv";
  if (lowered.includes("plex") || lowered.includes("jellyfin")) return "plex";
  return null;
}

function renderPlatformOptions(selectedPlatform, includeAll = true) {
  const options = [];
  if (includeAll) {
    options.push(`<option value="all" ${selectedPlatform === "all" ? "selected" : ""}>All platforms</option>`);
  }
  for (const connector of connectorDefinitions) {
    options.push(
      `<option value="${connector.id}" ${selectedPlatform === connector.id ? "selected" : ""}>${escapeHtml(connector.name)}</option>`
    );
  }
  return options.join("");
}

function labelFromStatus(status) {
  switch (status) {
    case "watching":
      return "Watching";
    case "queued":
      return "Queued";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    default:
      return "All";
  }
}

function labelFromConnectorStatus(status) {
  switch (status) {
    case "connected":
      return "Connected";
    case "paused":
      return "Paused";
    default:
      return "Available";
  }
}

function nextStatusValue(status) {
  const order = ["queued", "watching", "paused", "completed"];
  const index = order.indexOf(status);
  return order[(index + 1) % order.length];
}

function shouldAutoSync() {
  return state.sync.mode === "linked-file" && state.sync.autoSync;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toastRegion.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  toastTimer = window.setTimeout(() => {
    toastRegion.innerHTML = "";
  }, 3000);
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

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function toDateTimeLocalValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value) {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function applyTheme() {
  const theme = THEME_OPTIONS.some((item) => item.id === state.preferences?.theme)
    ? state.preferences.theme
    : "daybreak";
  document.body.dataset.theme = theme;
}

function labelFromTheme(themeId) {
  return THEME_OPTIONS.find((theme) => theme.id === themeId)?.label || "Daybreak";
}

function daysBetween(left, right) {
  const leftDate = new Date(left).getTime();
  const rightDate = new Date(right).getTime();
  return Math.floor(Math.abs(rightDate - leftDate) / (24 * 60 * 60 * 1000));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function createId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 100000)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
