// @ts-check
/// <reference path="./types.d.ts" />
/** @type {typeof import('leaflet')} */
const L = window["L"];

// Core map + network logic for modular PON Designer.
// Signal calculations live in signal.js, shared arrays in state.js.

import {
  FBT_LOSSES,
  PLC_LOSSES,
  ONU_MIN,
  FIBER_DB_KM,
  fobCounter,
  muftaCounter,
  onuCounter,
  mduCounter,
  setCounters,
  nextFobNumber,
  nextMuftaNumber,
  nextOnuNumber,
  nextMduNumber,
  iconOLT,
  iconFOB,
  iconMUFTA,
  iconONU,
  iconMDU,
} from "./config.js";
import { sigClass, sigColorClass } from "./utils.js";

// Shared state — used by signal.js for calculations
import { nodes, conns, map, setMap } from "./state.js";

// Signal calculations — extracted to signal.js (~320 lines removed)
import {
  getChainColor, usedOutputs, PON_COLORS,
  freeCablePorts, freePatchPorts,
  fobPortStatus, connKm, sigIn, 
  hasOLTPath, sigAtONU, sigONU, sigFBT, sigSplitter,
  cntONUport, cntSubsPort, updateCableColors, traceOpticalPath, calculateMDUSignal
} from "./signal.js";

// Signal path highlighting & animation — extracted to signal-path.js
import {
  highlightSignalPath, clearSignalPath,
  refreshSignalAnim, removeSignalAnimOverlays,
  toggleSignalAnim, hasActiveGlow,
} from "./signal-path.js";

import "./cross-connect-ui.js";

// Re-export for main.js and ui.js compatibility
export { nodes, conns, connKm, sigIn, sigONU, hasOLTPath, cntONUport, sigAtONU };
export { toggleSignalAnim };

// Local state — stays in this module (no need for setter functions)
/** @type {import('leaflet').TileLayer | undefined} */
let streets;
/** @type {import('leaflet').TileLayer | undefined} */
let satellite;
/** @type {import('leaflet').TileLayer | undefined} */
let hybrid;

let tool = "select";
/** @type {PONNode | null} */
let selNode = null;
/** @type {PONNode | null} */
let connStart = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let dragUpdateTimer = null; // Throttle для оновлення під час драгу
/** @type {(import('leaflet').Polyline | import('leaflet').CircleMarker)[]} */
let onuLeaderLines = []; // Leader lines for dense ONU clusters
/** @type {Map<string, import('leaflet').Polyline>} */
let onuLeaderLinesByNodeId = new Map();
/** @type {Map<string, import('leaflet').CircleMarker>} */
let onuEndpointsByNodeId = new Map();

/**
 * Initialize Leaflet map and basic interactions.
 * Should be called once after DOM is ready.
 */
