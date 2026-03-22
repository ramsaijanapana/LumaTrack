const DB_NAME = "lumatrack-db";
const DB_VERSION = 1;
const STATE_STORE = "state";
const HANDLE_STORE = "handles";
const ROOT_KEY = "root";
const LINKED_FILE_KEY = "linked-file";
const LOCAL_STATE_KEY = "lumatrack:state";

let databasePromise;

export async function loadStoredState() {
  const fromDb = await readValue(STATE_STORE, ROOT_KEY);
  if (fromDb) {
    return fromDb;
  }

  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function persistState(state) {
  await writeValue(STATE_STORE, ROOT_KEY, state);

  try {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

export function isFileSyncSupported() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

export async function linkSyncFile(state) {
  if (!isFileSyncSupported()) {
    throw new Error("Linked file sync needs the File System Access API.");
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: "watchnest-sync.json",
    types: [
      {
        description: "JSON snapshot",
        accept: {
          "application/json": [".json"]
        }
      }
    ]
  });

  await ensurePermission(handle, "readwrite");
  await storeHandle(handle);
  const result = await writeSnapshotToHandle(handle, state);

  return {
    fileName: handle.name,
    linkedAt: new Date().toISOString(),
    lastSyncedAt: result.lastSyncedAt
  };
}

export async function writeLinkedSyncFile(state) {
  const handle = await getStoredHandle();
  if (!handle) {
    throw new Error("No linked file selected yet.");
  }

  await ensurePermission(handle, "readwrite");
  return writeSnapshotToHandle(handle, state);
}

export async function readLinkedSyncFile() {
  const handle = await getStoredHandle();
  if (!handle) {
    throw new Error("No linked file selected yet.");
  }

  await ensurePermission(handle, "read");
  const file = await handle.getFile();
  const text = await file.text();
  return parseSnapshot(text);
}

export async function clearLinkedSyncFile() {
  await deleteValue(HANDLE_STORE, LINKED_FILE_KEY);
}

export async function hasLinkedSyncFile() {
  const handle = await getStoredHandle();
  return Boolean(handle);
}

export function downloadSnapshot(state) {
  const serialized = serializeSnapshot(state);
  const blob = new Blob([serialized], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "watchnest-export.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readSnapshotFile(file) {
  const text = await file.text();
  return parseSnapshot(text);
}

function serializeSnapshot(state) {
  return JSON.stringify(state, null, 2);
}

function parseSnapshot(text) {
  const parsed = JSON.parse(text);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Snapshot file is empty or malformed.");
  }

  if (!Array.isArray(parsed.titles) || !Array.isArray(parsed.sessions)) {
    throw new Error("Snapshot file is missing tracked titles or sessions.");
  }

  return parsed;
}

async function writeSnapshotToHandle(handle, state) {
  const writable = await handle.createWritable();
  const lastSyncedAt = new Date().toISOString();
  const payload = {
    ...state,
    sync: {
      ...(state.sync || {}),
      mode: "linked-file",
      fileName: handle.name,
      lastSyncedAt,
      lastError: ""
    }
  };

  await writable.write(serializeSnapshot(payload));
  await writable.close();

  return {
    fileName: handle.name,
    lastSyncedAt
  };
}

async function storeHandle(handle) {
  return writeValue(HANDLE_STORE, LINKED_FILE_KEY, handle);
}

async function getStoredHandle() {
  return readValue(HANDLE_STORE, LINKED_FILE_KEY);
}

async function ensurePermission(handle, mode) {
  if (!handle || typeof handle.queryPermission !== "function") {
    return;
  }

  const permission = await handle.queryPermission({ mode });
  if (permission === "granted") {
    return;
  }

  const requested = await handle.requestPermission({ mode });
  if (requested !== "granted") {
    throw new Error("Permission to access the linked file was denied.");
  }
}

async function openDatabase() {
  if (!("indexedDB" in window)) {
    return null;
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE);
        }
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(() => null);
  }

  return databasePromise;
}

async function readValue(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
}

async function writeValue(storeName, key, value) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.put(value, key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
}

async function deleteValue(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
}
