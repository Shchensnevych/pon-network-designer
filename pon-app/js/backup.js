import { nodes, conns, serializeNetwork, restoreNetwork, updateStats } from "./network.js";

const BackupManager = {
  dbName: "PON_Backups_DB",
  storeName: "backups",
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = (event) =>
        reject("DB Error: " + event.target.errorCode);
    });
  },

  async save(name, snapshot) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
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

  async getAll() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const index = store.index("timestamp");
      const request = index.openCursor(null, "prev");
      const results = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
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

  async delete(id) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

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
let autoSaveTimer = null;

export async function initBackups() {
  await BackupManager.init();
  loadSettings();
  if (autoSaveEnabled) startAutoSave();
}

export function openSettings() {
  document.getElementById("settings-overlay").classList.add("open");
  renderBackupsList();
}

export function closeSettings() {
  document.getElementById("settings-overlay").classList.remove("open");
}

export function switchTab(tabId) {
  document
    .querySelectorAll(".tab-content")
    .forEach((el) => el.classList.remove("active"));
  document
    .querySelectorAll(".tab-btn")
    .forEach((el) => el.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  document.getElementById("btn-" + tabId).classList.add("active");
}

export function updateProjectName(val) {
  projectName = val || "Мій проєкт";
  saveSettings();
  document.title = "PON Designer - " + projectName;
}

export function toggleAutoSave(enabled) {
  autoSaveEnabled = enabled;
  saveSettings();
  if (enabled) startAutoSave();
  else stopAutoSave();
}

export function updateAutoSaveInterval(val) {
  autoSaveIntervalMinutes = parseInt(val);
  saveSettings();
  if (autoSaveEnabled) startAutoSave();
}

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
      .classList.contains("open")
  ) {
    renderBackupsList();
  }
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
  document.getElementById("project-name").value = projectName;
  document.getElementById("autosave-toggle").checked = autoSaveEnabled;
  document.getElementById("autosave-interval").value =
    autoSaveIntervalMinutes;
  document.getElementById("max-backups").value = maxBackups;
  document.title = "PON Designer - " + projectName;
}

export async function renderBackupsList() {
  const list = document.getElementById("backup-list");
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

export async function restoreBackup(id) {
  if (!confirm("Поточний прогрес буде втрачено! Відновити цей бекап?")) return;
  try {
    const backups = await BackupManager.getAll();
    const backup = backups.find((b) => b.id === id);
    if (!backup || !backup.data) throw "Backup data not found";

    restoreNetwork(backup.data);
    updateStats();
    closeSettings();
    alert("✅ Бекап успішно відновлено!");
  } catch (e) {
    alert("❌ Помилка відновлення: " + e);
  }
}

export async function deleteBackup(id) {
  if (!confirm("Видалити цей бекап?")) return;
  await BackupManager.delete(id);
  renderBackupsList();
}

export { BackupManager };