export function initNetwork() {
  const mapContainer = document.getElementById("map");
  if (!mapContainer) {
    console.warn("PON: #map element not found");
    return;
  }

  // Map & base layers (from original INIT block)
  setMap(L.map("map", {
    center: [50.4501, 30.5234],
    zoom: 13,
    zoomControl: false,
  }));

  streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "&copy; Esri",
    },
  );

  hybrid = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
    attribution: "&copy; Google",
  });

  // Custom zoom control
  L.control
    .zoom({
      position: "bottomright",
    })
    .addTo(map);

  const z = document.getElementById("status-zoom");
  if (z) z.textContent = `Zoom: ${map.getZoom()}`;

  // Адаптивне відображення tooltip'ів: при малому zoom показувати тільки при hover
  map.on("zoomend", () => {
    updateTooltipsVisibility();
  });

  // Re-layout ONU tooltips after panning (visible nodes change)
  let _moveLayoutTimer = null;
  map.on("moveend", () => {
    // Debounce: don't fire during zoom (zoomend already handles that)
    if (_moveLayoutTimer) clearTimeout(_moveLayoutTimer);
    _moveLayoutTimer = setTimeout(() => {
      // Skip if any node is currently being dragged
      if (nodes.some((n) => n._isDragging)) return;
      const zoom = map.getZoom();
      if (zoom >= 15) {
        clearONULeaderLines();
        layoutONUTooltips();
        nodes.forEach((n) => {
          if (n.type === "ONU" || n.type === "MDU") {
            updateNodeLabel(n);
          }
        });
      }
    }, 150);
  });

  // Basic Geoman options (if plugin is present)
  if (map.pm) {
    map.pm.setGlobalOptions({
      allowSelfIntersection: false,
      snappable: true,
      snapDistance: 20,
    });

    // When global edit mode is toggled, enable/disable editing on all connection polylines
    map.on("pm:globaleditmodetoggled", (e) => {
      conns.forEach((c) => {
        if (c.polyline) {
          if (/** @type {any} */ (e).enabled) {
            c.polyline.pm.enable({ snappable: true, snapDistance: 20 });
          } else {
            c.polyline.pm.disable();
          }
        }
      });
    });
  }

  // Map click → add node / clear selection
  map.on("click", (e) => {
    onMapClick(e);
  });

  // Map mousemove → update status bar coordinates
  map.on("mousemove", (e) => {
    const coords = document.getElementById("status-coords");
    if (coords) coords.textContent = `Lat: ${e.latlng.lat.toFixed(5)}, Lng: ${e.latlng.lng.toFixed(5)}`;
  });

  // Zoom changes
  map.on("zoomend", () => {
    const z = document.getElementById("status-zoom");
    if (z) z.textContent = `Zoom: ${map.getZoom()}`;
  });

  // Contextmenu → close custom ctx menu if open
  map.on("contextmenu", () => {
    const ctx = document.getElementById("ctx-menu");
    if (ctx) ctx.style.display = "none";
  });

  // Keyboard shortcuts: Escape, Delete, Ctrl+Z / Ctrl+Y
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      connStart = null;
      selectTool("select");
    }
    if (e.key === "Delete" && selNode) {
      // deleteNode will be implemented later; for now, simple stub:
      deleteNode(selNode);
    }
    if (e.ctrlKey && e.key === "z") {
      e.preventDefault();
      undo();
    }
    if (e.ctrlKey && e.key === "y") {
      e.preventDefault();
      redo();
    }
  });

  // Close context menu on any document click
  document.addEventListener("click", () => {
    const ctx = document.getElementById("ctx-menu");
    if (ctx) ctx.style.display = "none";
  });

  // Close layers dropdown when clicking outside
  window.addEventListener("click", (e) => {
    if (!/** @type {HTMLElement} */ (e.target).matches("#btn-layers")) {
      const menu = document.getElementById("layer-menu");
      if (menu && menu.classList.contains("show")) {
        menu.classList.remove("show");
      }
    }
  });

  // Drag & drop from toolbox onto map
  document.querySelectorAll(".tool-btn[draggable]").forEach((btn) => {
    btn.addEventListener("dragstart", (e) => {
      /** @type {DragEvent} */ (e).dataTransfer?.setData("text/plain", /** @type {HTMLElement} */ (btn).dataset.type || "");
    });
  });
  mapContainer.addEventListener("dragover", (e) => e.preventDefault());
  mapContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/plain");
    if (!["olt", "fob", "mufta", "onu", "mdu"].includes(type)) return;
    const rect = mapContainer.getBoundingClientRect();
    const pt = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(pt);
    addNode(type, latlng);
    selectTool("select");
  });

  // Mini-legend + toolbar (keeps original HTML; relies on window.undo/etc)
  const legendPanel = /** @type {any} */ (L.control)({ position: "bottomleft" });
  legendPanel.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-legend-panel");
    div.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:6px;pointer-events:none">
        <div class="leaflet-legend">
          <div class="legend-title" onclick="this.parentElement.classList.toggle('collapsed')">📋 Легенда ▾</div>
          <div class="legend-body">
            <div><span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(250,250,250,0.95);border:2px solid #58a6ff;font-size:11px;margin-right:6px;vertical-align:middle">🗄️</span>OLT (Головна станція)</div>
            <div><span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(250,250,250,0.95);border:2px solid #3fb950;font-size:11px;margin-right:6px;vertical-align:middle">📦</span>FOB (Розподільча коробка)</div>
            <div><span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(250,250,250,0.95);border:2px solid #e3b341;font-size:11px;margin-right:6px;vertical-align:middle">🛢️</span>Муфта (Splice Closure)</div>
            <div><span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(250,250,250,0.95);border:2px solid #ff7b72;font-size:10px;margin-right:6px;vertical-align:middle">🏠</span>ONU (Абонентський термінал)</div>
            <div><span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:rgba(250,250,250,0.95);border:2px solid #a371f7;font-size:12px;margin-right:6px;vertical-align:middle">🏢</span>MDU (Багатоповерхівка)</div>
            <hr style="border-color:#30363d;margin:4px 0">
            <div style="font-size:10px;color:#c9d1d9;margin-bottom:2px">Рівень сигналу (в підписах обладнання):</div>
            <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:6px;vertical-align:middle"></span>OK (≥ ${ONU_MIN} дБ)</div>
            <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#d29922;margin-right:6px;vertical-align:middle"></span>Межа (${ONU_MIN}..${ONU_MIN - 3} дБ)</div>
            <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f85149;margin-right:6px;vertical-align:middle"></span>Слабкий (< ${ONU_MIN - 3} дБ)</div>
            <div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#6b7280;margin-right:6px;vertical-align:middle"></span>Немає сигналу</div>
            <hr style="border-color:#30363d;margin:4px 0">
            <div style="font-size:10px;color:#c9d1d9;margin-bottom:2px">Лінії на карті:</div>
            <div>━━ Магістраль</div>
            <div>╌╌ Патчкорд</div>
            <div style="font-size:9px;color:#35d522;margin-top:2px">Колір лінії — маршрут, не сигнал</div>
          </div>
        </div>
        <div class="leaflet-toolbar-group">
          <!-- Група 1: Історія -->
          <div class="tool-column">
            <button class="tool-btn-icon" onclick="typeof undo === 'function' ? undo() : void 0" title="Скасувати (Ctrl+Z)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
            </button>
            <span class="tool-label">Undo</span>
          </div>
          <div class="tool-column">
            <button class="tool-btn-icon" onclick="typeof redo === 'function' ? redo() : void 0" title="Повторити (Ctrl+Y)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/></svg>
            </button>
            <span class="tool-label">Redo</span>
          </div>

          <div class="tool-group-divider"></div>
          
          <!-- Група 2: Навігація / Редагування -->
          <div class="tool-column">
            <button class="tool-btn-icon" onclick="typeof fitNetwork === 'function' ? fitNetwork() : void 0" title="Показати всю мережу (Fit All)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="22" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="2" y2="12"></line><line x1="12" y1="6" x2="12" y2="2"></line><line x1="12" y1="22" x2="12" y2="18"></line><circle cx="12" cy="12" r="3" fill="currentColor"></circle></svg>
            </button>
            <span class="tool-label">FlyTo</span>
          </div>
          <div class="tool-column">
            <button class="tool-btn-icon" onclick="typeof toggleEditMode === 'function' ? toggleEditMode() : void 0" id="btn-edit" title="Редагувати (вигини)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><g transform="translate(-3 -3)"><path fill-rule="evenodd" d="M13.5,11 C11.5670034,11 10,9.43299662 10,7.5 C10,5.56700338 11.5670034,4 13.5,4 C15.4329966,4 17,5.56700338 17,7.5 C17,9.43299662 15.4329966,11 13.5,11 Z M13.5,9 C14.3284271,9 15,8.32842712 15,7.5 C15,6.67157288 14.3284271,6 13.5,6 C12.6715729,6 12,6.67157288 12,7.5 C12,8.32842712 12.6715729,9 13.5,9 Z M12.0002889,7.52973893 C12.0125983,8.16273672 12.4170197,8.6996643 12.9807111,8.90767966 L3,15 L3,13 L12.0002889,7.52973893 Z M14.2172722,6.18228472 L19.453125,3 L22.6589355,3 L14.989102,7.68173885 C14.9962971,7.62216459 15,7.56151472 15,7.5 C15,6.93138381 14.6836098,6.4366645 14.2172722,6.18228472 Z M23.4434042,19.2851736 L20.1282799,19.2851736 L21.8729983,23.5349525 C21.9945296,23.8295773 21.8556546,24.1599209 21.5778734,24.2849208 L20.0414675,24.9545142 C19.7550613,25.0795141 19.4338738,24.9366704 19.3123426,24.6509518 L17.6544367,20.6154541 L14.9461873,23.4010151 C14.5852811,23.7721711 14,23.4860463 14,22.9992653 L14,9.57183533 C14,9.05933561 14.6225311,8.809492 14.946156,9.17008555 L23.8340292,18.3120179 C24.1925291,18.6613615 23.9279979,19.2851736 23.4434042,19.2851736 Z"></path></g></svg>
            </button>
            <span class="tool-label">Вигини</span>
          </div>
          <div class="dropdown">
            <div class="tool-column">
              <button class="tool-btn-icon" onclick="document.getElementById('layer-menu').classList.toggle('show');event.stopPropagation()" id="btn-layers" title="Шари">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
              </button>
              <span class="tool-label">Шари</span>
            </div>
            <div id="layer-menu" class="dropdown-content">
              <button class="layer-btn selected" onclick="setLayer('osm')" id="btn-layer-osm">
                <span class="chk"><i class="fa-solid fa-check"></i></span><span class="icn"><i class="fa-solid fa-map fa-fw"></i></span><span class="lbl">Карта</span>
              </button>
              <button class="layer-btn" onclick="setLayer('sat')" id="btn-layer-sat">
                <span class="chk"></span><span class="icn"><i class="fa-solid fa-satellite fa-fw"></i></span><span class="lbl">Супутник</span>
              </button>
              <button class="layer-btn" onclick="setLayer('hyb')" id="btn-layer-hyb">
                <span class="chk"></span><span class="icn"><i class="fa-solid fa-layer-group fa-fw"></i></span><span class="lbl">Гібрид</span>
              </button>
            </div>
          </div>

          <div class="tool-group-divider"></div>

          <div class="search-indicator-labeled" style="position: relative;">
            <div class="tool-column">
              <div class="search-container" title="Пошук (Місто, вулиця або координати)">
                <input type="text" id="loc-search-input" placeholder="Адреса або координати..." autocomplete="off" oninput="handleSearchInput(event)" onkeypress="if(event.key === 'Enter') searchLocation()">
                <button onclick="searchLocation()" title="Знайти">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </button>
              </div>
              <span class="tool-label">Пошук локації</span>
            </div>
          </div>

          <div class="tool-group-divider"></div>

          <!-- Група 3: Масштаб -->
          <div class="labeled-group">
            <div class="tool-column">
              <div class="zoom-indicator">
                <button class="zoom-btn" id="zoom-minus" title="Зменшити">−</button>
                <div class="zoom-slider-wrap">
                  <span id="zoom-val" style="font-size: 10px; line-height: 1;">${map.getZoom()}</span>
                  <input type="range" id="zoom-slider" min="${map.getMinZoom()}" max="${map.getMaxZoom()}" value="${map.getZoom()}" step="1">
                </div>
                <button class="zoom-btn" id="zoom-plus" title="Збільшити">+</button>
              </div>
              <span class="tool-label">Масштабування</span>
            </div>
          </div>

          <div class="tool-group-divider"></div>
          
          <!-- Група 4: Додатково -->
          <div class="tool-column">
            <button class="tool-btn-icon" onclick="openOnboarding()" id="btn-help-pulse" title="Онбординг: основи роботи, типи сплітерів, поради">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            </button>
            <span class="tool-label">Help</span>
          </div>
        </div>
      </div>`;
    
    // Встановлюємо хандлери безпосередньо, бо в ES-модулях inline-events не бачать глобальних об'єктів
    setTimeout(() => {
      const slider = div.querySelector("#zoom-slider");
      const btnMinus = div.querySelector("#zoom-minus");
      const btnPlus = div.querySelector("#zoom-plus");
      
      if (slider) {
        slider.addEventListener("input", (e) => {
          map.setZoom(parseInt(/** @type {HTMLInputElement} */ (e.target).value));
        });
      }
      if (btnMinus) {
        btnMinus.addEventListener("click", () => map.zoomOut());
      }
      if (btnPlus) {
        btnPlus.addEventListener("click", () => map.zoomIn());
      }
    }, 0);

    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legendPanel.addTo(map);

  // Initial stats
  updateStats();
}

/**
 * Layer switcher logic (OSM / satellite / hybrid).
 * Mirrors original setLayer() implementation.
 */
export function setLayer(type) {
  if (!map) return;

  if (streets && map.hasLayer(streets)) map.removeLayer(streets);
  if (satellite && map.hasLayer(satellite)) map.removeLayer(satellite);
  if (hybrid && map.hasLayer(hybrid)) map.removeLayer(hybrid);

  // Reset selection
  const btnOsm = document.getElementById("btn-layer-osm");
  const btnSat = document.getElementById("btn-layer-sat");
  const btnHyb = document.getElementById("btn-layer-hyb");
  
  // Helper to update checkmark visualization via class and symbol
  const updateBtn = (btn, isSelected) => {
    if (!btn) return;
    if (isSelected) {
      btn.classList.add("selected");
      btn.querySelector(".chk").innerHTML = '<i class="fa-solid fa-check"></i>';
    } else {
      btn.classList.remove("selected");
      btn.querySelector(".chk").innerHTML = '';
    }
  };

  updateBtn(btnOsm, false);
  updateBtn(btnSat, false);
  updateBtn(btnHyb, false);

  if (type === "osm" && streets) {
    streets.addTo(map);
    updateBtn(btnOsm, true);
  }
  if (type === "sat" && satellite) {
    satellite.addTo(map);
    updateBtn(btnSat, true);
  }
  if (type === "hyb" && hybrid) {
    hybrid.addTo(map);
    updateBtn(btnHyb, true);
  }

  const menu = document.getElementById("layer-menu");
  if (menu) menu.classList.remove("show");
}

export function toggleEditMode() {
  if (!map?.pm) return;
  const wasEditing = map.pm.globalEditModeEnabled();
  map.pm.toggleGlobalEditMode();
  const btn = document.getElementById("btn-edit");
  if (btn) {
    const isEditing = map.pm.globalEditModeEnabled();
    btn.classList.toggle("active-btn", isEditing);
    btn.style.color = isEditing ? "#58a6ff" : "#fff";
  }
  // Після виходу з режиму згинання — оновити підсвітку магістралі по нових координатах
  if (wasEditing && selNode) {
    highlightSignalPath(selNode);
  }
}

/**
 * Tool selection logic (select / pan / olt / fob / onu / cable / patchcord).
 * Currently supports only tools relevant to basic node operations.
 */
export function selectTool(t) {
  // Close popup if switching away from cable/patchcord mid-connection
  if (connStart) connStart.marker?.closePopup?.();

  tool = t;
  connStart = null;

  // When entering cable/patchcord mode, close all node popups so they don't block the view
  if (["cable", "patchcord"].includes(t)) {
    nodes.forEach((node) => node.marker?.closePopup?.());
  }

  document
    .querySelectorAll(".tool-btn")
    .forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`[data-tool="${t}"]`);
  if (btn) btn.classList.add("active");
}

/**
 * Map click handler: add nodes in placement modes or clear selection in select mode.
 */
export function onMapClick(e) {
  if (["olt", "fob", "mufta", "onu", "mdu"].includes(tool)) {
    addNode(tool, e.latlng);
    selectTool("select");
  } else if (tool === "select") {
    selNode = null;
    showProps(null);
    clearSignalPath();
  }
}

/**
 * Create and place a new node on the map.
 */
export function addNode(type, latlng) {
  saveState();
  /** @type {any} */
  const n = {
    id: "n" + Date.now(),
    type: type.toUpperCase(),
    lat: latlng.lat,
    lng: latlng.lng,
    price: 0,
  };

  if (type === "olt") {
    n.ports = 4;
    n.outputPower = 2;
    n.name = "OLT";
    n.maxOnuPerPort = 64;
    n.crossConnects = [];
    n.marker = L.marker(latlng, {
      icon: iconOLT,
      draggable: true,
      pmIgnore: true,
    });
  } else if (type === "fob" || type === "mufta") {
    n.type = "FOB";
    n.subtype = type === "mufta" ? "MUFTA" : undefined;
    n.number = type === "mufta" ? nextMuftaNumber() : nextFobNumber();
    n.name = (type === "mufta" ? "Муфта-" : "FOB-") + n.number;
    n.fbtType = "";
    n.plcType = "";
    n.plcBranch = "";
    n.inputConn = null;
    n.splitters = [];
    n.crossConnects = [];
    n.marker = L.marker(latlng, {
      icon: type === "mufta" ? iconMUFTA : iconFOB,
      draggable: true,
      pmIgnore: true,
    });
  } else if (type === "onu") {
    n.number = nextOnuNumber();
    n.name = "ONU-" + n.number;
    n.marker = L.marker(latlng, {
      icon: iconONU,
      draggable: true,
      pmIgnore: true,
    });
  } else if (type === "mdu") {
    n.number = nextMduNumber();
    n.name = "MDU-" + n.number;
    n.floors = 5;
    n.entrances = 2;
    n.flatsPerFloor = 4;
    n.marker = L.marker(latlng, {
      icon: iconMDU,
      draggable: true,
      pmIgnore: true,
    });
  }

  n.marker.addTo(map);
  n.marker.nodeRef = n;

  n.marker.on("click", (evt) => onNodeClick(n, evt));
  n.marker.on("dragstart", () => {
    n._isDragging = true;
  });
  n.marker.on("drag", () => onNodeDrag(n));
  n.marker.on("dragend", () => {
    // Зняти прапорець драгу
    n._isDragging = false;
    if (dragUpdateTimer) {
      clearTimeout(dragUpdateTimer);
      dragUpdateTimer = null;
    }
    // Виконуємо оновлення через мікро-затримку, щоб Leaflet завершив drag
    setTimeout(() => {
      layoutONUTooltips();
      nodes.forEach((x) => updateNodeLabel(x));
      refreshSignalAnim();
      if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
      updateStats();
      if (selNode === n) showProps(n);
    }, 10);
  });
  // Context menu / advanced actions will be wired later

  updateNodeLabel(n);

  nodes.push(n);
  selNode = n;
  showProps(n);
  updateStats();
}

// ═══════════════════════════════════════════════
//  UNDO / REDO
// ═══════════════════════════════════════════════
const undoHistory = [];
let redoHistory = [];
const MAX_HISTORY = 50;
let _restoring = false;

export function serializeNetwork() {
  return JSON.stringify({
    schemaVersion: "1.0",
    nodes: nodes.map((n) => {
      const { marker, inputConn, ...rest } = /** @type {any} */ (n);
      return rest;
    }),
    conns: conns.map((c) => {
      const { polyline, from, to, _distTooltip, ...rest } = /** @type {any} */ (c);
      return {
        ...rest,
        from: from.id,
        to: to.id,
        pts: polyline ? polyline.getLatLngs().map((/** @type {any} */ ll) => [ll.lat, ll.lng]) : null,
      };
    }),
    fobCounter,
    muftaCounter,
    onuCounter,
    mduCounter,
  });
}

function saveState() {
  if (_restoring) return;
  undoHistory.push(serializeNetwork());
  if (undoHistory.length > MAX_HISTORY) undoHistory.shift();
  redoHistory = [];
}

/**
 * @param {string} json
 */
export function restoreNetwork(json) {
  _restoring = true;
  /** @type {any} */
  const d = JSON.parse(json);
  
  // Version migration: handle old formats
  const version = d.schemaVersion || "0.9"; // 0.9 = old monolith format
  if (version === "0.9") {
    // Old format: ensure defaults are set
    if (!d.fobCounter) d.fobCounter = 1;
    if (!d.muftaCounter) d.muftaCounter = 1;
    if (!d.onuCounter) d.onuCounter = 1;
  }
  
  clearSignalPath();
  // Clear existing
  conns.forEach((c) => {
    if (c._distTooltip) map.removeLayer(c._distTooltip);
    map.removeLayer(c.polyline);
  });
  nodes.forEach((n) => map.removeLayer(/** @type {any} */ (n.marker)));
  nodes.length = 0;
  conns.length = 0;

  // Restore Nodes
  d.nodes.forEach((n) => {
    // Ensure defaults for older saves
    if (n.type === "OLT") {
      if (typeof n.ports !== "number") n.ports = 4;
      if (typeof n.outputPower !== "number") n.outputPower = 2;
      if (typeof n.maxOnuPerPort !== "number") n.maxOnuPerPort = 64;
      if (!n.name) n.name = "OLT";
      if (!n.crossConnects) n.crossConnects = [];
    }
    if (n.type === "FOB") {
      if (typeof n.fbtType !== "string") n.fbtType = "";
      if (typeof n.plcType !== "string") n.plcType = "";
      if (typeof n.plcBranch !== "string") n.plcBranch = "";
      if (!n.name) n.name = "FOB";
      if (!n.splitters) n.splitters = [];
      if (!n.crossConnects) n.crossConnects = [];
      
      // Auto-migrate legacy splitters to the dynamic array
      if (n.fbtType && !n.splitters.some(s => s.id === "legacy_fbt")) {
          n.splitters.push({ id: "legacy_fbt", type: "FBT", ratio: n.fbtType });
      }
      if (n.plcType && !n.splitters.some(s => s.id === "legacy_plc")) {
          n.splitters.push({ id: "legacy_plc", type: "PLC", ratio: n.plcType });
      }
    }
    if (n.type === "ONU") {
      if (!n.name) n.name = "ONU";
    }
    if (n.type === "MDU") {
      if (!n.name) n.name = "MDU";
      if (typeof n.floors !== "number") n.floors = 5;
      if (typeof n.entrances !== "number") n.entrances = 2;
      if (typeof n.flatsPerFloor !== "number") n.flatsPerFloor = 4;
    }
    if (typeof n.price !== "number") n.price = 0;
    const icon = n.type === "OLT" ? iconOLT : n.type === "ONU" ? iconONU : n.type === "MDU" ? iconMDU : (n.subtype === "MUFTA" ? iconMUFTA : iconFOB);
    n.marker = L.marker(
      { lat: n.lat, lng: n.lng },
      { icon, draggable: true, pmIgnore: true },
    ).addTo(map);
    n.marker.nodeRef = n;
    n.inputConn = null;
    n.marker.on("click", (e) => onNodeClick(n, e));
    n.marker.on("dragstart", () => {
      n._isDragging = true;
    });
    n.marker.on("drag", () => onNodeDrag(n));
    n.marker.on("dragend", () => {
      // Зняти прапорець драгу
      n._isDragging = false;
      if (dragUpdateTimer) {
        clearTimeout(dragUpdateTimer);
        dragUpdateTimer = null;
      }
      // Виконуємо оновлення через мікро-затримку
      setTimeout(() => {
        layoutONUTooltips();
        nodes.forEach((x) => updateNodeLabel(x));
        refreshSignalAnim();
        if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
        updateStats();
        if (selNode === n) showProps(n);
      }, 10);
    });
    n.marker.on("contextmenu", (e) => showNodeCtx(e, n));
    updateNodeLabel(n);
    nodes.push(n);
  });

  // Restore Conns
  d.conns.forEach((c) => {
    const f = nodes.find((x) => x.id === c.from);
    const t = nodes.find((x) => x.id === c.to);
    if (f && t)
      createConnection(f, t, c.type, c.color, {
        id: c.id,
        fromPort: c.fromPort,
        branch: c.branch,
        capacity: c.capacity,
        length: c.length,
        pts: c.pts,
      });
  });

  setCounters({ fobCounter: d.fobCounter || 1, muftaCounter: d.muftaCounter || 1, onuCounter: d.onuCounter || 1, mduCounter: d.mduCounter || 1 });
  selNode = null;
  showProps(null);
  updateStats();
  // Refresh all tooltip labels after connections are fully restored
  updateTooltipsVisibility();
  _restoring = false;

  // Force Leaflet to fully rebuild tile grid after heavy DOM restore.
  // A simple invalidateSize is NOT enough — we replicate what the user
  // does manually (zoom in/out) to flush the tile cache completely.
  setTimeout(() => {
    map.invalidateSize({ animate: false });
    const z = map.getZoom();
    map.setZoom(z + 0.01, { animate: false });
    requestAnimationFrame(() => {
      map.setZoom(z, { animate: false });
    });
  }, 300);
}

export function clearNetwork() {
  if (!confirm("Очистити всю мережу? / Clear All?")) return;
  saveState();

  clearSignalPath();
  removeSignalAnimOverlays();

  conns.forEach((c) => {
    if (c._distTooltip) map.removeLayer(c._distTooltip);
    map.removeLayer(c.polyline);
  });
  nodes.forEach((n) => map.removeLayer(/** @type {any} */ (n.marker)));

  nodes.length = 0;
  conns.length = 0;

  setCounters({ fobCounter: 1, muftaCounter: 1, onuCounter: 1, mduCounter: 1 });
  undoHistory.length = 0;
  redoHistory = [];

  selNode = null;
  showProps(null);
  updateStats();
}

export function undo() {
  if (undoHistory.length === 0) return;
  redoHistory.push(serializeNetwork());
  restoreNetwork(undoHistory.pop());
}

export function redo() {
  if (redoHistory.length === 0) return;
  undoHistory.push(serializeNetwork());
  restoreNetwork(redoHistory.pop());
}

// updateConnections removed
// ═══════════════════════════════════════════════
//  CONNECTIONS LOGIC
// ═══════════════════════════════════════════════
function addConn(from, to, type) {
  // Basic Checks
  if (type === "cable") {
    if (!["OLT", "FOB"].includes(from.type)) {
      alert("Магістраль: OLT/FOB → FOB/MDU");
      return;
    }
    if (to.type !== "FOB" && to.type !== "MDU") {
      alert("Магістраль має йти до FOB або MDU!");
      return;
    }
    if (from === to) {
      alert("Не можна з’єднати елемент сам із собою!");
      return;
    }

    if (from.type === "OLT") {
      // Instead of old showOLTPortSel, we just create the cable and then open Patch Panel
      promptCableCapacity(from, to, type, getChainColor(from), () => {
         selectTool("select");
         if (typeof window.openPatchPanel === "function") {
             window.openPatchPanel(from.id);
         }
      });
      return;
    }

    // FOB -> FOB Rules
    const chainColor = getChainColor(from);
    promptCableCapacity(from, to, type, chainColor, () => {
       selectTool("select");
       if (typeof window.openCrossConnect === "function") window.openCrossConnect(from.id);
    });
    return;
  } else if (type === "patchcord") {
    if (from.type !== "FOB" || (to.type !== "ONU" && to.type !== "MDU")) {
      alert("Патчкорд: FOB → ONU/MDU");
      return;
    }
    createConnection(from, to, type, "#ffd700");
    selectTool("select");
    if (typeof window.openCrossConnect === "function") window.openCrossConnect(from.id);
    return;
  }
}

function promptCableCapacity(from, to, type, color, callback, extraProps = {}) {
    let capacity = 12; // default
    const input = prompt(`Введіть кількість жил у магістралі (Кабель від ${from.name} до ${to.name}):`, "12");
    if (input === null) {
        // User cancelled drawing
        return;
    }
    const val = parseInt(input);
    if (!isNaN(val) && val > 0 && val <= 144) capacity = val;
    
    // Create the connection using the parsed capacity
    createConnection(from, to, type, color, { capacity, ...extraProps });
    
    // Call the callback to open the modal
    if (callback) callback();
}

function createConnection(from, to, type, color, props = {}) {
  saveState();
  const id = props.id || "c" + Date.now();

  // Check if we have saved points (bending)
  const points = props.pts || [
    [from.lat, from.lng],
    [to.lat, to.lng],
  ];

  const polyline = L.polyline(points, {
    color: props.color || color,
    weight: type === "cable" ? 5 : 3,
    dashArray: type === "patchcord" ? "8, 8" : null,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
    pmIgnore: false,
  }).addTo(map);

  if (map.pm?.globalEditModeEnabled?.()) {
    polyline.pm.enable({ snappable: true, snapDistance: 20 });
  }

  const c = { id, type, from, to, color, polyline, ...props };
  conns.push(c);

  if (type === "cable") to.inputConn = c;

  polyline.on("pm:edit", () => {
    updateStats();
    if (c.type === "cable") updateConnLabel(c);
    nodes.forEach((x) => updateNodeLabel(x));
    if (selNode === c.to || selNode === c.from) showProps(selNode);
    // Оновити підсвітку магістралі після зміни форми лінії
    if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
  });
  polyline.on("pm:markerdragend", () => {
    updateStats();
    if (c.type === "cable") updateConnLabel(c);
    nodes.forEach((x) => updateNodeLabel(x));
    if (selNode === c.to || selNode === c.from) showProps(selNode);
    // Оновити підсвітку магістралі після перетягування вершини
    if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
  });

  polyline.on("click", (e) => {
    L.DomEvent.stopPropagation(/** @type {any} */ (e));
    showConnCtx(/** @type {any} */ (e), c);
  });
  polyline.on("contextmenu", (e) => {
    L.DomEvent.stopPropagation(/** @type {any} */ (e));
    L.DomEvent.preventDefault(/** @type {any} */ (e));
    showConnCtx(/** @type {any} */ (e), c);
  });

  polyline.on("mouseover", () => polyline.setStyle({ weight: type === "cable" ? 7 : 5 }));
  polyline.on("mouseout", () => polyline.setStyle({ weight: type === "cable" ? 5 : 3 }));

  if (type === "cable") {
    updateConnLabel(c);
  }

  updateStats();
  nodes.forEach((x) => updateNodeLabel(x));
  selNode = to;
  showProps(to);
}

// Cable distance label
function updateConnLabel(c) {
  if (c._distTooltip) {
    map.removeLayer(c._distTooltip);
    c._distTooltip = null;
  }
  if (c.type !== "cable") return;
  const pts = c.polyline.getLatLngs();
  const flat = pts.length > 0 && typeof pts[0].lat === "number" ? pts : pts[0] || [];
  if (flat.length < 2) return;
  const mid = Math.floor(flat.length / 2);
  const midPt =
    flat.length % 2 === 0
      ? L.latLng((flat[mid - 1].lat + flat[mid].lat) / 2, (flat[mid - 1].lng + flat[mid].lng) / 2)
      : flat[mid];
  const dist = connKm(c) * 1000;
  
  let totalDistStr = "";
  if (c.type === "cable") {
      let totalLength = dist;
      let currNode = c.from;
      while (currNode && currNode.type === "FOB") {
          const upCable = conns.find(pc => pc.to === currNode && pc.type === "cable");
          if (!upCable) break;
          totalLength += connKm(upCable) * 1000;
          currNode = upCable.from;
      }
      if (currNode && currNode.type === "OLT") {
          totalDistStr = `<div style="text-align:center; font-size:10px; color:#a5d6ff; line-height:1.1; margin-top:1px; font-family: monospace;" title="Загальна довжина від OLT">→ Σ ${totalLength.toFixed(0)} м ←</div>`;
      }
  }

  let contentHtml = `<div style="text-align:center; font-weight:bold; font-size:11px; line-height:1.1; color:#fff; font-family: monospace;" title="Довжина цієї ділянки">← ${dist.toFixed(0)} м →</div>`;
  contentHtml += totalDistStr;
  if (c.capacity) {
      contentHtml += `<div style="text-align:center; font-size:9px; color:#58a6ff; line-height:1; margin-bottom:1px; margin-top:2px;">${c.capacity} жил</div>`;
  }

  let signalsHtml = "";
  if (c.capacity) {
      const activeCores = [];
      const FIBER_COLORS = [
          "#0d6efd", "#fd7e14", "#198754", "#8b4513", 
          "#6c757d", "#ffffff", "#dc3545", "#000000", 
          "#ffc107", "#6f42c1", "#d63384", "#0dcaf0"
      ];
      
      for (let i = 0; i < c.capacity; i++) {
          let s = null;
          if (c.from.type === "OLT") {
              const oltXc = (c.from.crossConnects || []).find(/** @type {any} */(x) => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
              if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
          } else if (c.from.type === "FOB") {
              const upstream = traceOpticalPath(c.from, "CABLE", c.id, i);
              if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
          }
          if (s !== null) {
              const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
              const dotColor = FIBER_COLORS[i % 12];
              const bdr = dotColor === "#000000" ? "border: 1px solid #777;" : "border: 1px solid rgba(255,255,255,0.2);";
              
              activeCores.push(`<div style="display:inline-flex; align-items:center; font-size:9px; margin:0px; padding:1px 3px; background:rgba(255,255,255,0.05); border-radius:2px; line-height:1;">
                  <span style="display:inline-block; width:5px; height:5px; border-radius:50%; background:${dotColor}; ${bdr} margin-right:2px;"></span>
                  <span style="color:#c9d1d9; margin-right:2px;">${i+1}</span>
                  <span style="color:${sColor}; font-weight:bold;">⚡${s.toFixed(1)} дБ</span>
              </div>`);
          }
      }
      if (activeCores.length > 0) {
          signalsHtml = `<div style="display:flex; flex-wrap:wrap; justify-content:center; max-width:140px; gap:2px; padding-top:1px;">${activeCores.join("")}</div>`;
      }
  }
  
  if (signalsHtml) {
      contentHtml += `<div style="margin-top:1px; padding-top:2px; border-top:1px solid rgba(255,255,255,0.1);">${signalsHtml}</div>`;
  }

  c._distTooltip = L.tooltip({
    permanent: true,
    direction: "top",
    className: "conn-dist-label",
    offset: [0, -5],
  })
    .setContent(contentHtml)
    .setLatLng(midPt)
    .addTo(map);
}

// ═══════════════════════════════════════════════
//  P O N   L O G I C (helpers used by connection rules & labels)
//  → Moved to signal.js
// ═══════════════════════════════════════════════
function onNodeClick(n, e) {
  L.DomEvent.stopPropagation(e);
  if (tool === "select") {
    selNode = n;
    showProps(n);
    highlightSignalPath(n);
  } else if (["cable", "patchcord"].includes(tool)) {
    if (!connStart) {
      connStart = n;
      // Close this marker's popup immediately so it doesn't block ONU when dragging
      n.marker.closePopup?.();
      // Close all other markers' popups too
      nodes.forEach((node) => {
        if (node !== n) node.marker?.closePopup?.();
      });
      // Leaflet may open popup on marker click by default; close again after a tick
      requestAnimationFrame(() => {
        if (connStart === n) n.marker?.closePopup?.();
      });
    } else {
      addConn(connStart, n, tool);
      connStart = null;
      selectTool("select");
    }
  }
}

function onNodeDrag(n) {
  n._isDragging = true;
  const ll = n.marker.getLatLng();
  n.lat = ll.lat;
  n.lng = ll.lng;
  
  // Оновлюємо полілінії одразу (візуально важливо)
  conns.forEach((c) => {
    if (c.from === n || c.to === n) {
      c.polyline.setLatLngs(/** @type {import('leaflet').LatLngExpression[]} */ ([[c.from.lat, c.from.lng], [c.to.lat, c.to.lng]]));
      if (c.type === "cable") updateConnLabel(c);
    }
  });
  
  // Тротлінг для анімації та підсвітки (НЕ оновлюємо tooltip'и під час drag)
  if (dragUpdateTimer) clearTimeout(dragUpdateTimer);
  dragUpdateTimer = setTimeout(() => {
    refreshSignalAnim();
    if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
    if (selNode === n) showProps(n);
    dragUpdateTimer = null;
  }, 80);
}

/** @param {any} n */
function buildNodeLabelContent(n) {
  let L1 = "";
  let L2 = "";

  if (n.type === "OLT") {
    L1 = `<span class="lbl-name lbl-olt">${n.name}</span>`;
    L2 = `<span class="lbl-dim">${Number(n.outputPower || 0).toFixed(1)} дБ</span>`;
    const portInfo = [];
    const xcArr = n.crossConnects || [];
    for (let i = 0; i < n.ports; i++) {
      const activeCores = xcArr.filter(x => parseInt(String(x.fromId)) === i && x.toType === "CABLE");
      if (activeCores.length > 0) {
        const targetNodes = [...new Set(activeCores.map(x => {
            const cable = conns.find(cf => cf.id === x.toId);
            return cable ? cable.to?.name : "";
        }))].filter(Boolean).join(", ");
        let subs = cntSubsPort(n, i);
        let subsStr = subs > 0 ? ` (+${subs} аб)` : "";
        portInfo.push(`PON ${i + 1} ➔ [${targetNodes}] (${activeCores.length} жил${subsStr})`);
      }
    }
    if (portInfo.length)
      L2 += `<br><span class="lbl-dim">${portInfo.join("<br>")}</span>`;
  } else if (n.type === "FOB") {
    const fobIcon = (n.subtype === "MUFTA") ? "🛢️" : "📦";
    const lblClass = (n.subtype === "MUFTA") ? "lbl-mufta" : "lbl-fob";
    L1 = `<span class="lbl-name ${lblClass}">${fobIcon} ${n.name}</span>`;

    if (n.inputConn) {
      const si = sigIn(n);
      const srcIcon = n.inputConn.from.type === "OLT" ? "🗄️" : (n.inputConn.from.subtype === "MUFTA" ? "🛢️" : "📦");
      const src = n.inputConn.from.name || n.inputConn.from.type;
      let capStr = n.inputConn.capacity ? ` (${n.inputConn.capacity} жил)` : "";
      let br = "";
      if (n.inputConn.branch) br = `[${n.inputConn.branch}]`;
      
      L2 = `<span class="lbl-dim">Від: ${srcIcon} ${src}${capStr}${br ? " "+br : ""}</span>`;
      if (si !== null) {
        L2 += ` <span class="lbl-sig ${sigColorClass(si)}">${si.toFixed(1)}дБ</span>`;
      }
    }

    const pi = fobPortStatus(n);
    pi.rich.forEach((l) => (L2 += `<br><span class="lbl-dim">${l}</span>`));
  } else if (n.type === "ONU") {
    L1 = `<span class="lbl-name lbl-onu">🏠 ${n.name}</span>`;
    const s = sigAtONU(n);
    const conn = conns.find((x) => x.to === n && x.type === "patchcord");
    if (s !== null) {
      L2 = `<span class="lbl-sig ${sigColorClass(s)}">${s.toFixed(1)}дБ</span>`;
      if (conn && conn.from) {
        const fromIcon = (conn.from.type === "FOB" && conn.from.subtype === "MUFTA") ? "🛢️" : "📦";
        L2 += `<br><span class="lbl-dim">Від: ${fromIcon} ${conn.from.name}</span>`;
        if (conn.from.crossConnects) {
           const xc = conn.from.crossConnects.find(x => (x.toType === "CABLE" || x.toType === "PATCHCORD") && x.toId === conn.id);
           if (xc) {
              if (xc.fromType === "SPLITTER") {
                 let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
                 if (/** @type {any} */(conn.from).splitters) {
                     let spInst = /** @type {any} */(conn.from).splitters.find(/** @type {any} */s=>s.id === xc.fromId);
                     if (spInst) spName = `${spInst.type} ${spInst.ratio}`;
                 }
                 let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
                 L2 += `<br><span class="lbl-dim">🔗 Порт: ${spName} (Вихід ${port})</span>`;
              } else if (xc.fromType === "CABLE") {
                 let inConn = conns.find(c => c.id === xc.fromId);
                 let srcName = inConn ? inConn.from.name : "?";
                 L2 += `<br><span class="lbl-dim">🔗 Тр: Від ${srcName} (Жила ${(xc.fromCore || 0) + 1})</span>`;
              }
           }
        }
      }
    }
  } else if (n.type === "MDU") {
    let archTxt = n.architecture === "FTTB" ? "FTTB" : "FTTH";
    L1 = `<span class="lbl-name lbl-mdu">🏢 ${n.name} (${archTxt})</span>`;
    const s = sigAtONU(n);
    const conn = conns.find((x) => x.to === n && (x.type === "patchcord" || x.type === "cable"));
    
    if (s !== null) {
      L2 = `<span class="lbl-sig ${sigColorClass(s)}">${s.toFixed(1)}дБ</span>`;
      if (conn && conn.from) {
          const fromIcon = (conn.from.type === "FOB" && conn.from.subtype === "MUFTA") ? "🛢️" : (conn.from.type === "OLT" ? "🗄️" : "📦");
          const fromTypeLabel = conn.type === "cable" ? "Кабель" : "Патч";
          L2 += `<br><span class="lbl-dim">Вхід: ${fromIcon} ${conn.from.name} (${fromTypeLabel})</span>`;
          
          if (conn.from.crossConnects && conn.from.type !== "OLT") {
             const xc = conn.from.crossConnects.find(x => (x.toType === "CABLE" || x.toType === "PATCHCORD") && x.toId === conn.id);
             if (xc) {
                if (xc.fromType === "SPLITTER") {
                   let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
                   if (/** @type {any} */(conn.from).splitters) {
                       let spInst = /** @type {any} */(conn.from).splitters.find(/** @type {any} */s=>s.id === xc.fromId);
                       if (spInst) spName = `${spInst.type} ${spInst.ratio}`;
                   }
                   let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
                   L2 += `<br><span class="lbl-dim">🔀 Ком: ${spName} (Вихід ${port})</span>`;
                } else if (xc.fromType === "CABLE") {
                   let inConn = conns.find(c => c.id === xc.fromId);
                   let srcName = inConn ? inConn.from.name : "?";
                   L2 += `<br><span class="lbl-dim">🔀 Тр: Від ${srcName} (Жила ${(xc.fromCore || 0) + 1})</span>`;
                }
             }
          }
      }
      if (n.architecture === "FTTB") {
          const totalAbon = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
          const pen = typeof n.penetrationRate === "number" ? n.penetrationRate : 50;
          const totalSubs = Math.ceil(totalAbon * (pen / 100));
          L2 += `<br><span class="lbl-dim">👥 Аб: <b style="color:#e3b341">${totalSubs}</b> / ${totalAbon} (${pen}%)</span>`;
      } else {
          const connectedFlats = (n.flats || []).filter(f => f.crossConnect).length;
          const totalFlats = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
          L2 += `<br><span class="lbl-dim">🚪 Кв: <b style="color:#e3b341">${connectedFlats}</b> / ${totalFlats}</span>`;
      }
    } else {
       L2 += `<span class="lbl-dim">⚠️ Не підключений</span>`;
    }
  }

  return L1 + (L2 ? `<div class="tooltip-details">${L2}</div>` : "");
}

/** @param {any} n */
function updateNodeLabel(n) {
  const content = buildNodeLabelContent(n);

  // Оновити tooltip з правильним режимом відображення
  updateNodeTooltip(n, content);

  // Rich hover popup
  n.marker.unbindPopup();
  n.marker.bindPopup(buildTooltip(n), {
    className: "node-popup",
    closeButton: false,
    autoPan: false,
    offset: [0, -10],
  });
  // Show/hide popup on hover (but not during cable/patchcord drawing)
  n.marker.off("mouseover.popup mouseout.popup");
  n.marker.on("mouseover.popup", () => {
    const leaderLine = onuLeaderLinesByNodeId.get(n.id);
    const llEl = /** @type {HTMLElement} */ (leaderLine && leaderLine.getElement ? leaderLine.getElement() : null);
    if (llEl) {
        L.DomUtil.addClass(llEl, 'onu-leader-line-hover');
        leaderLine.bringToFront();
    }
    const endpoint = onuEndpointsByNodeId.get(n.id);
    const epEl = /** @type {HTMLElement} */ (endpoint && endpoint.getElement ? endpoint.getElement() : null);
    if (epEl) {
        L.DomUtil.addClass(epEl, 'onu-endpoint-hover');
    }
    const tt = n.marker.getTooltip();
    if (tt && tt._container) L.DomUtil.addClass(tt._container, 'tooltip-hover-glow');

    // Don't show popup if we're drawing a connection or if connection is already started
    if (!["cable", "patchcord"].includes(tool) && !connStart) {
      n.marker.openPopup();
    }
  });
  n.marker.on("mouseout.popup", () => {
    const leaderLine = onuLeaderLinesByNodeId.get(n.id);
    const llEl = /** @type {HTMLElement} */ (leaderLine && leaderLine.getElement ? leaderLine.getElement() : null);
    if (llEl) {
        L.DomUtil.removeClass(llEl, 'onu-leader-line-hover');
    }
    const endpoint = onuEndpointsByNodeId.get(n.id);
    const epEl = /** @type {HTMLElement} */ (endpoint && endpoint.getElement ? endpoint.getElement() : null);
    if (epEl) {
        L.DomUtil.removeClass(epEl, 'onu-endpoint-hover');
    }
    const tt = n.marker.getTooltip();
    if (tt && tt._container) L.DomUtil.removeClass(tt._container, 'tooltip-hover-glow');

    // Close popup on mouseout, but keep it closed if we're drawing
    if (!connStart) {
      n.marker.closePopup();
    }
  });
}

export let tooltipMode = 'AUTO';
export function setTooltipMode(mode) {
  tooltipMode = mode;
  document.getElementById("btn-tt-smart")?.classList.toggle("active", mode === "AUTO");
  document.getElementById("btn-tt-hide")?.classList.toggle("active", mode === "HIDDEN");
  updateTooltipsVisibility();
}

// Адаптивне відображення tooltip'ів
function updateNodeTooltip(node, content) {
  // SKIP rebinding during drag to prevent tooltip disappearing or jittering
  if (node._isDragging) return;

  const zoom = map.getZoom();
  const minZoomForPermanent = 16;
  
  if (tooltipMode === "HIDDEN") {
    const tt = node.marker.getTooltip();
    if (tt) node.marker.unbindTooltip();
    return;
  }
  
  if (node.type === "OLT" || node.type === "FOB") {
    const tt = node.marker.getTooltip();
    if (tt && tt.options.permanent === true && node.marker.isTooltipOpen()) {
      node.marker.setTooltipContent(content);
    } else {
      if (tt) node.marker.unbindTooltip();
      node.marker.bindTooltip(content, {
        permanent: true,
        direction: "bottom",
        className: "node-label",
        offset: [0, 5],
      });
    }
  } else if (node.type === "ONU" || node.type === "MDU") {
    const shouldBePermanent = zoom >= minZoomForPermanent;
    const tt = node.marker.getTooltip();
    const isCurrentlyPermanent = tt ? (tt.options.permanent === true) : null;
    
    const offset = node._tooltipOffset || [0, 5];
    const className = "node-label" + (node._hasLeader ? " onu-callout" : "");

    // Leaflet bugs out if we mutate options natively on an open tooltip, or if we force it open
    // while it thinks it's closed. The cleanest fix is to unbind/bind if IT CLOSED (due to drag) or geometry changed.
    let needsRebind = false;
    
    // Check missing or closed
    if (!tt || (shouldBePermanent && !node.marker.isTooltipOpen())) {
      needsRebind = true;
    } else if (isCurrentlyPermanent !== shouldBePermanent) {
      needsRebind = true;
    } else {
      // Check geometry/CSS changes safely
      const currOff = tt.options.offset;
      let currX = 0, currY = 5;
      if (currOff) {
          currX = currOff.x !== undefined ? currOff.x : currOff[0];
          currY = currOff.y !== undefined ? currOff.y : currOff[1];
      }
      if (currX !== offset[0] || currY !== offset[1] || tt.options.className !== className || tt.options.direction !== (node._tooltipDir || "bottom")) {
        needsRebind = true;
      }
    }

    if (needsRebind) {
      if (tt) node.marker.unbindTooltip();
      node.marker.bindTooltip(content, {
        permanent: shouldBePermanent,
        direction: node._tooltipDir || "bottom",
        className: className,
        offset: offset,
        sticky: !shouldBePermanent, 
      });
      // automatically opens it correctly!
    } else {
      // Normal update without geometry changes
      node.marker.setTooltipContent(content);
    }

    // Attach cross-highlight events for the transparent tooltip box
    // using a timeout to ensure Leaflet has pushed _container into the DOM
    setTimeout(() => {
        const tt = node.marker.getTooltip();
        if (tt && tt._container && !tt._container._hoverAttached) {
            tt._container._hoverAttached = true;
            L.DomEvent.on(tt._container, 'mouseenter', () => {
                const leaderLine = onuLeaderLinesByNodeId.get(node.id);
                const llEl = /** @type {HTMLElement} */ (leaderLine && leaderLine.getElement ? leaderLine.getElement() : null);
                if (llEl) {
                    L.DomUtil.addClass(llEl, 'onu-leader-line-hover');
                    leaderLine.bringToFront();
                }
                const endpoint = onuEndpointsByNodeId.get(node.id);
                const epEl = /** @type {HTMLElement} */ (endpoint && endpoint.getElement ? endpoint.getElement() : null);
                if (epEl) {
                    L.DomUtil.addClass(epEl, 'onu-endpoint-hover');
                }
                const mEl = node.marker && node.marker.getElement ? node.marker.getElement() : null;
                if (mEl) {
                    L.DomUtil.addClass(mEl, 'highlighted-marker');
                }
            });
            L.DomEvent.on(tt._container, 'mouseleave', () => {
                const leaderLine = onuLeaderLinesByNodeId.get(node.id);
                const llEl = /** @type {HTMLElement} */ (leaderLine && leaderLine.getElement ? leaderLine.getElement() : null);
                if (llEl) {
                    L.DomUtil.removeClass(llEl, 'onu-leader-line-hover');
                }
                const endpoint = onuEndpointsByNodeId.get(node.id);
                const epEl = /** @type {HTMLElement} */ (endpoint && endpoint.getElement ? endpoint.getElement() : null);
                if (epEl) {
                    L.DomUtil.removeClass(epEl, 'onu-endpoint-hover');
                }
                const mEl = node.marker && node.marker.getElement ? node.marker.getElement() : null;
                if (mEl) {
                    L.DomUtil.removeClass(mEl, 'highlighted-marker');
                }
            });
        }
    }, 50);
  }
}

// Оновити видимість tooltip'ів для всіх вузлів при зміні zoom
function updateTooltipsVisibility() {
  const zoom = map.getZoom();

  const mapEl = document.getElementById("map");
  if (mapEl) {
    if (zoom < 16) {
      mapEl.classList.add("map-zoomed-out");
    } else {
      mapEl.classList.remove("map-zoomed-out");
    }
  }

  if (zoom < 16 || tooltipMode === "HIDDEN") {
    clearONULeaderLines();
  }

  // Обчислюємо нові позиції тултипів (без сліпого unbind/bind)
  layoutONUTooltips();

  nodes.forEach((/** @type {any} */ n) => {
    // Перебудувати tooltip з правильним режимом
    const content = buildNodeLabelContent(n);
    updateNodeTooltip(n, content);
  });

  // Оновити індикатор зуму
  const zv = document.getElementById("zoom-val");
  const zs = document.getElementById("zoom-slider");
  if (zv) zv.innerText = String(zoom);
  if (zs) /** @type {HTMLInputElement} */ (zs).value = String(zoom);
}

// ═══════════════════════════════════════════════
//  ONU TOOLTIP SMART LAYOUT (hybrid: direction + leader lines)
// ═══════════════════════════════════════════════

function clearONULeaderLines() {
  onuLeaderLines.forEach((l) => map.removeLayer(l));
  onuLeaderLines = [];
  onuLeaderLinesByNodeId.clear();
  onuEndpointsByNodeId.clear();
  // Reset layout hints on all ONU nodes
  nodes.forEach((n) => {
    if (n.type === "ONU" || n.type === "MDU") {
      delete n._tooltipDir;
      delete n._tooltipOffset;
      delete n._hasLeader;
    }
  });
}

/**
 * Lay out ONU tooltips using a Topology-Based "Theatre" layout.
 * ONUs are grouped by their logical upstream connection (FOB/OLT) and arranged
 * in arcs above or below the parent node based on the splitter branch.
 */
function layoutONUTooltips() {
  onuLeaderLines.forEach((l) => map.removeLayer(l));
  onuLeaderLines = [];

  const zoom = map.getZoom();
  if (zoom < 16 || tooltipMode === "HIDDEN") return;

  const onus = nodes.filter((n) => n.type === "ONU" || n.type === "MDU");
  if (onus.length === 0) return;

  const bounds = map.getBounds().pad(0.15);
  const visibleOnus = onus.filter((n) => bounds.contains([n.lat, n.lng]));
  if (visibleOnus.length === 0) return;

  const ONU_W = 110, ONU_H = 40;
  
  const FOB_GROUPS = new Map();
  const ORPHANS = [];

  // 1. Group ONUs by their upstream node (stage)
  visibleOnus.forEach(n => {
     let placed = false;
     const conn = conns.find(c => c.to === n && (c.type === "patchcord" || c.type === "cable"));
     if (conn && conn.from && (conn.from.type === "FOB" || conn.from.type === "OLT")) {
         const fob = conn.from;

         if (!FOB_GROUPS.has(fob.id)) {
             FOB_GROUPS.set(fob.id, { fob: fob, nodes: [] });
         }
         
         const pt = map.latLngToContainerPoint([n.lat, n.lng]);
         FOB_GROUPS.get(fob.id).nodes.push({ node: n, pt: pt });
         placed = true;
     }

     if (!placed) {
         ORPHANS.push(n);
     }
  });

  // 2. Lay out each group in a single sweeping arc around the FOB
  for (const [fobId, group] of FOB_GROUPS.entries()) {
      const fobPt = map.latLngToContainerPoint([group.fob.lat, group.fob.lng]);
      
      const layoutArc = (items) => {
          if (items.length === 0) return;

          // Check for manual overrides
          const tCfg = group.fob._tooltipConfig || { direction: "AUTO", distance: 250 };
          let dirAngle = 0;

          if (tCfg.direction !== "AUTO") {
             // Map joystick direction to radians (0 is Right, -PI/2 is Up, PI/2 is Down)
             const dirMap = {
                 "RIGHT": 0, "BOTTOM_RIGHT": Math.PI/4, "DOWN": Math.PI/2, "BOTTOM_LEFT": Math.PI*0.75,
                 "LEFT": Math.PI, "TOP_LEFT": -Math.PI*0.75, "UP": -Math.PI/2, "TOP_RIGHT": -Math.PI/4
             };
             dirAngle = dirMap[tCfg.direction] !== undefined ? dirMap[tCfg.direction] : Math.PI/2;
          } else {
             // Calculate center of mass to decide if arc goes UP or DOWN automatically
             let sumY = 0;
             items.forEach(it => { sumY += it.pt.y; });
             const avgY = sumY / items.length;
             dirAngle = avgY <= fobPt.y ? -Math.PI/2 : Math.PI/2;
          }

          const count = items.length;
          let slots = [];
          const baseDist = parseInt(tCfg.distance) || 250;

          // Determine grid block orientation
          // We always use an axis-aligned dense grid to map the wide rectangular tooltips perfectly.
          // Only the grid's ANCHOR orbits the FOB at `baseDist` and `dirAngle`.
          const isHorizontal = Math.abs(Math.cos(dirAngle)) > 0.8; 
          const itemsPerTier = isHorizontal ? 6 : 5; 

          // Safe tooltip bounding box sizing for 4-5 line properties
          const scale = (tCfg.spacing !== undefined ? tCfg.spacing : 100) / 100;
          const boxW = 165 * scale;
          const boxH = 85 * scale; 

          const Fsign = isHorizontal ? Math.sign(Math.cos(dirAngle)) : Math.sign(Math.sin(dirAngle)) || 1;

          const anchorX = fobPt.x + Math.cos(dirAngle) * baseDist;
          const anchorY = fobPt.y + Math.sin(dirAngle) * baseDist;

          // Generate geometric slots in the dense grid
          for (let i = 0; i < count; i++) {
              const tier = Math.floor(i / itemsPerTier); 
              const itemsInThisTier = Math.min(itemsPerTier, count - tier * itemsPerTier);
              const posInTier = i % itemsPerTier;

              // Center the tier laterally
              const lateralOffset = posInTier - (itemsInThisTier - 1) / 2;

              let sx = anchorX;
              let sy = anchorY;

              if (isHorizontal) {
                  // Grid GROWS along X, SPREADS along Y 
                  sx += tier * boxW * Fsign;
                  sy += lateralOffset * boxH;
              } else {
                  // Grid GROWS along Y, SPREADS along X
                  sx += lateralOffset * boxW;
                  sy += tier * boxH * Fsign;
              }

              slots.push({ x: sx, y: sy });
          }

          // Projection mathematics: To completely avoid crossed lines, we sort both the houses
          // and the layout slots by their position precisely along the Lateral axis, 
          // breaking ties using the Forward axis. 
          const latAxis = isHorizontal ? 'y' : 'x';
          const fwdAxis = isHorizontal ? 'x' : 'y';

          const sortFn = (a, b) => {
             // For houses, properties are inside .pt. For slots, they are top-level.
             const ptA = a.pt || a;
             const ptB = b.pt || b;
             
             const diffLat = ptA[latAxis] - ptB[latAxis];
             if (Math.abs(diffLat) > 5) return diffLat; 
             return (ptA[fwdAxis] - ptB[fwdAxis]) * Fsign;
          };

          items.sort(sortFn);
          slots.sort(sortFn);

          // Assign each item to its perfectly matched slot
          const w2 = boxW / 2;
          const h2 = boxH / 2;

          for (let i = 0; i < count; i++) {
              const item = items[i];
              const slot = slots[i];
              
              const dx = item.pt.x - slot.x;
              const dy = item.pt.y - slot.y;
              let anchorX = slot.x;
              let anchorY = slot.y;
              /** @type {import('leaflet').Direction} */
              let tDir = "top";

              if (Math.abs(dx) > Math.abs(dy)) {
                  if (dx > 0) { anchorX += w2; tDir = "left"; }
                  else        { anchorX -= w2; tDir = "right"; }
              } else {
                  if (dy > 0) { anchorY += h2; tDir = "top"; }
                  else        { anchorY -= h2; tDir = "bottom"; }
              }

              const n = item.node;
              n._tooltipDir = tDir; 
              n._tooltipOffset = [Math.round(anchorX - item.pt.x), Math.round(anchorY - item.pt.y)];
              n._hasLeader = true;

              const tp = L.point(anchorX, anchorY);
              const mLL = map.containerPointToLatLng(item.pt);
              const tLL = map.containerPointToLatLng(tp);
              
              const line = L.polyline([mLL, tLL], /** @type {any} */ ({
                 weight: 1.5, color: "#ffffffbb", dashArray: "6,4",
                 interactive: false, className: "onu-leader-line", pmIgnore: true,
              })).addTo(map);

              const endpoint = L.circleMarker(tLL, {
                  radius: 3.5, fillColor: "#58a6ff", fillOpacity: 1, 
                  color: "#0d1117", weight: 1.5,
                  interactive: false, pmIgnore: true,
                  className: "onu-endpoint-dot"
              }).addTo(map);

              onuLeaderLines.push(line);
              onuLeaderLines.push(endpoint);
              onuLeaderLinesByNodeId.set(n.id, line);
              onuEndpointsByNodeId.set(n.id, endpoint);
          }
      };

      layoutArc(group.nodes);
  }

  ORPHANS.forEach(n => {
      n._tooltipDir = "bottom";
      n._tooltipOffset = [0, 5];
      n._hasLeader = false;
  });
}

/**
 * Handle UI manual overrides for Tooltip positioning logic per node
 * @param {string} id 
 * @param {string} prop "direction" | "distance"
 * @param {any} val 
 * @param {boolean} shouldRedraw 
 */
window.updateTooltipConfig = function(id, prop, val, shouldRedraw = true) {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    if (!n._tooltipConfig) n._tooltipConfig = { direction: "AUTO", distance: 250, spacing: 100 };
    n._tooltipConfig[prop] = val;
    
    // Save to global state so it exports to JSON
    saveState();
    
    // Rerender properties panel to update active joystick button color
    if (prop === "direction") {
        showProps(n);
    }
    
    // Only trigger full map line redraw if explicitly requested or if it's a structural property change
    if (shouldRedraw) {
        // Force unbind to reset offsets, then recalculate arcs, then re-bind
        nodes.forEach(no => {
            if ((no.type === "ONU" || no.type === "MDU") && no.marker) {
                // If it's connected to THIS FOB, force a complete rebuild of its tooltip location
                const c = conns.find(cc => cc.to === no && (cc.type === "patchcord" || cc.type === "cable"));
                if (c && c.from && c.from.id === id) {
                    no.marker.closeTooltip();
                    no.marker.unbindTooltip();
                    delete no._tooltipOffset;
                    delete no._tooltipDir;
                    delete no._hasLeader;
                }
            }
        });
        // @ts-ignore
        if (typeof window.renderLinks === 'function') {
            // @ts-ignore
            window.renderLinks();
        } else {
            clearONULeaderLines();
            updateTooltipsVisibility();
        }
    }
};

// updateStats() is defined below (ported from monolith)


/**
 * Fit map view to all nodes (basic implementation).
 */
export function fitNetwork() {
  if (!map || nodes.length === 0) return;
  const group = L.featureGroup(/** @type {any} */ (nodes.map((n) => n.marker)));
  map.fitBounds(group.getBounds().pad(0.2));
}

// ═══════════════════════════════════════════════
//  UI HELPERS (tooltips, props, ctx, selectors)
// ═══════════════════════════════════════════════

/** @param {any} n */
function buildTooltip(n) {
  if (n.type === "OLT") {
    let t = `<strong style='color:#58a6ff'>${n.name}</strong><br>`;
    t += `⚡ Потужність: ${Number(n.outputPower || 0).toFixed(1)} дБ<br>`;
    const xcArr = n.crossConnects || [];
    for (let i = 0; i < n.ports; i++) {
      const activeCores = xcArr.filter(x => parseInt(String(x.fromId)) === i && x.toType === "CABLE");
      if (activeCores.length > 0) {
        const targetNodes = [...new Set(activeCores.map(x => {
            const cable = conns.find(cf => cf.id === x.toId);
            return cable ? cable.to?.name : "";
        }))].filter(Boolean).join(", ");
        const color = PON_COLORS[i % PON_COLORS.length];
        let subs = cntSubsPort(n, i);
        let subsStr = subs > 0 ? ` (Аб: ${subs})` : "";
        t += `PON ${i + 1} ➔ ${targetNodes}: <span style='color:${color}'>${activeCores.length} жил(и)${subsStr}</span><br>`;
      }
    }
    return t;
  } else if (n.type === "FOB") {
    const fobIcon = (n.subtype === "MUFTA") ? "🛢️" : "📦";
    const tColor = (n.subtype === "MUFTA") ? "#e3b341" : "#3fb950";
    let t = `<strong style='color:${tColor}'>${fobIcon} ${n.name}</strong><br>`;
    if (n.inputConn) {
      const si = sigIn(n);
      if (si !== null) {
        t += `📥 IN: <span style='color:${sigClass(si) === "ok" ? "#3fb950" : sigClass(si) === "warn" ? "#d29922" : "#f85149"}'>${si.toFixed(2)} дБ</span><br>`;
      } else {
        t += `📥 IN: <span style='color:#8b949e'>немає сигналу</span><br>`;
      }
      let branchTag = "";
      if (n.inputConn.branch) branchTag = ` (гілка ${n.inputConn.branch})`;
      else if (n.inputConn.from.type === "FOB" && n.inputConn.from.plcType) branchTag = ` (через PLC)`;
      let capStr = n.inputConn.capacity ? ` (${n.inputConn.capacity} жил)` : "";
      const srcIcon = n.inputConn.from.type === "OLT" ? "🗄️" : (n.inputConn.from.subtype === "MUFTA" ? "🛢️" : "📦");
      t += `📡 Від: ${srcIcon} ${n.inputConn.from.name || n.inputConn.from.type}${capStr}${branchTag}<br>`;
    } else {
      t += `⚠️ Не підключений (Input)<br>`;
    }
    if (n.fbtType) t += `🔀 FBT: ${n.fbtType}<br>`;
    if (n.plcType) {
      t += `📊 PLC: ${n.plcType}<br>`;
      if (n.inputConn) {
        const so = sigONU(n);
        if (so !== null) {
          t += `→ONU: <span style='color:${sigClass(so) === "ok" ? "#3fb950" : sigClass(so) === "warn" ? "#d29922" : "#f85149"}'>${so.toFixed(2)} дБ</span><br>`;
        }
      }
    }
    const pi = fobPortStatus(n);
    t += `<div style="margin-top:4px; padding-top:4px; border-top:1px dashed #444c56;">`;
    pi.rich.forEach((pp) => (t += `${pp}<br>`));
    t += `</div>`;
    return t;
  } else if (n.type === "ONU") {
    const s = sigAtONU(n);
    const conn = conns.find((c) => c.to === n && c.type === "patchcord");
    let t = `<strong style='color:#ff7b72'>🏠 ${n.name}</strong><br>`;
    if (s !== null) {
      t += `📶 Сигнал: <span style='color:${sigClass(s) === "ok" ? "#3fb950" : sigClass(s) === "warn" ? "#d29922" : "#f85149"}'>${s.toFixed(2)} дБ</span><br>`;
      const fromIcon = (conn?.from?.type === "FOB" && conn.from.subtype === "MUFTA") ? "🛢️" : "📦";
      if (conn?.from) t += `${fromIcon} Від: ${conn.from.name}<br>`;
      
      if (conn?.from?.crossConnects) {
         const xc = conn.from.crossConnects.find(x => (x.toType === "CABLE" || x.toType === "PATCHCORD") && x.toId === conn.id);
         if (xc) {
            if (xc.fromType === "SPLITTER") {
               let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
               if (/** @type {any} */(conn.from).splitters) {
                   let spInst = /** @type {any} */(conn.from).splitters.find(/** @type {any} */s=>s.id === xc.fromId);
                   if (spInst) spName = `${spInst.type} ${spInst.ratio}`;
               }
               let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
               t += `🔗 Порт: ${spName} (Вихід ${port})<br>`;
            } else if (xc.fromType === "CABLE") {
               let inConn = conns.find(c => c.id === xc.fromId);
               let srcName = inConn ? inConn.from.name : "?";
               let srcCap = inConn && inConn.capacity ? ` з ${inConn.capacity}` : "";
               t += `🔗 Транзит: Від ${srcName} (Жила ${(xc.fromCore || 0) + 1}${srcCap})<br>`;
            }
         }
      }
    } else {
      t += `⚠️ Не підключений (немає кросування)`;
    }
    return t;
  } else if (n.type === "MDU") {
    const s = sigAtONU(n);
    const conn = conns.find((c) => c.to === n && (c.type === "patchcord" || c.type === "cable"));
    let archTxt = n.architecture === "FTTB" ? "FTTB" : "FTTH";
    let t = `<strong style='color:#a371f7'>🏢 ${n.name} (${archTxt})</strong><br>`;
    if (s !== null) {
      t += `📶 Сигнал (вхід): <span style='color:${sigClass(s) === "ok" ? "#3fb950" : sigClass(s) === "warn" ? "#d29922" : "#f85149"}'>${s.toFixed(2)} дБ</span><br>`;
      const fromIcon = (conn?.from?.type === "FOB" && conn.from.subtype === "MUFTA") ? "🛢️" : (conn?.from?.type === "OLT" ? "🗄️" : "📦");
      const fromTypeLabel = conn?.type === "cable" ? "Кабель" : "Патч";
      if (conn?.from) t += `${fromIcon} Вхід: ${conn.from.name} (${fromTypeLabel})<br>`;
      
      if (conn?.from?.crossConnects && conn.from.type !== "OLT") {
         const xc = conn.from.crossConnects.find(x => (x.toType === "CABLE" || x.toType === "PATCHCORD") && x.toId === conn.id);
         if (xc) {
            if (xc.fromType === "SPLITTER") {
               let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
               if (/** @type {any} */(conn.from).splitters) {
                   let spInst = /** @type {any} */(conn.from).splitters.find(/** @type {any} */s=>s.id === xc.fromId);
                   if (spInst) spName = `${spInst.type} ${spInst.ratio}`;
               }
               let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
               t += `🔀 Комутація: ${spName} (Вихід ${port})<br>`;
            } else if (xc.fromType === "CABLE") {
               let inConn = conns.find(c => c.id === xc.fromId);
               let srcName = inConn ? inConn.from.name : "?";
               t += `🔀 Транзит: Від ${srcName} (Жила ${(xc.fromCore || 0) + 1})<br>`;
            }
         }
      } else if (conn?.type === "cable") {
         t += `🔌 Пряме магістральне підключення<br>`;
      }
      
      t += `<div style="margin-top:4px; padding-top:4px; border-top:1px dashed #444c56;">`;
      if (n.architecture === "FTTB") {
          const totalAbon = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
          const pen = typeof n.penetrationRate === "number" ? n.penetrationRate : 50;
          const totalSubs = Math.ceil(totalAbon * (pen / 100));
          t += `👥 Абонентів (розрах.): <span style="color:#e3b341">${totalSubs}</span> / ${totalAbon} (${pen}%)<br>`;
      } else {
          const connectedFlats = (n.flats || []).filter(f => f.crossConnect).length;
          const totalFlats = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
          t += `🚪 Квартири: <span style="color:#e3b341">${connectedFlats}</span> / ${totalFlats} підключено<br>`;
      }
      t += `</div>`;
    } else {
      t += `⚠️ Не підключений (немає кросування)`;
    }
    return t;
  }
  return "";
}

window.updateOltStatsUI = function(id) {
  const n = nodes.find((x) => x.id === id);
  if (!n || n.type !== "OLT") return;
  const container = document.getElementById("olt-stats-container");
  if (container) {
    container.innerHTML = window.getOltStatsHtml(n);
  }
};

window.getOltStatsHtml = function(n) {
  let h = "";
  for (let i = 0; i < n.ports; i++) {
    const c = cntONUport(n, i);
    const subs = cntSubsPort(n, i);
    const max = n.maxOnuPerPort || 64;
    const pct = Math.round((c / max) * 100);
    const barColor =
      c > max ? "#f85149" : c > max * 0.75 ? "#d29922" : "#3fb950";
    
    const subText = subs > 0 ? ` <span style="color:#a371f7; font-weight:600">(${subs} аб.)</span>` : "";
      
    h += `<div style="font-size:11px;margin-top:3px">
      <span style="color:#8b949e">Порт ${i + 1}:</span> ${c}/${max} ONU${subText}
      <div style="height:3px;background:#21262d;border-radius:2px;margin-top:2px">
        <div style="height:3px;width:${Math.min(pct, 100)}%;background:${barColor};border-radius:2px"></div>
      </div>
    </div>`;
  }
  return h;
};

/** @param {any} n */
function showProps(n) {
  const p = document.getElementById("props");
  if (!p) return;
  if (!n) {
    p.innerHTML =
      '<div style="padding:40px;text-align:center;color:#d5dce5">👆 Оберіть елемент</div>';
    return;
  }

  const isMufta = n.type === "FOB" && /** @type {any} */(n).subtype === "MUFTA";
  const pIcon = n.type === "OLT" ? "🗄️" : (n.type === "MDU" ? "🏢" : (isMufta ? "🛢️" : (n.type === "FOB" ? "📦" : "🏠")));
  const pColor = n.type === "OLT" ? "#58a6ff" : (n.type === "MDU" ? "#a371f7" : (isMufta ? "#e3b341" : (n.type === "FOB" ? "#3fb950" : "#ff7b72")));
  
  let h = `<div class="node-card"><h3 style="color:${pColor}">${pIcon} ${n.name}</h3>`;

  // Rename
  h += `<div style="display:flex;gap:5px;margin-bottom:10px"><input id="ren" value="${n.name}" style="flex:1" onchange="updNode('${n.id}', 'name', this.value)"></div>`;

  if (n.type === "OLT") {
    h += `<div style="margin-bottom:8px">
      <label>Потужність (дБ):</label>
      <div style="display:flex;align-items:center;gap:6px">
        <input type="range" min="0" max="10" step="0.5" value="${n.outputPower}" style="flex:1;accent-color:#58a6ff" oninput="document.getElementById('pwr-num').value=this.value; updNode('${n.id}','outputPower', parseFloat(this.value))">
        <input id="pwr-num" type="number" min="0" max="10" step="0.5" value="${n.outputPower}" style="width:55px;text-align:center" onchange="this.previousElementSibling.value=this.value; updNode('${n.id}','outputPower', parseFloat(this.value))">
      </div>
    </div>`;
    h += `<div style="margin-bottom:6px">Портів: <input type="number" value="${n.ports}" min="1" max="16" style="width:55px" oninput="updNode('${n.id}','ports', parseInt(this.value)); window.updateOltStatsUI('${n.id}')"></div>`;
    h += `<div style="margin-bottom:8px">Макс ONU/порт: <input type="number" value="${n.maxOnuPerPort || 64}" min="1" max="128" style="width:55px" oninput="updNode('${n.id}','maxOnuPerPort', parseInt(this.value)); window.updateOltStatsUI('${n.id}')"></div>`;

    // Port usage stats (bars per port)
    h += `<div id="olt-stats-container">`;
    h += window.getOltStatsHtml(n);
    h += `</div>`;

    h += `<button class="btn" style="margin-top:15px;width:100%;background:#1f6feb;color:#ffffff;border:1px solid #388bfd;padding:6px;border-radius:6px;font-weight:bold;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.2);transition:all 0.2s;" onmouseover="this.style.background='#388bfd';this.style.boxShadow='0 4px 8px rgba(0,0,0,0.3)';" onmouseout="this.style.background='#1f6feb';this.style.boxShadow='0 2px 4px rgba(0,0,0,0.2)';" onclick="window.openPatchPanel('${n.id}')">🎛️ Оптичний крос (ODF)</button>`;
  } else if (n.type === "FOB") {
    // "⚙️ Дільники" section moved to Cross-Connect Splice Cassette modal for better UX

    h += `<button class="btn" style="margin-top:15px;width:100%;background:#8957e5;color:#ffffff;border:1px solid #a371f7;padding:6px;border-radius:6px;font-weight:bold;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.2);transition:all 0.2s;" onmouseover="this.style.background='#a371f7';this.style.boxShadow='0 4px 8px rgba(0,0,0,0.3)';" onmouseout="this.style.background='#8957e5';this.style.boxShadow='0 2px 4px rgba(0,0,0,0.2)';" onclick="window.openCrossConnect('${n.id}')">🪛 Касета (Зварювання)</button>`;

    // --- Calculate Capacity Stats ---
    let totalSpOuts = 0;
    if (n.splitters) {
        n.splitters.forEach(sp => totalSpOuts += (sp.type === "PLC" ? (parseInt(sp.ratio.split("x")[1]) || 2) : 2));
    }
    if (n.fbtType && !(n.splitters||[]).some(s=>s.id==="legacy_fbt")) totalSpOuts += 2;
    if (n.plcType && !(n.splitters||[]).some(s=>s.id==="legacy_plc")) totalSpOuts += (parseInt(n.plcType.split("x")[1]) || 2);
    
    const usedSpOuts = (n.crossConnects || []).filter(xc => xc.fromType === "SPLITTER").length;
    const fP = Math.max(0, totalSpOuts - usedSpOuts);
    
    const inCables = conns.filter(c => c.to === n && c.type === "cable");
    let totalInCores = 0;
    inCables.forEach(c => totalInCores += parseInt(String(c.capacity || 1)));
    const usedInCores = (n.crossConnects || []).filter(xc => xc.fromType === "CABLE").length;
    const fC = Math.max(0, totalInCores - usedInCores);

    let capacityText = `<div style="font-size:10px;margin-top:8px;border-top:1px dashed #444c56;padding-top:6px; color:#a5d6ff; display:flex; gap:10px; justify-content:space-around;">`;
    if (totalSpOuts > 0) {
        capacityText += `<span title="Вільні виходи дільників для підключення ONU/MDU" style="color:#8b949e"><i class="fa-solid fa-plug" style="margin-right:2px;"></i> На абонентів: <b style="color:#fff">${fP}</b></span>`;
        if (totalInCores > 0) capacityText += `<span title="Вільні гілки дільників або транзитних жил для подальшої магістралі" style="color:#8b949e"><i class="fa-solid fa-satellite-dish" style="margin-right:2px;"></i> Транзит: <b style="color:#fff">${fC}</b></span>`;
    } else {
        if (totalInCores > 0) capacityText += `<span title="Вільні жили для транзиту або підключення дільників" style="color:#8b949e"><i class="fa-solid fa-layer-group" style="margin-right:2px;"></i> Вільних жил в касеті: <b style="color:#fff">${fC}</b></span>`;
        else capacityText += `<span style="color:#8b949e; opacity:0.6;"><i class="fa-solid fa-link-slash" style="margin-right:2px;"></i> Магістраль не підключена</span>`;
    }
    capacityText += `</div>`;

    if (n.inputConn) {
      const dist = connKm(n.inputConn) * 1000;
      const loss = (dist / 1000) * FIBER_DB_KM;
      const s = sigIn(n);
      
      let fromInfo = n.inputConn.from.name || n.inputConn.from.type;
      if (n.inputConn.branch) fromInfo += ` (гілка ${n.inputConn.branch})`;
      else if (n.inputConn.from.type === "FOB" && n.inputConn.from.plcType) fromInfo += ` (через PLC)`;
      
      h += `<div style="background:#21262d; border:1px solid #30363d; border-radius:6px; padding:6px; margin-top:10px;">`;
      h += `<div style="color:#8b949e; font-size:10px; font-weight:bold; letter-spacing:1px; margin-bottom:8px; display:flex; align-items:center; gap:6px; text-transform:uppercase;"><i class="fa-solid fa-wave-square" style="font-size:11px;"></i> СИГНАЛ</div>`;
      
      let sigStr = s !== null ? `${s.toFixed(2)} дБ` : `---`;
      let sigColor = s !== null ? (s >= -25 ? "#3fb950" : (s >= -28 ? "#d29922" : "#f85149")) : "#8b949e";
      let pct = s !== null ? Math.max(0, Math.min(100, ((s + 26) / 26) * 100)) : 0;
      
      h += `<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:4px;">
          <span style="color:#8b949e; font-size:12px;">Від ${fromInfo}</span>
          <span style="color:${sigColor}; font-size:14px; font-weight:bold;">${sigStr}</span>
      </div>`;
      h += `<div style="height:6px; background:#0d1117; border-radius:3px; overflow:hidden; position:relative; border:1px solid #30363d;">
          <div style="height:100%; width:${pct}%; background:${sigColor}; transition:width 0.3s;"></div>
      </div>`;
      h += `<div style="display:flex; justify-content:space-between; margin-top:4px; font-size:10px; color:#8b949e;">
          <span>-26</span>
          <span>0 дБ</span>
      </div>`;
      h += `<div style="font-size:10px; color:#8b949e; margin-top:8px; text-align:right;">Довжина лінії: ${dist.toFixed(0)}м (втрати ~${loss.toFixed(2)}дБ)</div>`;
      
      h += capacityText;
      h += `</div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px; display:flex; align-items:center; justify-content:center; gap:6px;"><i class="fa-solid fa-triangle-exclamation"></i> Не підключено</div>`;
      h += `<div style="background:#21262d; border:1px solid #30363d; border-radius:6px; padding:6px; margin-top:10px;">
              <div style="color:#8b949e; font-size:10px; font-weight:bold; letter-spacing:1px; margin-bottom:0px; display:flex; align-items:center; gap:6px; text-transform:uppercase;"><i class="fa-solid fa-wave-square" style="font-size:11px;"></i> СИГНАЛ</div>
              ${capacityText}
            </div>`;
    }

    // --- NEW: Manual Tooltip Config ---
    const tCfg = n._tooltipConfig || { direction: "AUTO", distance: 250 };
    
    h += `<details style="background:#21262d; border:1px solid #30363d; border-radius:6px; margin-top:10px;">`;
    h += `<summary style="padding:6px; cursor:pointer; color:#8b949e; font-size:10px; font-weight:bold; letter-spacing:1px; display:flex; align-items:center; gap:6px; text-transform:uppercase; outline:none; user-select:none;">
            <i class="fa-solid fa-tag" style="font-size:11px;"></i> ЗМІЩЕННЯ ПІДПИСІВ
          </summary>`;
    
    h += `<div style="padding:0 10px 10px 10px; display:flex; gap:12px; align-items:center;">
            <div style="display:grid; grid-template-columns:repeat(3, 20px); gap:2px; background:#0d1117; padding:4px; border-radius:4px; border:1px solid #30363d; flex-shrink:0;">`;
    
    const dirs = [
       { label: "<i class='fa-solid fa-arrow-up-left'></i>", val: "TOP_LEFT", raw: "↖" }, { label: "<i class='fa-solid fa-arrow-up'></i>", val: "UP", raw: "↑" }, { label: "<i class='fa-solid fa-arrow-up-right'></i>", val: "TOP_RIGHT", raw: "↗" },
       { label: "<i class='fa-solid fa-arrow-left'></i>", val: "LEFT", raw: "←" }, { label: "A", val: "AUTO", raw: "A", title: "Авто" }, { label: "<i class='fa-solid fa-arrow-right'></i>", val: "RIGHT", raw: "→" },
       { label: "<i class='fa-solid fa-arrow-down-left'></i>", val: "BOTTOM_LEFT", raw: "↙" }, { label: "<i class='fa-solid fa-arrow-down'></i>", val: "DOWN", raw: "↓" }, { label: "<i class='fa-solid fa-arrow-down-right'></i>", val: "BOTTOM_RIGHT", raw: "↘" }
    ];
    // Fallback to text labels since diagonal arrows might be pro-only in FA6 free
    const fallbackDirs = [
       { label: "↖", val: "TOP_LEFT" }, { label: "↑", val: "UP" }, { label: "↗", val: "TOP_RIGHT" },
       { label: "←", val: "LEFT" }, { label: "A", val: "AUTO", title: "Авто" }, { label: "→", val: "RIGHT" },
       { label: "↙", val: "BOTTOM_LEFT" }, { label: "↓", val: "DOWN" }, { label: "↘", val: "BOTTOM_RIGHT" }
    ];
    
    fallbackDirs.forEach(d => {
        const bg = tCfg.direction === d.val ? "#1f6feb" : "#21262d";
        const c = tCfg.direction === d.val ? "#fff" : "#8b949e";
        h += `<button onclick="window.updateTooltipConfig('${n.id}', 'direction', '${d.val}')" 
                      title="${d.title || d.val}"
                      style="width:20px; height:20px; background:${bg}; color:${c}; border:1px solid #30363d; border-radius:3px; cursor:pointer; font-size:11px; padding:0; display:flex; align-items:center; justify-content:center;">
                  ${d.label}
              </button>`;
    });        
    h += `  </div>
            <div style="flex:1; display:flex; flex-direction:column; justify-content:center; gap:8px;">
                <div style="display:flex; flex-direction:column; gap:2px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#c9d1d9;">
                        <span>Відстань:</span>
                        <span id="tt-dist-val-${n.id}">${tCfg.distance}px</span>
                    </div>
                    <input type="range" min="50" max="600" step="10" value="${tCfg.distance}" 
                           oninput="document.getElementById('tt-dist-val-${n.id}').innerText=this.value+'px'; window.updateTooltipConfig('${n.id}', 'distance', parseInt(this.value), false);"
                           onchange="window.updateTooltipConfig('${n.id}', 'distance', parseInt(this.value), true);"
                           style="width:100%; height:4px; cursor:pointer;">
                </div>
                
                <div style="display:flex; flex-direction:column; gap:2px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#c9d1d9;">
                        <span>Щільність:</span>
                        <span id="tt-space-val-${n.id}">${tCfg.spacing !== undefined ? tCfg.spacing : 100}%</span>
                    </div>
                    <input type="range" min="50" max="250" step="5" value="${tCfg.spacing !== undefined ? tCfg.spacing : 100}" 
                           oninput="document.getElementById('tt-space-val-${n.id}').innerText=this.value+'%'; window.updateTooltipConfig('${n.id}', 'spacing', parseInt(this.value), false);"
                           onchange="window.updateTooltipConfig('${n.id}', 'spacing', parseInt(this.value), true);"
                           style="width:100%; height:4px; cursor:pointer;">
                </div>
            </div>
          </div>`;

    h += `</details>`;

    
    // Connected nodes block
    const connectedNodes = conns.filter(c => c.from === n).map(c => c.to);
    if (connectedNodes.length > 0) {
        h += `<div style="background:#21262d; border:1px solid #30363d; border-radius:6px; padding:6px; margin-top:10px;">`;
        h += `<div style="color:#8b949e; font-size:10px; font-weight:bold; letter-spacing:1px; margin-bottom:8px; display:flex; align-items:center; justify-content:space-between; text-transform:uppercase;">
                <span style="display:flex; align-items:center; gap:6px;"><i class="fa-solid fa-network-wired" style="font-size:11px;"></i> Підключені вузли</span>
                <span style="background:#0d1117; padding:2px 6px; border-radius:10px; font-size:9px;">${connectedNodes.length}</span>
              </div>`;
        h += `<div class="mini-scroll" style="display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto; padding-right:4px;">`;
        
        connectedNodes.forEach(toNode => {
            let toSig = null;
            if (toNode.type === "ONU") toSig = sigAtONU(toNode);
            else if (toNode.type === "MDU") toSig = calculateMDUSignal(toNode);
            else if (toNode.type === "FOB") toSig = sigIn(toNode);
            else toSig = null;
            
            let tagHtml = "";
            let dotColor = "#8b949e";
            
            if (toSig !== null) {
                if (toSig >= -25) { 
                    tagHtml = `<span style="border:1px solid #1c4528; background:#102216; color:#3fb950; font-size:10px; padding:2px 4px; border-radius:3px; font-weight:bold;">OK</span>`; 
                    dotColor = "#3fb950";
                } else if (toSig >= -28.5) {
                    tagHtml = `<span style="border:1px solid #6b5314; background:#2c2108; color:#d29922; font-size:10px; padding:2px 4px; border-radius:3px; font-weight:bold;">Межа</span>`;
                    dotColor = "#d29922";
                } else {
                    tagHtml = `<span style="border:1px solid #6e2723; background:#2e1114; color:#f85149; font-size:10px; padding:2px 4px; border-radius:3px; font-weight:bold;">Крит.</span>`;
                    dotColor = "#f85149";
                }
            } else {
                tagHtml = `<span style="border:1px solid #30363d; background:#161b22; color:#8b949e; font-size:10px; padding:2px 4px; border-radius:3px; font-weight:bold;">N/A</span>`;
            }
            
            const toSigStr = toSig !== null ? `${toSig.toFixed(2)} дБ` : `---`;
            h += `<div style="display:flex; justify-content:space-between; align-items:center; background:#161b22; border:1px solid #30363d; padding:4px 6px; border-radius:4px;">
                <div style="display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden;">
                    <div style="width:8px; height:8px; border-radius:50%; background:${dotColor}; flex-shrink:0;"></div>
                    <span style="color:#c9d1d9; font-size:12px; font-weight:bold; overflow:hidden; text-overflow:ellipsis;">${toNode.name}</span>
                    <span style="color:#8b949e; font-size:12px;">·</span>
                    <span style="color:#8b949e; font-size:12px;">${toSigStr}</span>
                </div>
                ${tagHtml}
            </div>`;
        });
        h += `</div></div>`;
    }
  } else if (n.type === "ONU") {
    const s = sigAtONU(n);
    if (s !== null) {
      h += `<div class="info-pill" style="margin-top:10px">Сигнал: <b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено до PON</div>`;
    }
  } else if (n.type === "MDU") {
    const totalAbon = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
    h += `<div style="margin-bottom:6px">Поверхів: <input type="number" value="${n.floors}" min="1" max="50" style="width:55px" onchange="updNode('${n.id}','floors', parseInt(this.value))"></div>`;
    h += `<div style="margin-bottom:6px">Під'їздів: <input type="number" value="${n.entrances}" min="1" max="20" style="width:55px" onchange="updNode('${n.id}','entrances', parseInt(this.value))"></div>`;
    h += `<div style="margin-bottom:8px">Кв. на поверсі: <input type="number" value="${n.flatsPerFloor}" min="1" max="20" style="width:55px" onchange="updNode('${n.id}','flatsPerFloor', parseInt(this.value))"></div>`;
    h += `<div style="font-size:11px; color:#c9d1d9; font-weight:bold; margin-bottom:10px;">Всього квартир: <span style="color:#e3b341">${totalAbon}</span></div>`;
    const arch = n.architecture || "FTTH";
    const pen = typeof n.penetrationRate === "number" ? n.penetrationRate : 50;
    const activeAbon = Math.ceil(totalAbon * (pen / 100));

    h += `<div style="margin-top:10px;margin-bottom:6px;border-top:1px solid #30363d;padding-top:10px;">
      <label>Архітектура: 
        <select onchange="updNode('${n.id}','architecture', this.value); showProps(nodes.find(x=>x.id==='${n.id}'))" style="width:80px;background:#161b22;color:#fff;border:1px solid #30363d;border-radius:4px;padding:2px">
          <option value="FTTH" ${arch === "FTTH" ? "selected" : ""}>FTTH</option>
          <option value="FTTB" ${arch === "FTTB" ? "selected" : ""}>FTTB</option>
        </select>
      </label>
    </div>`;

    if (arch === "FTTB") {
        h += `<div style="margin-bottom:8px">
          <label style="display:block;margin-bottom:4px">Діючі підключення (штук / відсоток):</label>
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
             <div style="flex:1; display:flex; align-items:center; background:#0d1117; border:1px solid #30363d; border-radius:4px; overflow:hidden;">
                 <input type="number" id="mdu-act-flats-${n.id}" value="${activeAbon}" min="0" max="${totalAbon}" style="width:100%; border:none; background:transparent; color:#58a6ff; font-weight:bold; text-align:center; padding:4px;"
                        onchange="const val=Math.min(Math.max(parseInt(this.value)||0, 0), ${totalAbon}); this.value=val; const pct = ${totalAbon} > 0 ? Math.round((val/${totalAbon})*100) : 0; document.getElementById('mdu-pen-val-${n.id}').value=pct; updNode('${n.id}','penetrationRate', pct); showProps(nodes.find(x=>x.id==='${n.id}'));">
                 <span style="padding:4px 8px; font-size:11px; color:#8b949e; background:#21262d; border-left:1px solid #30363d;">кв.</span>
             </div>
             
             <div style="flex:1; display:flex; align-items:center; background:#0d1117; border:1px solid #30363d; border-radius:4px; overflow:hidden;">
                 <input type="number" id="mdu-pen-val-${n.id}" value="${pen}" min="0" max="100" style="width:100%; border:none; background:transparent; color:#c9d1d9; text-align:center; padding:4px;"
                        onchange="const val=Math.min(Math.max(parseInt(this.value)||0, 0), 100); this.value=val; const act = Math.ceil(${totalAbon} * (val/100)); document.getElementById('mdu-act-flats-${n.id}').value=act; updNode('${n.id}','penetrationRate', val); showProps(nodes.find(x=>x.id==='${n.id}'));">
                 <span style="padding:4px 8px; font-size:11px; color:#8b949e; background:#21262d; border-left:1px solid #30363d;">%</span>
             </div>
          </div>
        </div>`;

        // --- NEW: Uplink Fiber Selection ---
        h += `<div style="margin-top:10px; border-top:1px solid #30363d; padding-top:10px;">
                <label style="display:block;margin-bottom:6px;color:#c9d1d9;">🔌 Підключені Uplink-жили:</label>`;
        
        const mduConns = conns.filter(c => c.to === n && (c.type === "cable" || c.type === "patchcord"));
        if (mduConns.length === 0) {
            h += `<div style="font-size:11px;color:#8b949e;text-align:center;">Немає підключень</div>`;
        } else {
            mduConns.forEach(c => {
                const cores = c.capacity || 1;
                for(let i=0; i<cores; i++) {
                    const key = `${c.type.toUpperCase()}|${c.id}|${c.type==="patchcord"?0:i}`;
                    const isChecked = !n.uplinks || n.uplinks.includes(key);
                    
                    let sigStr = "";
                    let s = null;
                    if (c.from.type === "OLT") {
                        const xc = (c.from.crossConnects || []).find(x => x.toType === c.type.toUpperCase() && x.toId === c.id && x.toCore === i);
                        if (xc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
                    } else if (c.from.type === "FOB") {
                        const upstream = traceOpticalPath(c.from, c.type.toUpperCase(), c.id, i);
                        if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
                    }
                    if (s !== null) {
                        const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                        sigStr = `<span style="color:${sColor}; font-weight:bold; font-size:10px;">⚡ ${s.toFixed(1)} дБ</span>`;
                    } else {
                        sigStr = `<span style="color:#8b949e; font-size:10px;">(вимкнено)</span>`;
                    }
                    
                    const lbl = c.type === "patchcord" ? "Патчкорд" : `Жила ${i+1}`;
                    h += `<div style="display:flex; align-items:center; justify-content:space-between; background:#21262d; border:1px solid rgba(255,255,255,0.05); border-radius:4px; padding:4px 8px; margin-bottom:4px;">
                            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:11px; margin:0;">
                                <input type="checkbox" ${isChecked ? "checked" : ""} onchange="window.toggleMduUplink('${n.id}', '${key}', this.checked)">
                                <span>${lbl} <span style="color:#8b949e;">(від ${c.from.name})</span></span>
                            </label>
                            ${sigStr}
                          </div>`;
                }
            });
        }
        h += `</div>`;
    } else {
       h += `<button class="btn" style="margin-top:10px;width:100%;background:#238636;color:#ffffff;border:1px solid #2ea043;padding:6px;border-radius:6px;font-weight:bold;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.2);transition:all 0.2s;" onmouseover="this.style.background='#2ea043';this.style.boxShadow='0 4px 8px rgba(0,0,0,0.3)';" onmouseout="this.style.background='#238636';this.style.boxShadow='0 2px 4px rgba(0,0,0,0.2)';" onclick="window.openMDUInternalTopology && window.openMDUInternalTopology('${n.id}')">⚙️ Схема під'їзду (FTTH)</button>`;
    }

    const s = sigAtONU(n);
    if (s !== null) {
      h += `<div class="info-pill" style="margin-top:10px">Оптичний Сигнал: <b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено до PON</div>`;
    }
  }

  h += `<button class="btn" style="margin-top:15px;width:100%;background:#da3633;color:#ffffff;border:1px solid #f85149;padding:6px;border-radius:6px;font-weight:bold;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.2);transition:all 0.2s;" onmouseover="this.style.background='#f85149';this.style.boxShadow='0 4px 8px rgba(0,0,0,0.3)';" onmouseout="this.style.background='#da3633';this.style.boxShadow='0 2px 4px rgba(0,0,0,0.2)';" onclick="deleteNodeById('${n.id}')">🗑️ Видалити</button></div>`;
  p.innerHTML = h;
}

