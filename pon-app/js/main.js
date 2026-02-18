// Entry point for modular PON Designer.
// Wires up map/network/UI/backup logic and exposes the expected global API.

import {
  initNetwork,
  selectTool,
  updateStats,
  fitNetwork,
  setLayer,
  undo,
  redo,
  toggleEditMode,
  toggleSignalAnim,
  serializeNetwork,
  restoreNetwork,
  clearNetwork,
} from "./network.js";
import { setFiberLoss } from "./config.js";
import {
  openReport,
  closeModal,
  downloadCSV,
  downloadTXT,
  showSuggestions,
  showTopology,
  showScenarioCompare,
  openHelp,
  closeHelp,
  focusNode,
} from "./ui.js";
import {
  BackupManager,
  initBackups,
  openSettings,
  closeSettings,
  switchTab,
  updateProjectName,
  toggleAutoSave,
  updateAutoSaveInterval,
  updateMaxBackups,
  loadSettings,
  renderBackupsList,
  restoreBackup,
  deleteBackup,
} from "./backup.js";

document.addEventListener("DOMContentLoaded", () => {
  initNetwork();

  // Expose functions used by HTML (onclick / onchange) via window
  // Tools & basic network actions
  window.selectTool = selectTool;
  window.fitNetwork = fitNetwork;
  window.undo = undo;
  window.redo = redo;
  window.toggleEditMode = toggleEditMode;
  window.toggleSignalAnim = toggleSignalAnim;

  // Settings: fiber loss update
  window.updateFiberLoss = (val) => {
    setFiberLoss(val);
    updateStats();
  };

  // Layer switching
  window.setLayer = setLayer;

  // Reports / topology / suggestions / help
  window.openReport = openReport;
  window.closeModal = closeModal;
  window.downloadCSV = downloadCSV;
  window.downloadTXT = downloadTXT;
  window.showSuggestions = showSuggestions;
  window.showTopology = showTopology;
  window.showScenarioCompare = showScenarioCompare;
  window.focusNode = focusNode;
  window.openHelp = openHelp;
  window.closeHelp = closeHelp;

  // Export / Import
  window.exportToJSON = () => {
    const raw = serializeNetwork();
    // Keep the same file shape/naming as the monolith (pretty JSON)
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([pretty], {
        type: "application/json",
      }),
    );
    a.download = "pon_leaflet_project.json";
    a.click();
  };

  window.loadProject = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = (ev) => {
        try {
          restoreNetwork(String(ev.target.result || ""));
          updateStats();
          alert("✅ Проєкт завантажено успішно!");
        } catch (err) {
          alert("❌ Помилка завантаження: " + err);
        }
      };
      r.readAsText(file);
    };
    inp.click();
  };

  // PNG export (used by existing HTML button)
  window.exportToPNG = () => {
    if (typeof html2canvas !== "function") {
      alert("html2canvas не завантажено.");
      return;
    }
    html2canvas(document.querySelector(".app")).then((canvas) => {
      const a = document.createElement("a");
      a.download = "pon_scheme_" + Date.now() + ".png";
      a.href = canvas.toDataURL();
      a.click();
    });
  };

  // Clear network (used by existing HTML button)
  window.clearNetwork = clearNetwork;

  // Backups & settings
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  window.switchTab = switchTab;
  window.updateProjectName = updateProjectName;
  window.toggleAutoSave = toggleAutoSave;
  window.updateAutoSaveInterval = updateAutoSaveInterval;
  window.updateMaxBackups = updateMaxBackups;
  window.renderBackupsList = renderBackupsList;
  window.restoreBackup = restoreBackup;
  window.deleteBackup = deleteBackup;

  // Export BackupManager for potential future use
  window.BackupManager = BackupManager;

  // Initial stats
  updateStats();

  // Initialize backups/settings after page load
  window.addEventListener("load", () => {
    initBackups();
  });

  // Global ESC handler for closing modals (Report / Help / Settings)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    const modalOverlay = document.getElementById("modal-overlay");
    const helpOverlay = document.getElementById("help-overlay");
    const settingsOverlay = document.getElementById("settings-overlay");

    // Закриваємо лише те, що відкрите, за пріоритетом: основний звіт → help → settings
    if (modalOverlay?.classList.contains("open")) {
      window.closeModal();
      return;
    }
    if (helpOverlay?.classList.contains("open")) {
      window.closeHelp();
      return;
    }
    if (settingsOverlay?.classList.contains("open")) {
      window.closeSettings();
    }
  });
});

