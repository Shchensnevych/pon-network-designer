// @ts-check
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
  switchOnboardingTab,
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
  renderBackupsList,
  restoreBackup,
  deleteBackup,
} from "./backup.js";
import { openMDUInternalTopology, initMDUWindowCommands } from "./mdu-ui.js";

document.addEventListener("DOMContentLoaded", () => {
  initNetwork();
  initMDUWindowCommands();

  // Global Escape key listener to close modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modals = [
        "cross-connect-modal", "network-modal", "exportModal", 
        "node-modal", "conn-modal", "help-modal", "settings-modal", "onboarding-modal"
      ];
      modals.forEach(id => {
          const m = document.getElementById(id);
          if (m && window.getComputedStyle(m).display !== "none") {
              m.style.display = "none";
              const overlay = document.getElementById("modal-overlay");
              if (overlay) overlay.classList.remove("open");
          }
      });
    }
  });

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
  window.switchOnboardingTab = switchOnboardingTab;
  window.openMDUInternalTopology = openMDUInternalTopology;

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
      const target = /** @type {HTMLInputElement} */ (e.target);
      const file = target.files?.[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = (ev) => {
        try {
          restoreNetwork(String(ev.target?.result || ""));
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
    const appEl = /** @type {HTMLElement | null} */ (document.querySelector(".app"));
    if (!appEl) return;
    html2canvas(appEl).then((canvas) => {
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
    checkOnboarding();
  });

  // Onboarding: show on first visit
  function checkOnboarding() {
    const dontShow = localStorage.getItem("pon_onboarding_dismissed") === "true";
    if (!dontShow) {
      setTimeout(() => {
        const overlay = document.getElementById("onboarding-overlay");
        if (overlay) overlay.style.display = "flex";
      }, 500);
    }
  }

  // Manual onboarding opener from toolbar (ignores "don't show" flag)
  window.openOnboarding = () => {
    const overlay = document.getElementById("onboarding-overlay");
    const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById("onboarding-dont-show"));
    if (checkbox) checkbox.checked = localStorage.getItem("pon_onboarding_dismissed") === "true";
    switchOnboardingTab(0);
    if (overlay) overlay.style.display = "flex";
  };

  window.closeOnboarding = () => {
    const overlay = document.getElementById("onboarding-overlay");
    if (overlay) overlay.style.display = "none";
    const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById("onboarding-dont-show"));
    if (checkbox?.checked) {
      localStorage.setItem("pon_onboarding_dismissed", "true");
    } else {
      // Якщо галочку знято — при наступному запуску знову показати онбординг
      localStorage.removeItem("pon_onboarding_dismissed");
    }
  };

  // Global ESC handler for closing modals (Onboarding / Report / Settings)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    const onboardingOverlay = document.getElementById("onboarding-overlay");
    const modalOverlay = document.getElementById("modal-overlay");
    const settingsOverlay = document.getElementById("settings-overlay");

    // Закриваємо лише те, що відкрите, за пріоритетом: onboarding → звіт → settings
    if (onboardingOverlay?.style.display === "flex") {
      window.closeOnboarding();
      return;
    }
    if (modalOverlay?.classList.contains("open")) {
      window.closeModal();
      return;
    }
    if (settingsOverlay?.classList.contains("open")) {
      window.closeSettings();
    }
  });
});