/** @param {string} id
 * @param {string} prop
 * @param {any} val
 */
function updNode(id, prop, val) {
  /** @type {any} */
  const n = nodes.find((x) => x.id === id);
  if (!n) return;
  saveState();
  n[prop] = val;
  if (prop === "name") updateNodeLabel(n);
  if (prop === "outputPower") nodes.forEach((x) => updateNodeLabel(x)); // Ensure label changes if node properties change
  if (["architecture", "floors", "entrances", "flatsPerFloor"].includes(prop)) showProps(n); // Refresh panel for MDU geometry changes
  updateNodeLabel(n);
  saveState(); // This saveState is already present, no need to duplicate
  updateStats();
  if (["fbtType", "plcType", "plcBranch"].includes(prop)) {
    const plcBr = n.plcBranch || "Y";
    const freeBr = plcBr === "X" ? "Y" : "X";
    const outConns = conns.filter((c) => c.from === n);
    outConns.forEach((c) => {
      if (n.fbtType && n.plcType) {
        if (c.type === "patchcord") c.branch = plcBr;
        else if (c.type === "cable" && !c.branch) c.branch = freeBr;
      } else if (n.fbtType && !n.plcType) {
        if ((c.type === "cable" || c.type === "patchcord") && !c.branch) {
          const xUsed = outConns.some((x) => x !== c && x.branch === "X");
          const yUsed = outConns.some((x) => x !== c && x.branch === "Y");
          c.branch = !xUsed ? "X" : !yUsed ? "Y" : "X";
        }
      } else if (n.plcType && !n.fbtType) {
        delete c.branch;
      } else {
        delete c.branch;
      }
    });
    nodes.forEach((x) => updateNodeLabel(x));
    updateCableColors();
  }
}

