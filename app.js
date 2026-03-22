import {
  createToken,
  deleteToken,
  fetchBootstrap,
  loginAccount,
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
  companionReady: true
};
let toastTimer;

const ui = {
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
  tokenLabel: "Browser companion",
  tokenBusy: false,
  tokenError: "",
  lastCreatedToken: "",
  lastCreatedPreview: "",
  selectedPanel: "search"
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

  const { action, titleId, value, resultId, tokenId } = actionTarget.dataset;

  try {
    switch (action) {
      case "switch-auth-mode":
        ui.authMode = value;
        ui.authError = "";
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
        render();
        break;
      case "editor-blank":
        ui.editor = createEmptyEditor();
        ui.selectedPanel = "editor";
        render();
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
      case "title-status":
        await cycleTitleStatus(titleId);
        break;
      case "title-favorite":
        await toggleFavorite(titleId);
        break;
      case "select-result":
        loadEditorFromMetadata(resultId);
        render();
        break;
      case "panel":
        ui.selectedPanel = value;
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
    render();
    return;
  }

  if (event.target.matches("[data-metadata-input='query']")) {
    ui.metadataQuery = event.target.value;
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
}

function handleChange(event) {
  if (event.target.matches("[data-filter-select='platform']")) {
    state.filters.platform = event.target.value;
    render();
    return;
  }

  if (event.target.matches("[data-filter-select='kind']")) {
    state.filters.kind = event.target.value;
    render();
    return;
  }

  if (event.target.matches("[data-metadata-select='kind']")) {
    ui.metadataKind = event.target.value;
    return;
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
        await runMetadataSearch();
        break;
      case "title-editor":
        await saveEditorTitle();
        break;
      case "token":
        await createCompanionToken();
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
  render();
  showToast(`Account created for ${response.user.displayName}.`);
}

async function performLogout() {
  await logoutAccount();
  auth = {
    authenticated: false,
    user: null,
    providers: auth.providers
  };
  tokens = [];
  state = createSeedState("Viewer", connectorDefinitions);
  ui.editor = createEmptyEditor();
  ui.metadataResults = [];
  ui.metadataError = "";
  render();
  showToast("Signed out.");
}

async function runMetadataSearch() {
  ui.metadataBusy = true;
  ui.metadataError = "";
  render();
  const response = await searchMetadata(ui.metadataQuery, ui.metadataKind);
  ui.metadataBusy = false;
  ui.metadataResults = response.results || [];
  ui.selectedPanel = "search";
  render();
}

async function saveEditorTitle() {
  const payload = buildTitlePayloadFromEditor();
  if (ui.editor.mode === "edit" && ui.editor.titleId) {
    const title = lookupTitle(ui.editor.titleId);
    if (!title) {
      throw new Error("That title could not be found.");
    }
    Object.assign(title, payload, {
      lastActivityAt: new Date().toISOString()
    });
    await persistAndRender({
      saveRemote: true,
      syncLinked: shouldAutoSync(),
      toast: `${title.title} updated.`
    });
  } else {
    state.titles.unshift(payload);
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
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }

  const session = createManualSession(title);
  state = applySession(state, session);
  await persistAndRender({
    saveRemote: true,
    syncLinked: shouldAutoSync(),
    toast: `${title.title} moved forward.`
  });
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
    ui.tokenLabel = "Browser companion";
    render();
    showToast("Companion token created.");
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

function render() {
  if (!auth.authenticated) {
    document.title = "Watchnest | Your watch home";
    appElement.innerHTML = renderAuthView();
    return;
  }

  const filteredTitles = getFilteredTitles();
  const recentSessions = state.sessions.slice(0, 8);
  const stats = getStats();
  const linkedStatus = state.sync.mode === "linked-file" ? "Linked file" : "Cloud account";
  const fileSyncAvailable = isFileSyncSupported();
  const editedTitle = ui.editor.mode === "edit" && ui.editor.titleId ? lookupTitle(ui.editor.titleId) : null;

  appElement.innerHTML = `
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-row">
          <span class="brand-mark" aria-hidden="true">LT</span>
          <div>
            <span class="eyebrow">Account-backed tracker</span>
            <h1 class="brand-title">Watchnest</h1>
          </div>
        </div>
        <p class="brand-copy">Cloud-backed watch tracking with metadata search, companion tokens, and optional linked file sync.</p>
      </div>
      <div class="status-strip">
        <span class="status-pill"><strong>${escapeHtml(auth.user.displayName)}</strong> signed in</span>
        <span class="status-pill"><strong>${stats.totalTitles}</strong> tracked titles</span>
        <span class="status-pill"><strong>${linkedStatus}</strong> storage</span>
        <button class="button ghost" data-action="logout">Sign out</button>
      </div>
    </header>

    <section class="hero-grid">
      <article class="hero-card">
        <span class="eyebrow">Useful today</span>
        <h2 class="hero-title">Search real metadata, manage your queue, and pair a browser companion.</h2>
        <p class="hero-copy">
          Local accounts work immediately. Google, Facebook, and Apple sign-in hooks are wired in and become active as soon as their OAuth credentials are configured on the server.
          The library below now saves to your signed-in account instead of living only inside one browser tab.
        </p>
        <div class="hero-actions">
          <button class="button" data-action="panel" data-value="search">Find titles</button>
          <button class="button secondary" data-action="editor-blank">Add manually</button>
          <button class="button ghost" data-action="create-token">Create companion token</button>
          <button class="button ghost" data-action="export-snapshot">Export snapshot</button>
        </div>
        <div class="panel-note">
          Primary auth is account-backed. Optional linked file sync still works when you want a portable JSON copy on a local folder or synced drive.
        </div>
      </article>

      <aside class="hero-card sync-card">
        <div class="panel-head">
          <div>
            <h2>Account and sync</h2>
            <p>Server state for normal use, plus export and linked-file tools when you want portability.</p>
          </div>
        </div>
        <div class="sync-grid">
          <div class="stat-block">
            <span class="label">Signed in as</span>
            <strong class="stat-value">${escapeHtml(auth.user.displayName)}</strong>
            <p class="stat-caption">${escapeHtml(auth.user.email || "Provider-based account")}</p>
          </div>
          <div class="stat-block">
            <span class="label">Sync mode</span>
            <strong class="stat-value">${escapeHtml(linkedStatus)}</strong>
            <p class="stat-caption">${state.sync.mode === "linked-file" ? `Linked to ${escapeHtml(state.sync.fileName || "selected file")}` : "Server-backed account storage is active."}</p>
          </div>
          <div class="stat-block">
            <span class="label">Last update</span>
            <strong class="stat-value">${escapeHtml(formatRelative(state.meta.updatedAt))}</strong>
            <p class="stat-caption">${escapeHtml(formatTimestamp(state.meta.updatedAt))}</p>
          </div>
          <div class="stat-block">
            <span class="label">Linked file support</span>
            <strong class="stat-value">${fileSyncAvailable ? "Ready" : "Export only"}</strong>
            <p class="stat-caption">${fileSyncAvailable ? "File System Access API detected." : "This browser can still import and export snapshots."}</p>
          </div>
        </div>
        <div class="panel-actions">
          <button class="button secondary" data-action="link-sync-file">Link sync file</button>
          <button class="button ghost" data-action="sync-now">Push sync now</button>
          <button class="button ghost" data-action="pull-linked">Pull linked file</button>
          <button class="button ghost" data-action="toggle-auto-sync">${state.sync.autoSync ? "Pause auto sync" : "Resume auto sync"}</button>
          <button class="button ghost" data-action="clear-sync-link">Remove link</button>
          <button class="button ghost" data-action="import-snapshot">Import snapshot</button>
        </div>
        ${state.sync.lastError ? `<div class="panel-note">${escapeHtml(state.sync.lastError)}</div>` : ""}
        ${ui.appError ? `<div class="panel-note">${escapeHtml(ui.appError)}</div>` : ""}
      </aside>
    </section>

    <section class="stats-grid">
      ${renderMetricCard("Tracked titles", stats.totalTitles, `${stats.watchingTitles} in progress, ${stats.completedTitles} completed.`)}
      ${renderMetricCard("Minutes this week", `${stats.weeklyMinutes} min`, `${stats.weeklySessions} sessions recorded in the last 7 days.`)}
      ${renderMetricCard("Current streak", `${stats.streakDays} days`, "A day counts when at least one watch session is recorded.")}
      ${renderMetricCard("Connected adapters", stats.connectedConnectors, `${stats.connectedConnectors} active, ${stats.idleConnectors} idle.`)}
    </section>

    <section class="content-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Your library</h2>
            <p>Filter, update progress, pin favorites, and keep one unified queue across services.</p>
          </div>
          <div class="panel-actions">
            <input class="search-bar" data-filter-input="search" type="search" value="${escapeAttribute(state.filters.search)}" placeholder="Search titles, genres, or summaries">
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
        <div class="library-grid">
          ${filteredTitles.length ? filteredTitles.map((title) => renderTitleCard(title)).join("") : renderEmptyState("Your library is empty.", "Use the search panel to add a show or movie with real metadata.")}
        </div>
      </section>

      <aside class="stacked-panels">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>OTT connectors</h2>
              <p>These adapters can receive companion events, imports, and manual updates into one timeline.</p>
            </div>
          </div>
          <div class="connector-grid">
            ${state.connectors.map((connector) => renderConnectorCard(connector)).join("")}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Recent activity</h2>
              <p>Every session rolls into one account timeline, whether it came from manual updates or the companion API.</p>
            </div>
          </div>
          <div class="timeline-list">
            ${recentSessions.length ? recentSessions.map((session) => renderSessionCard(session)).join("") : renderEmptyState("No sessions yet.", "Add a title and log progress, or pair the companion flow to send observations in.")}
          </div>
        </section>
      </aside>
    </section>

    <section class="support-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Search and editor</h2>
            <p>Search live metadata, then review and save the title into your library.</p>
          </div>
          <div class="panel-actions">
            <button class="chip-button ${ui.selectedPanel === "search" ? "primary" : ""}" data-action="panel" data-value="search">Search</button>
            <button class="chip-button ${ui.selectedPanel === "editor" ? "primary" : ""}" data-action="panel" data-value="editor">Editor</button>
          </div>
        </div>
        ${ui.selectedPanel === "search" ? renderSearchPanel() : renderEditorPanel(editedTitle)}
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Companion tokens</h2>
            <p>Create an ingest token for the browser companion or any local helper that posts watch observations.</p>
          </div>
        </div>
        ${renderTokensPanel()}
      </section>
    </section>
  `;
  document.title = `Watchnest | ${stats.totalTitles} tracked`;
}

function renderAuthView() {
  const availableProviders = auth.providers.filter((provider) => provider.configured);
  const providerButtons = availableProviders.length
    ? `
        <div class="support-copy">Or continue with</div>
        <div class="provider-grid">
          ${availableProviders.map((provider) => `<a class="button secondary provider-button" href="${provider.loginUrl}">Continue with ${escapeHtml(provider.label)}</a>`).join("")}
        </div>
      `
    : `<p class="auth-subcopy">Email sign-in is available now. More sign-in options can be added as Watchnest expands.</p>`;

  return `
    <section class="hero-grid auth-grid">
      <article class="hero-card auth-hero">
        <span class="eyebrow">Personal watch home</span>
        <h1 class="hero-title">One place for everything you watch.</h1>
        <p class="hero-copy">
          Watchnest keeps your movies, shows, progress, and next picks together in one calm space, so picking up tonight's watch feels effortless instead of scattered.
        </p>
        <div class="auth-platform-strip">
          <span>Netflix</span>
          <span>Prime Video</span>
          <span>Disney+</span>
          <span>Max</span>
          <span>Apple TV+</span>
          <span>Plex</span>
        </div>
        <div class="auth-feature-grid">
          ${renderSupportCard("Remember", "Pick up instantly", "See what you started, what you finished, and what you meant to come back to without hunting across apps.")}
          ${renderSupportCard("Organize", "Build your own watch rhythm", "Keep a personal library for comfort rewatches, new releases, and the shows you are saving for later.")}
          ${renderSupportCard("Sync", "Stay in step across devices", "Your library travels with you, whether you check in from your laptop, desktop, or a shared home setup.")}
          ${renderSupportCard("Simple", "Designed to stay out of the way", "Flat, fast, and clean by default, with just enough detail to feel useful every time you open it.")}
        </div>
        <div class="auth-quote">
          <strong>Your watchlist should feel personal, not procedural.</strong>
          <span>That is the idea behind Watchnest: one clear home for the stories you are in the middle of.</span>
        </div>
      </article>

      <aside class="hero-card auth-card">
        <div class="panel-head">
          <div>
            <h2>${ui.authMode === "login" ? "Welcome back" : "Create your space"}</h2>
            <p>${ui.authMode === "login" ? "Sign in to continue your library, progress, and saved picks." : "Start your own private watch hub in under a minute."}</p>
          </div>
        </div>
        <div class="filter-row">
          <button class="filter-chip ${ui.authMode === "login" ? "active" : ""}" data-action="switch-auth-mode" data-value="login">Sign in</button>
          <button class="filter-chip ${ui.authMode === "register" ? "active" : ""}" data-action="switch-auth-mode" data-value="register">Register</button>
        </div>
        ${ui.authMode === "login" ? renderLoginForm() : renderRegisterForm()}
        ${ui.authError ? `<div class="panel-note">${escapeHtml(ui.authError)}</div>` : ""}
        ${providerButtons}
        <div class="auth-trust-list">
          <div class="auth-trust-item">Private account and synced watch history</div>
          <div class="auth-trust-item">Fast title search across shows and movies</div>
          <div class="auth-trust-item">A cleaner way to decide what to watch next</div>
        </div>
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

function renderSearchPanel() {
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
      ${ui.metadataError ? `<div class="panel-note">${escapeHtml(ui.metadataError)}</div>` : ""}
      <div class="search-results">
        ${ui.metadataResults.length ? ui.metadataResults.map((result) => renderMetadataResult(result)).join("") : renderEmptyState("No metadata results yet.", "Run a search to pull live show and movie matches into the editor.")}
      </div>
    </div>
  `;
}

function renderEditorPanel(editedTitle) {
  const titleLabel = ui.editor.mode === "edit" ? `Editing ${editedTitle?.title || "title"}` : "Create a title";
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
            <option value="paused" ${ui.editor.status === "paused" ? "selected" : ""}>Paused</option>
            <option value="completed" ${ui.editor.status === "completed" ? "selected" : ""}>Completed</option>
          </select>
        </label>
        <label class="form-field">
          <span>Progress</span>
          <input class="search-bar" data-editor-field="progress" type="number" min="0" max="100" value="${escapeAttribute(String(ui.editor.progress))}">
        </label>
        <label class="form-field form-span">
          <span>Current unit</span>
          <input class="search-bar" data-editor-field="currentUnit" type="text" value="${escapeAttribute(ui.editor.currentUnit)}" placeholder="S1 E1 or Movie">
        </label>
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
        <button class="button" type="submit">${ui.editor.mode === "edit" ? "Save changes" : "Add title"}</button>
        <button class="button ghost" type="button" data-action="editor-blank">Reset editor</button>
      </div>
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
            <input class="search-bar" data-token-input="label" type="text" value="${escapeAttribute(ui.tokenLabel)}" placeholder="Browser companion">
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
              <p>This value is only shown once. Paste it into the companion extension settings.</p>
            </div>
            <button class="chip-button" data-action="clear-token-reveal">Hide</button>
          </div>
          <div class="token-secret">${escapeHtml(ui.lastCreatedToken)}</div>
        </div>
      ` : ""}
      <div class="storage-card">
        <h3>Companion endpoint</h3>
        <p>POST observations to <span class="code-chip">${escapeHtml(`${appConfig.baseUrl}/api/ingest/observation`)}</span></p>
        <p class="support-copy">Send a bearer token plus title, platform id, optional current unit, progress delta, duration, and device label.</p>
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
        `).join("") : renderEmptyState("No companion tokens yet.", "Create one token and use it from the browser extension or any local helper.")}
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

function renderMetadataResult(result) {
  const platformId = inferPlatformId(result.platformHint) || ui.editor.platformId;
  return `
    <article class="result-card">
      <div class="result-media" style="${result.image ? `background-image: linear-gradient(rgba(31,35,39,0.18), rgba(31,35,39,0.32)), url('${escapeAttribute(result.image)}');` : ""}">
        <span class="poster-platform">${escapeHtml(result.kind === "movie" ? "Movie" : "Show")}</span>
      </div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <h3>${escapeHtml(result.title)}</h3>
            <p>${escapeHtml(result.year ? String(result.year) : "Year unknown")}${result.platformHint ? ` / ${escapeHtml(result.platformHint)}` : ""}</p>
          </div>
          <button class="icon-button" data-action="select-result" data-result-id="${escapeAttribute(result.id)}">Use</button>
        </div>
        <div class="chip-row">
          <span class="tag">${escapeHtml(result.source)}</span>
          <span class="tag">${escapeHtml(platformId)}</span>
          ${(result.genres || []).slice(0, 2).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join("")}
        </div>
        <p class="blurb">${escapeHtml(result.summary || "No summary available.")}</p>
      </div>
    </article>
  `;
}

function renderTitleCard(title) {
  const connector = getConnectorDefinition(title.platformId);
  const progress = `${Math.round(title.progress)}%`;
  const posterStyle = title.image
    ? `background-image: linear-gradient(rgba(31,35,39,0.14), rgba(31,35,39,0.4)), url('${escapeAttribute(title.image)}'); background-size: cover; background-position: center;`
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
          <button class="chip-button" data-action="title-status" data-title-id="${title.id}">Cycle status</button>
          <button class="chip-button" data-action="editor-delete" data-title-id="${title.id}">Delete</button>
          ${title.externalUrl ? `<a class="chip-button" href="${escapeAttribute(title.externalUrl)}" target="_blank" rel="noreferrer">Source</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderConnectorCard(connector) {
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
        <span class="tag">${escapeHtml(`${session.durationMin} min`)}</span>
        <span class="tag">${escapeHtml(session.device)}</span>
        <span class="tag">${escapeHtml(`${Math.round(session.progressBefore)}% to ${Math.round(session.progressAfter)}%`)}</span>
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

function renderEmptyState(title, copy) {
  return `
    <div class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(copy)}</p>
    </div>
  `;
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
    source: "manual"
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
    source: starter.source || "metadata"
  };
  ui.selectedPanel = "editor";
}

function loadEditorFromTitle(titleId) {
  const title = lookupTitle(titleId);
  if (!title) {
    return;
  }
  ui.editor = {
    mode: "edit",
    titleId: title.id,
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
    source: title.source || "manual"
  };
  ui.selectedPanel = "editor";
}

function buildTitlePayloadFromEditor() {
  const title = ui.editor.title.trim();
  if (!title) {
    throw new Error("Title name is required.");
  }
  const kind = ui.editor.kind === "movie" ? "movie" : "show";
  const progress = clampNumber(ui.editor.progress, 0, 100);
  const status = ui.editor.status || "queued";
  return {
    id: ui.editor.titleId || createId("title"),
    title,
    kind,
    year: Number.isFinite(Number(ui.editor.year)) ? Number(ui.editor.year) : new Date().getFullYear(),
    platformId: ui.editor.platformId || "netflix",
    status,
    progress,
    genres: ui.editor.genres
      .split(",")
      .map((genre) => genre.trim())
      .filter(Boolean)
      .slice(0, 3),
    currentUnit: ui.editor.currentUnit || (kind === "movie" ? "Movie" : "S1 E1"),
    summary: ui.editor.summary || "Tracked in Watchnest.",
    lastActivityAt: new Date().toISOString(),
    favorite: lookupTitle(ui.editor.titleId)?.favorite || false,
    image: ui.editor.image || "",
    externalUrl: ui.editor.externalUrl || "",
    source: ui.editor.source || "manual"
  };
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
