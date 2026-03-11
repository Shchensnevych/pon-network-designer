// @ts-check
import { nodes, conns, serializeNetwork, restoreNetwork, updateStats } from "./network.js";

const BackupManager = {
  dbName: "PON_Backups_DB",
  storeName: "backups",
  /** @type {IDBDatabase | null} */
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      request.onsuccess = (event) => {
        this.db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        resolve(undefined);
      };
      request.onerror = (event) =>
        reject("DB Error: " + /** @type {IDBOpenDBRequest} */ (event.target).error);
    });
  },

  /**
   * Save a network snapshot.
   * @param {string} name
   * @param {string} snapshot
   */
  async save(name, snapshot) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      if (!this.db) return reject("DB not initialized");
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const backup = {
        timestamp: Date.now(),
        projectName: name,
        data: snapshot,
        stats: {
          nodes: nodes.length,
          conns: conns.length,
        },
      };
      const request = store.add(backup);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  /** @returns {Promise<any[]>} */
  async getAll() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      if (!this.db) return reject("DB not initialized");
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const index = store.index("timestamp");
      const request = index.openCursor(null, "prev");
      /** @type {any[]} */
      const results = [];
      request.onsuccess = (event) => {
        const cursor = /** @type {IDBRequest<IDBCursorWithValue | null>} */ (event.target).result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Delete a backup by id.
   * @param {number} id
   */
  async delete(id) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      if (!this.db) return reject("DB not initialized");
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Remove oldest backups beyond maxCount.
   * @param {number} maxCount
   */
  async prune(maxCount) {
    const backups = await this.getAll();
    if (backups.length > maxCount) {
      const toDelete = backups.slice(maxCount);
      for (const b of toDelete) {
        await this.delete(b.id);
      }
    }
  },
};

let projectName = "Мій проєкт";
let autoSaveEnabled = false;
let autoSaveIntervalMinutes = 5;
let maxBackups = 20;
/** @type {ReturnType<typeof setInterval> | null} */
let autoSaveTimer = null;

export async function initBackups() {
  await BackupManager.init();
  loadSettings();
  if (autoSaveEnabled) startAutoSave();
  updateBackupBadge();
}

export function openSettings() {
  document.getElementById("settings-overlay")?.classList.add("open");
  renderBackupsList();
}

export function closeSettings() {
  document.getElementById("settings-overlay")?.classList.remove("open");
}

/**
 * Switch visible tab in settings.
 * @param {string} tabId
 */
export function switchTab(tabId) {
  document
    .querySelectorAll(".tab-content")
    .forEach((el) => el.classList.remove("active"));
  document
    .querySelectorAll(".tab-btn")
    .forEach((el) => el.classList.remove("active"));
  document.getElementById(tabId)?.classList.add("active");
  document.getElementById("btn-" + tabId)?.classList.add("active");
}

/**
 * @param {string} val
 */
export function updateProjectName(val) {
  projectName = val || "Мій проєкт";
  saveSettings();
  document.title = "PON Designer - " + projectName;
  
  // Sync to settings modal input
  const pnSettings = /** @type {HTMLInputElement | null} */ (document.getElementById("project-name"));
  if (pnSettings && pnSettings.value !== projectName) pnSettings.value = projectName;
  
  // Sync to main top bar input
  const pnTop = /** @type {HTMLInputElement | null} */ (document.getElementById("project-name-input"));
  if (pnTop && pnTop.value !== projectName) pnTop.value = projectName;
}

/**
 * @param {boolean} enabled
 */
export function toggleAutoSave(enabled) {
  autoSaveEnabled = enabled;
  saveSettings();
  if (enabled) startAutoSave();
  else stopAutoSave();
}

/**
 * @param {string} val
 */
export function updateAutoSaveInterval(val) {
  autoSaveIntervalMinutes = parseInt(val);
  saveSettings();
  if (autoSaveEnabled) startAutoSave();
}

/**
 * @param {string} val
 */
export function updateMaxBackups(val) {
  maxBackups = parseInt(val);
  saveSettings();
  BackupManager.prune(maxBackups);
}

function startAutoSave() {
  stopAutoSave();
  autoSaveTimer = setInterval(async () => {
    await performAutoSave();
  }, autoSaveIntervalMinutes * 60 * 1000);
}

function stopAutoSave() {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  autoSaveTimer = null;
}