/**
 * Adds a new splitter to a FOB node
 * @param {string} id 
 * @param {"FBT" | "PLC"} type 
 * @param {string} ratio 
 */
export function addSplitter(id, type, ratio) {
  const n = nodes.find(x => x.id === id);
  if (!n || n.type !== "FOB") return;
  if (!n.splitters) n.splitters = [];
  
  const modal = document.getElementById("cross-connect-modal");
  if (modal && modal.style.display === "block") {
     if (typeof window.saveCrossConnect === "function") window.saveCrossConnect(id, true);
  }
  
  const prefix = type === "FBT" ? "fbt" : "plc";
  const newId = `${prefix}_${Math.random().toString(36).substr(2, 4)}`;
  
  n.splitters.push({ id: newId, type, ratio });
  saveState();
  showProps(n);
  updateNodeLabel(n);
  
  if (modal && modal.style.display === "block") {
     if (typeof window.openCrossConnect === "function") window.openCrossConnect(id);
  }
}

/**
 * Removes a splitter from a FOB node
 * @param {string} nodeId 
 * @param {string} splitterId 
 */
export function removeSplitter(nodeId, splitterId) {
  const n = nodes.find(x => x.id === nodeId);
  if (!n || n.type !== "FOB" || !n.splitters) return;
  
  const modal = document.getElementById("cross-connect-modal");
  if (modal && modal.style.display === "block") {
     if (typeof window.saveCrossConnect === "function") window.saveCrossConnect(nodeId, true);
  }

  if (n.crossConnects && n.crossConnects.some(xc => xc.fromId === splitterId || xc.toId === splitterId)) {
     if (!confirm("Цей дільник використовується у зварюваннях. При видаленні всі зварювання з ним також будуть видалені. Продовжити?")) {
        return;
     }
     n.crossConnects = n.crossConnects.filter(xc => !(xc.fromId === splitterId || xc.toId === splitterId));
  }
  
  n.splitters = n.splitters.filter(s => s.id !== splitterId);
  saveState();
  showProps(n);
  updateStats();
  if (typeof window.refreshNetworkUI === "function") window.refreshNetworkUI();
  
  if (modal && modal.style.display === "block") {
     if (typeof window.openCrossConnect === "function") window.openCrossConnect(nodeId);
  }
}
/**
 * @param {any} n
 * @param {string} branch
 */
function isBranchFull(n, branch) {
  if (n.fbtType && n.plcType) {
    const plcBr = n.plcBranch || "Y";
    if (branch === plcBr) {
      const plcMax = parseInt(n.plcType.split("x")[1]);
      const plcUsed = conns.filter((c) => c.from === n && c.branch === plcBr).length;
      return plcUsed >= plcMax;
    }
    return conns.some((c) => c.from === n && c.branch === branch);
  } else if (n.fbtType) {
    return conns.some((c) => c.from === n && c.branch === branch);
  } else if (n.plcType) {
    const plcMax = parseInt(n.plcType.split("x")[1]);
    return usedOutputs(n) >= plcMax;
  }
  return usedOutputs(n) >= 1;
}

export function reassignBranch(connId, newBranch) {
  const c = conns.find((x) => x.id === connId);
  if (!c) return;
  const n = c.from;
  if (isBranchFull(n, newBranch)) {
    alert("Ця гілка вже зайнята! Звільніть її або оберіть іншу.");
    showProps(n);
    return;
  }
  saveState();
  c.branch = newBranch;
  nodes.forEach((x) => updateNodeLabel(x));
  updateCableColors();
  if (selNode) showProps(selNode);
}

function deleteNode(n) {
  if (!n) return;
  saveState();
  map.removeLayer(/** @type {any} */ (n.marker));
  conns
    .filter((c) => c.from === n || c.to === n)
    .forEach((c) => {
      map.removeLayer(c.polyline);
      if (c._distTooltip) map.removeLayer(c._distTooltip);
    });
  for (let i = conns.length - 1; i >= 0; i--) {
    const c = conns[i];
    if (c.from === n || c.to === n) conns.splice(i, 1);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i] === n) nodes.splice(i, 1);
  }
  nodes.forEach((x) => {
    if (x.type === "FOB") x.inputConn = conns.find((c) => c.to === x && c.type === "cable") || null;
  });
  selNode = null;
  showProps(null);
  updateStats();
}