async function performAutoSave() {
  const snapshot = serializeNetwork();
  await BackupManager.save(projectName + " (Auto)", snapshot);
  await BackupManager.prune(maxBackups);
  if (
    document
      .getElementById("settings-overlay")
      ?.classList.contains("open")
  ) {
    renderBackupsList();
  }
  updateBackupBadge();
}

function saveSettings() {
  const settings = {
    projectName,
    autoSaveEnabled,
    autoSaveIntervalMinutes,
    maxBackups,
  };
  localStorage.setItem("pon_settings", JSON.stringify(settings));
}

export function loadSettings() {
  const s = localStorage.getItem("pon_settings");
  if (s) {
    const parsed = JSON.parse(s);
    projectName = parsed.projectName || "Мій проєкт";
    autoSaveEnabled = parsed.autoSaveEnabled;
    autoSaveIntervalMinutes = parsed.autoSaveIntervalMinutes || 5;
    maxBackups = parsed.maxBackups || 20;
  }
  const pn = /** @type {HTMLInputElement | null} */ (document.getElementById("project-name"));
  if (pn) pn.value = projectName;
  
  const pnTop = /** @type {HTMLInputElement | null} */ (document.getElementById("project-name-input"));
  if (pnTop) pnTop.value = projectName;
  const at = /** @type {HTMLInputElement | null} */ (document.getElementById("autosave-toggle"));
  if (at) at.checked = autoSaveEnabled;
  const ai = /** @type {HTMLInputElement | null} */ (document.getElementById("autosave-interval"));
  if (ai) ai.value = String(autoSaveIntervalMinutes);
  const mb = /** @type {HTMLInputElement | null} */ (document.getElementById("max-backups"));
  if (mb) mb.value = String(maxBackups);
  document.title = "PON Designer - " + projectName;
}

export async function renderBackupsList() {
  const list = document.getElementById("backup-list");
  if (!list) return;
  list.innerHTML =
    '<div style="padding:20px;text-align:center;color:#6e7681">Завантаження...</div>';
  try {
    const backups = await BackupManager.getAll();
    if (backups.length === 0) {
      list.innerHTML =
        '<div style="padding:20px;text-align:center;color:#6e7681">Немає збережених бекапів</div>';
      return;
    }
    let html = "";
    backups.forEach((b) => {
      const date = new Date(b.timestamp).toLocaleString("uk-UA");
      html += `<div class="backup-item">
        <div class="backup-info">
          <div class="backup-time">${date}</div>
          <div class="backup-meta">${b.projectName} • Nodes: ${
        b.stats?.nodes || "?"
      } / Conns: ${b.stats?.conns || "?"}</div>
        </div>
        <div class="backup-actions">
          <button class="modal-btn btn-blue" onclick="restoreBackup(${b.id})">Відновити</button>
          <button class="modal-btn btn-x" onclick="deleteBackup(${b.id})">🗑️</button>
        </div>
      </div>`;
    });
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149">Помилка: ${e}</div>`;
  }
}

/**
 * Restore a backup by id.
 * @param {number} id
 */
export async function restoreBackup(id) {
  if (!confirm("Поточний прогрес буде втрачено! Відновити цей бекап?")) return;
  try {
    const backups = await BackupManager.getAll();
    const backup = backups.find((b) => b.id === id);
    if (!backup || !backup.data) throw "Backup data not found";

    restoreNetwork(backup.data);
    updateStats();
    
    let loadedName = backup.projectName || "Мій проєкт";
    if (loadedName.endsWith(" (Auto)")) {
        loadedName = loadedName.replace(" (Auto)", "");
    }
    updateProjectName(loadedName);
    
    closeSettings();
    alert("✅ Бекап успішно відновлено!");
  } catch (e) {
    alert("❌ Помилка відновлення: " + e);
  }
}

/**
 * Delete a backup by id.
 * @param {number} id
 */
export async function deleteBackup(id) {
  if (!confirm("Видалити цей бекап?")) return;
  await BackupManager.delete(id);
  renderBackupsList();
  updateBackupBadge();
}

/**
 * Update the backup badge counter on the sidebar button.
 */
export async function updateBackupBadge() {
  try {
    const all = await BackupManager.getAll();
    const badge = document.getElementById("badge-backups");
    if (badge) {
      badge.textContent = all.length > 0 ? String(all.length) : "";
    }
  } catch (_) {
    // DB not ready yet, skip
  }
}

export { BackupManager };