/**
 * Public Location Search Function using Nominatim API (OpenStreetMap)
 * Called from bottom toolbar input.
 */
let searchTimeout = null;

/**
 * Handle input for Nominatim Autocomplete
 * @param {Event} e
 */
window.handleSearchInput = function(e) {
  const input = /** @type {HTMLInputElement} */ (document.getElementById("loc-search-input"));
  const query = input.value.trim();
  
  let dropdown = document.getElementById("search-autocomplete-list");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.id = "search-autocomplete-list";
    dropdown.className = "search-autocomplete";
    input.parentElement?.appendChild(dropdown);
  }

  if (!query || query.length < 3) {
    dropdown.style.display = "none";
    return;
  }

  if (searchTimeout) clearTimeout(searchTimeout);
  
  searchTimeout = setTimeout(() => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&countrycodes=ua&accept-language=uk`;
    fetch(url)
      .then(res => res.json())
      .then(data => {
        dropdown.innerHTML = "";
        if (data && data.length > 0) {
          dropdown.style.display = "flex";
          data.forEach((/** @type {any} */ item) => {
            const div = document.createElement("div");
            div.className = "search-autocomplete-item";
            
            // Format a nice display string
            const addr = item.address || {};
            const city = addr.city || addr.town || addr.village || "";
            const road = addr.road || "";
            const house = addr.house_number || "";
            
            let labelParts = [];
            if (road) labelParts.push(`${road}${house ? ' ' + house : ''}`);
            if (city) labelParts.push(city);
            const mainLabel = labelParts.length > 0 ? labelParts.join(', ') : item.display_name.split(',')[0];
            
            div.innerHTML = `<span>📍</span> <span>${mainLabel} <span style="color:#8b949e; font-size:10px;">${item.display_name.split(',').slice(-2).join(',')}</span></span>`;
            
            div.onclick = () => {
              input.value = mainLabel;
              dropdown.style.display = "none";
              const lat = parseFloat(item.lat);
              const lon = parseFloat(item.lon);
              map.flyTo([lat, lon], 17, { animate: true, duration: 1.5 });
              input.style.color = "#3fb950"; 
              setTimeout(() => { input.style.color = ""; input.blur(); }, 2000);
            };
            dropdown.appendChild(div);
          });
        } else {
          dropdown.style.display = "none";
        }
      })
      .catch(err => {
        console.error("Помилка автодоповнення:", err);
      });
  }, 400); // 400ms debounce
};

/**
 * Public Location Search Function using Nominatim API (OpenStreetMap)
 * Called from bottom toolbar input.
 */
function searchLocation() {
  const input = /** @type {HTMLInputElement} */ (document.getElementById("loc-search-input"));
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;

  const dropdown = document.getElementById("search-autocomplete-list");
  if (dropdown) dropdown.style.display = "none";

  // Visual feedback: searching state
  const originalColor = input.style.color;
  input.style.color = "#58a6ff"; // Blue while searching

  // Check if query is coordinates
  const coordParts = query.split(/[\s,]+/).map(Number);
  if (coordParts.length >= 2 && !isNaN(coordParts[0]) && !isNaN(coordParts[1]) &&
      coordParts[0] >= -90 && coordParts[0] <= 90 && coordParts[1] >= -180 && coordParts[1] <= 180) {
    
    // Fly map to new coordinates immediately
    map.flyTo([coordParts[0], coordParts[1]], 17, { animate: true, duration: 1.5 });
    input.style.color = "#3fb950"; // Green success
    input.value = "";
    
    // Update status bar for consistency
    const statusMsg = document.getElementById("status-msg");
    if (statusMsg) {
      statusMsg.innerHTML = `<i class="fa-solid fa-location-dot" style="color:#58a6ff"></i> ${coordParts[0].toFixed(4)}, ${coordParts[1].toFixed(4)}`;
      setTimeout(() => {
        statusMsg.innerHTML = `<i class="fa-solid fa-check" style="color: #3fb950;"></i> Система готова`;
      }, 5000);
    }
    
    setTimeout(() => { input.style.color = originalColor; input.blur(); }, 2000);
    return;
  }

  // Fallback to Nominatim OpenStreetMap URL if not coordinates
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;

  fetch(url)
    .then((res) => res.json())
    .then((data) => {
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        // Fly map to new coordinates
        map.flyTo([lat, lon], 17, { animate: true, duration: 1.5 });
        input.style.color = "#3fb950"; // Green success
        setTimeout(() => { input.style.color = originalColor; input.blur(); }, 2000);
      } else {
        input.style.color = "#f85149"; // Red error (not found)
        setTimeout(() => (input.style.color = originalColor), 2000);
      }
    })
    .catch((err) => {
      console.error("Помилка геокодування:", err);
      input.style.color = "#f85149";
      setTimeout(() => (input.style.color = originalColor), 2000);
    });
}

// Close autocomplete when clicking outside
document.addEventListener("click", (e) => {
  const input = document.getElementById("loc-search-input");
  const dropdown = document.getElementById("search-autocomplete-list");
  if (dropdown && input && /** @type {any} */ (e.target) !== input && !dropdown.contains(/** @type {any} */ (e.target))) {
    dropdown.style.display = "none";
  }
});

function deleteConn(c) {
  if (!c) return;
  saveState();
  if (c._distTooltip) map.removeLayer(c._distTooltip);
  map.removeLayer(c.polyline);
  for (let i = conns.length - 1; i >= 0; i--) {
    if (conns[i] === c) conns.splice(i, 1);
  }
  if (c.type === "cable" && c.to?.type === "FOB") c.to.inputConn = null;
  updateStats();
  nodes.forEach((x) => updateNodeLabel(x));
  if (selNode) showProps(selNode);
}

function showNodeCtx(e, n) {
  const m = document.getElementById("ctx-menu");
  if (!m) return;
  m.style.left = e.originalEvent.clientX + "px";
  m.style.top = e.originalEvent.clientY + "px";
  m.style.display = "block";
  m.innerHTML = `<div class="ctx-item" onclick="selectNodeById('${n.id}')">Налаштувати</div>
                 <div class="ctx-item danger" onclick="deleteNodeById('${n.id}')">Видалити</div>`;
}

function showConnCtx(e, c) {
  const m = document.getElementById("ctx-menu");
  if (!m) return;
  const mouseE = e.originalEvent || e;
  m.style.left = mouseE.clientX + "px";
  m.style.top = mouseE.clientY + "px";
  m.style.display = "block";
  const len = connKm(c) * 1000;
  const loss = (len / 1000) * FIBER_DB_KM;
  m.innerHTML = `<div class="ctx-item">📏 ${len.toFixed(1)} м</div>
                 <div class="ctx-item">📉 ${loss.toFixed(2)} дБ</div>
                 <div class="ctx-item danger" onclick="deleteConnById('${c.id}')">🗑️ Видалити з'єднання</div>`;
}

// showOLTPortSel removed

export function finishOLT(oid, fid, port) {
  const o = nodes.find((x) => x.id === oid);
  const f = nodes.find((x) => x.id === fid);
  showProps(null); // hide standard properties
  const color = ["#00d4ff", "#ff69b4", "#ff8c00", "#b4ff00"][port % 4];
  promptCableCapacity(o, f, "cable", color, () => {
    if (typeof window.openPatchPanel === "function") window.openPatchPanel(o.id);
  }, { fromPort: port });
}

export function updateStats() {
  const oltCount = nodes.filter((n) => n.type === "OLT").length;
  const fobCount = nodes.filter((n) => n.type === "FOB" && n.subtype !== "MUFTA").length;
  const closureCount = nodes.filter((n) => n.type === "FOB" && n.subtype === "MUFTA").length;
  
  const elOlt = document.getElementById("s-olt");
  if (elOlt) elOlt.textContent = String(oltCount);
  
  const elFob = document.getElementById("s-fob");
  if (elFob) elFob.textContent = String(fobCount);
  
  const mduCount = nodes.filter((n) => n.type === "MDU").length;
  const elMdu = document.getElementById("s-mdu");
  if (elMdu) elMdu.textContent = String(mduCount);

  const elMufta = document.getElementById("s-mufta");
  if (elMufta) elMufta.textContent = String(closureCount);
  
  let onuCnt = nodes.filter((n) => n.type === "ONU").length;
  nodes.filter((n) => n.type === "MDU").forEach(mdu => {
     const pen = typeof mdu.penetrationRate === "number" ? mdu.penetrationRate : 100;
     onuCnt += Math.ceil(((mdu.floors || 0) * (mdu.entrances || 0) * (mdu.flatsPerFloor || 0)) * (pen / 100));
  });
  
  const elOnu = document.getElementById("s-onu");
  if (elOnu) elOnu.textContent = String(onuCnt);

  const elConn = document.getElementById("s-conn");
  if (elConn) elConn.textContent = String(conns.length);

  // Update new global Status Bar
  const statsEl = document.getElementById("status-stats");
  if (statsEl) {
    statsEl.textContent = `OLT: ${oltCount} | FOB: ${fobCount} | Муфт: ${closureCount} | Ліній: ${conns.length} | Абонентів: ${onuCnt}`;
  }
  updateCableColors();
  refreshSignalAnim();
  // Lazy import to avoid circular dependency with ui.js
  import("./ui.js").then((ui) => ui.updateValidationBadge());
}

// Expose internal functions for inline HTML handlers
window.refreshNetworkUI = () => {
  nodes.forEach(x => {
    updateNodeLabel(x);
  });
  conns.forEach(c => {
    if (c.type === "cable" && typeof updateConnLabel === "function") updateConnLabel(c);
  });
  if (typeof updateTooltipsVisibility === "function") updateTooltipsVisibility();
  updateStats();
};

window.updNode = updNode;
window.addSplitter = addSplitter;
window.removeSplitter = removeSplitter;
window.selectNodeById = (id) => {
  const n = nodes.find((x) => x.id === id);
  if (!n) return;
  selNode = n;
  showProps(n);
  highlightSignalPath(n);
};
window.showSelectedProps = () => {
  if (selNode) showProps(selNode);
};
window.deleteNodeById = (id) => {
  const n = nodes.find((x) => x.id === id);
  if (n) deleteNode(n);
};
window.deleteConnById = (id) => {
  const c = conns.find((x) => x.id === id);
  if (c) deleteConn(c);
};
window.finishOLT = finishOLT;
window.reassignBranch = reassignBranch;
window.searchLocation = searchLocation;

window.toggleMduUplink = function(nodeId, key, isChecked) {
    const mdu = /** @type {MDUNode} */ (nodes.find(x => x.id === nodeId));
    if (!mdu || mdu.type !== "MDU") return;
    
    saveState();
    if (!mdu.uplinks) {
        mdu.uplinks = [];
        const mduConns = conns.filter(c => c.to === mdu && (c.type === "cable" || c.type === "patchcord"));
        mduConns.forEach(c => {
            const cores = c.capacity || 1;
            for(let i=0; i<cores; i++) mdu.uplinks.push(`${c.type.toUpperCase()}|${c.id}|${c.type==="patchcord"?0:i}`);
        });
    }
    
    if (isChecked) {
        if (!mdu.uplinks.includes(key)) mdu.uplinks.push(key);
    } else {
        mdu.uplinks = mdu.uplinks.filter(k => k !== key);
    }
    
    updateStats();
    showProps(mdu);
    
    // Live update OLT stats if there's any active OLT
    nodes.filter(x => x.type === "OLT").forEach(o => {
        if (typeof window.updateOltStatsUI === "function") window.updateOltStatsUI(o);
    });
};