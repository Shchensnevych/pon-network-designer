// @ts-check
// Core map + network logic for modular PON Designer.
// Signal calculations live in signal.js, shared arrays in state.js.

import {
  FBT_LOSSES,
  PLC_LOSSES,
  MECH,
  ONU_MIN,
  FIBER_DB_KM,
  fobCounter,
  onuCounter,
  mduCounter,
  setCounters,
  nextFobNumber,
  nextOnuNumber,
  nextMduNumber,
  iconOLT,
  iconFOB,
  iconONU,
  iconMDU,
} from "./config.js";
import { sigClass, sigColorClass } from "./utils.js";

// Shared state — used by signal.js for calculations
import { nodes, conns, map, setMap } from "./state.js";

// Signal calculations — extracted to signal.js (~320 lines removed)
import {
  getChainColor, usedCables, usedPatches, usedOutputs,
  maxOutputs, freeCablePorts, freePatchPorts,
  fobPortStatus, getDistM, connKm, sigIn, 
  hasOLTPath, sigAtONU, sigONU, sigFBT,
  cntONUport, cntDn, getSignalColor, updateCableColors,
} from "./signal.js";

// Signal path highlighting & animation — extracted to signal-path.js
import {
  highlightSignalPath, clearSignalPath,
  refreshSignalAnim, removeSignalAnimOverlays,
  toggleSignalAnim, hasActiveGlow,
} from "./signal-path.js";

import "./cross-connect-ui.js";

// Re-export for main.js and ui.js compatibility
export { nodes, conns, connKm, sigIn, sigONU, hasOLTPath, cntONUport };
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
/** @type {import('leaflet').Polyline[]} */
let onuLeaderLines = []; // Leader lines for dense ONU clusters

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
    if (!["olt", "fob", "onu", "mdu"].includes(type)) return;
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
            <div><span style="display:inline-block;width:12px;height:12px;background:#58a6ff;border-radius:2px;margin-right:6px;vertical-align:middle"></span>OLT</div>
            <div><span style="display:inline-block;width:12px;height:12px;background:#ff6b6b;border-radius:50%;margin-right:6px;vertical-align:middle"></span>FOB</div>
            <div><span style="display:inline-block;width:10px;height:10px;background:#4ade80;border-radius:2px;margin-right:6px;vertical-align:middle"></span>ONU</div>
            <div><span style="display:inline-block;width:14px;height:14px;background:#a371f7;border-radius:3px;margin-right:6px;vertical-align:middle"></span>Багатоповерхівка (MDU)</div>
            <hr style="border-color:#30363d;margin:4px 0">
            <div style="font-size:10px;color:#8b949e;margin-bottom:2px">Сигнал (підсвітка + текст):</div>
            <div><span style="display:inline-block;width:20px;height:3px;background:#3fb950;margin-right:6px;vertical-align:middle"></span>OK (≥ ${ONU_MIN} дБ)</div>
            <div><span style="display:inline-block;width:20px;height:3px;background:#d29922;margin-right:6px;vertical-align:middle"></span>Межа (${ONU_MIN}..${ONU_MIN - 3} дБ)</div>
            <div><span style="display:inline-block;width:20px;height:3px;background:#f85149;margin-right:6px;vertical-align:middle"></span>Слабкий (< ${ONU_MIN - 3} дБ)</div>
            <div><span style="display:inline-block;width:20px;height:3px;background:#6b7280;margin-right:6px;vertical-align:middle"></span>Немає сигналу</div>
            <hr style="border-color:#30363d;margin:4px 0">
            <div>━━ Магістраль &nbsp; ╌╌ Патчкорд</div>
          </div>
        </div>
        <div class="leaflet-toolbar-group">
          <button onclick="undo()" title="Скасувати (Ctrl+Z)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#fff">
              <path d="M9 14 4 9l5-5"/>
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>
            </svg>
          </button>
          <button onclick="redo()" title="Повторити (Ctrl+Y)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#fff">
              <path d="M15 14l5-5-5-5"/>
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>
            </svg>
          </button>
          <button onclick="fitNetwork()" title="Показати всю мережу (Fit All)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#fff">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="22" y1="12" x2="18" y2="12"></line>
              <line x1="6" y1="12" x2="2" y2="12"></line>
              <line x1="12" y1="6" x2="12" y2="2"></line>
              <line x1="12" y1="22" x2="12" y2="18"></line>
              <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
            </svg>
          </button>
          <button onclick="toggleEditMode()" id="btn-edit" title="Редагувати (вигини)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="color:#fff">
              <g transform="translate(-3 -3)">
                <path fill-rule="evenodd" d="M13.5,11 C11.5670034,11 10,9.43299662 10,7.5 C10,5.56700338 11.5670034,4 13.5,4 C15.4329966,4 17,5.56700338 17,7.5 C17,9.43299662 15.4329966,11 13.5,11 Z M13.5,9 C14.3284271,9 15,8.32842712 15,7.5 C15,6.67157288 14.3284271,6 13.5,6 C12.6715729,6 12,6.67157288 12,7.5 C12,8.32842712 12.6715729,9 13.5,9 Z M12.0002889,7.52973893 C12.0125983,8.16273672 12.4170197,8.6996643 12.9807111,8.90767966 L3,15 L3,13 L12.0002889,7.52973893 Z M14.2172722,6.18228472 L19.453125,3 L22.6589355,3 L14.989102,7.68173885 C14.9962971,7.62216459 15,7.56151472 15,7.5 C15,6.93138381 14.6836098,6.4366645 14.2172722,6.18228472 Z M23.4434042,19.2851736 L20.1282799,19.2851736 L21.8729983,23.5349525 C21.9945296,23.8295773 21.8556546,24.1599209 21.5778734,24.2849208 L20.0414675,24.9545142 C19.7550613,25.0795141 19.4338738,24.9366704 19.3123426,24.6509518 L17.6544367,20.6154541 L14.9461873,23.4010151 C14.5852811,23.7721711 14,23.4860463 14,22.9992653 L14,9.57183533 C14,9.05933561 14.6225311,8.809492 14.946156,9.17008555 L23.8340292,18.3120179 C24.1925291,18.6613615 23.9279979,19.2851736 23.4434042,19.2851736 Z"></path>
              </g>
            </svg>
          </button>
          <div class="dropdown">
            <button onclick="document.getElementById('layer-menu').classList.toggle('show');event.stopPropagation()" id="btn-layers" title="Шари">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#fff">
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
            </button>
            <div id="layer-menu" class="dropdown-content">
              <button onclick="setLayer('osm')" id="btn-layer-osm">✓ 🗺️ Карта</button>
              <button onclick="setLayer('sat')" id="btn-layer-sat">🛰️ Супутник</button>
              <button onclick="setLayer('hyb')" id="btn-layer-hyb">🛰️🏷️ Гібрид</button>
            </div>
          </div>
          <div class="zoom-indicator">
            <button class="zoom-btn" id="zoom-minus" title="Зменшити">−</button>
            <div class="zoom-slider-wrap">
              <span id="zoom-val">${map.getZoom()}</span>
              <input type="range" id="zoom-slider" min="${map.getMinZoom()}" max="${map.getMaxZoom()}" value="${map.getZoom()}" step="1" list="zoom-ticks">
              <datalist id="zoom-ticks">
                ${Array.from({ length: 11 }, (_, i) => 10 + i).map(z => `<option value="${z}"></option>`).join("")}
              </datalist>
            </div>
            <button class="zoom-btn" id="zoom-plus" title="Збільшити">+</button>
          </div>
          <button onclick="openOnboarding()" id="btn-help-pulse" title="Онбординг: основи роботи, типи сплітерів, поради">
            ?
          </button>
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

  // Reset icons
  const btnOsm = document.getElementById("btn-layer-osm");
  const btnSat = document.getElementById("btn-layer-sat");
  const btnHyb = document.getElementById("btn-layer-hyb");
  if (btnOsm) btnOsm.innerHTML = "🗺️ Карта";
  if (btnSat) btnSat.innerHTML = "🛰️ Супутник";
  if (btnHyb) btnHyb.innerHTML = "🛰️🏷️ Гібрид";

  if (type === "osm" && streets) {
    streets.addTo(map);
    if (btnOsm) btnOsm.innerHTML = "✓ 🗺️ Карта";
  }
  if (type === "sat" && satellite) {
    satellite.addTo(map);
    if (btnSat) btnSat.innerHTML = "✓ 🛰️ Супутник";
  }
  if (type === "hyb" && hybrid) {
    hybrid.addTo(map);
    if (btnHyb) btnHyb.innerHTML = "✓ 🛰️🏷️ Гібрид";
  }

  const menu = document.getElementById("layer-menu");
  if (menu) menu.classList.remove("show");
}

export function toggleEditMode() {
  if (!map?.pm) return;
  const wasEditing = map.pm.globalEditModeEnabled();
  map.pm.toggleGlobalEditMode();
  const btn = document.getElementById("btn-edit");
  if (btn) btn.classList.toggle("active", map.pm.globalEditModeEnabled());
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
  if (["olt", "fob", "onu", "mdu"].includes(tool)) {
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
  } else if (type === "fob") {
    n.number = nextFobNumber();
    n.name = "FOB-" + n.number;
    n.fbtType = "";
    n.plcType = "";
    n.plcBranch = "";
    n.inputConn = null;
    n.splitters = [];
    n.crossConnects = [];
    n.marker = L.marker(latlng, {
      icon: iconFOB,
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
    if (!d.onuCounter) d.onuCounter = 1;
  }
  // Future: if (version === "1.1") { ... migration logic ... }
  
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
    const icon = n.type === "OLT" ? iconOLT : n.type === "ONU" ? iconONU : n.type === "MDU" ? iconMDU : iconFOB;
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
    n.marker.on("drag", (e) => onNodeDrag(n));
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

  setCounters({ fobCounter: d.fobCounter || 1, onuCounter: d.onuCounter || 1, mduCounter: d.mduCounter || 1 });
  selNode = null;
  showProps(null);
  updateStats();
  // Refresh all tooltip labels after connections are fully restored
  updateTooltipsVisibility();
  _restoring = false;
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

  setCounters({ fobCounter: 1, onuCounter: 1, mduCounter: 1 });
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

function updateConnections(node) {
  conns.forEach((c) => {
    if (c.from === node || c.to === node) {
      c.polyline.setLatLngs(/** @type {import('leaflet').LatLngExpression[]} */ ([[c.from.lat, c.from.lng], [c.to.lat, c.to.lng]]));
      // Refresh distance label
      if (c.type === "cable") updateConnLabel(c);
    }
  });
  // Refresh labels (distances changed)
  nodes.forEach((x) => updateNodeLabel(x));
  refreshSignalAnim();
  // Refresh signal path highlight if active
  if (selNode && hasActiveGlow()) highlightSignalPath(selNode);
}

// ═══════════════════════════════════════════════
//  CONNECTIONS LOGIC
// ═══════════════════════════════════════════════
function addConn(from, to, type) {
  // Basic Checks
  if (type === "cable") {
    if (!["OLT", "FOB"].includes(from.type)) {
      alert("Магістраль: OLT/FOB → FOB");
      return;
    }
    if (to.type !== "FOB") {
      alert("Магістраль має йти до FOB!");
      return;
    }
    if (from === to) {
      alert("Не можна з’єднати елемент сам із собою!");
      return;
    }
    if (to.inputConn) {
      alert(`Box ${to.name} вже має вхід!`);
      return;
    }

    if (from.type === "OLT") {
      // Instead of old showOLTPortSel, we just create the cable and then open Patch Panel
      promptCableCapacity(from, to, type, getChainColor(from), () => {
         if (typeof window.openPatchPanel === "function") {
             window.openPatchPanel(from.id);
         }
      });
      return;
    }

    // FOB -> FOB Rules
    const chainColor = getChainColor(from);
    promptCableCapacity(from, to, type, chainColor, () => {
       if (typeof window.openCrossConnect === "function") window.openCrossConnect(from.id);
    });
    return;
  } else if (type === "patchcord") {
    if (from.type !== "FOB" || (to.type !== "ONU" && to.type !== "MDU")) {
      alert("Патчкорд: FOB → ONU/MDU");
      return;
    }
    createConnection(from, to, type, "#ffd700");
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
  const capLabel = c.capacity ? `<br><span style="font-size:10px; color:#58a6ff;">${c.capacity} жил</span>` : "";
  c._distTooltip = L.tooltip({
    permanent: true,
    direction: "top",
    className: "conn-dist-label",
    offset: [0, -5],
  })
    .setContent(`${dist.toFixed(1)} м${capLabel}`)
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
        portInfo.push(`PON ${i + 1} ➔ [${targetNodes}] (${activeCores.length} жил)`);
      }
    }
    if (portInfo.length)
      L2 += `<br><span class="lbl-dim">${portInfo.join("<br>")}</span>`;
  } else if (n.type === "FOB") {
    L1 = `<span class="lbl-name lbl-fob">${n.name}</span>`;

    // Input signal
    if (n.inputConn) {
      const si = sigIn(n);
      const src = n.inputConn.from.name || n.inputConn.from.type;
      const parent = /** @type {any} */ (n.inputConn.from);
      let br = "";
      if (n.inputConn.branch) {
        if (parent.plcType && parent.plcBranch === n.inputConn.branch) {
          br = `[PLC]`;
        } else if (parent.fbtType) {
          br = `[FBT ${n.inputConn.branch}]`;
        } else {
          br = `[${n.inputConn.branch}]`;
        }
      }
      L2 = `<span class="lbl-dim">IN: ${src}${br ? " " + br : ""}</span>`;
      if (si !== null) {
        L2 += ` <span class="lbl-sig ${sigColorClass(si)}">${si.toFixed(1)}дБ</span>`;
      }
    }

    // Port status
    const pi = fobPortStatus(n);
    pi.lines.forEach((l) => (L2 += `<br>${l}`));

    // FBT branch signals
    if (n.fbtType) {
      const sx = sigFBT(n, "X");
      const sy = sigFBT(n, "Y");
      if (sx !== null && sy !== null) {
        L2 += `<br><span class="${sigColorClass(sx)}">X:${sx.toFixed(1)}дБ</span>`;
        L2 += ` <span class="${sigColorClass(sy)}">Y:${sy.toFixed(1)}дБ</span>`;
      }
    }

    // PLC ONU signal
    if (n.plcType && n.inputConn) {
      const so = sigONU(n);
      if (so !== null) {
        L2 += `<br><span class="${sigColorClass(so)}">→ONU:${so.toFixed(1)}дБ</span>`;
      }
    }

    // Transit indicator
    if (!n.fbtType && !n.plcType) {
      L2 += `<br><span class="lbl-transit">→ транзит</span>`;
    }
  } else if (n.type === "ONU" || n.type === "MDU") {
    L1 = `<span class="lbl-name lbl-onu">${n.name}</span>`;
    const s = sigAtONU(n);
    const conn = conns.find((x) => x.to === n && x.type === "patchcord");
    if (s !== null) {
      L2 = `<span class="lbl-sig ${sigColorClass(s)}">${s.toFixed(1)}дБ</span>`;
      if (conn && conn.from) {
        let tag = "";
        
        if (conn.from.crossConnects) {
           const xc = conn.from.crossConnects.find(x => x.toType === "CABLE" && x.toId === conn.id);
           if (xc) {
              if (xc.fromType === "SPLITTER") {
                 let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
                 let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
                 tag += `[${spName} ${port}]`;
              } else if (xc.fromType === "CABLE") {
                 let inConn = conns.find(c => c.id === xc.fromId);
                 let srcName = inConn ? inConn.from.name : "?";
                 tag += `[Тр. ${srcName} ж.${(xc.fromCore || 0) + 1}]`;
              }
           } else {
             tag += `[Немає кросування]`;
           }
        }
        
        if (!tag) {
            if (conn.branch) tag += `[${conn.branch}]`;
            if (/** @type {any} */ (conn.from).plcType) tag += /** @type {any} */ (conn.from).plcType;
            else if (/** @type {any} */ (conn.from).fbtType) tag += /** @type {any} */ (conn.from).fbtType;
        }
        
        if (tag) L2 += ` <span class="lbl-dim">${tag}</span>`;
      }
    }
  }

  return L1 + (L2 ? "<br>" + L2 : "");
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
    // Don't show popup if we're drawing a connection or if connection is already started
    if (!["cable", "patchcord"].includes(tool) && !connStart) {
      n.marker.openPopup();
    }
  });
  n.marker.on("mouseout.popup", () => {
    // Close popup on mouseout, but keep it closed if we're drawing
    if (!connStart) {
      n.marker.closePopup();
    }
  });
}

// Адаптивне відображення tooltip'ів
function updateNodeTooltip(node, content) {
  // SKIP rebinding during drag to prevent tooltip disappearing or jittering
  if (node._isDragging) return;

  const zoom = map.getZoom();
  const minZoomForPermanent = 15;
  
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
      if (currX !== offset[0] || currY !== offset[1] || tt.options.className !== className) {
        needsRebind = true;
      }
    }

    if (needsRebind) {
      if (tt) node.marker.unbindTooltip();
      node.marker.bindTooltip(content, {
        permanent: shouldBePermanent,
        direction: "bottom",
        className: className,
        offset: offset,
        sticky: !shouldBePermanent, 
      });
      // automatically opens it correctly!
    } else {
      // Normal update without geometry changes
      node.marker.setTooltipContent(content);
    }
  }
}

// Оновити видимість tooltip'ів для всіх вузлів при зміні zoom
function updateTooltipsVisibility() {
  const zoom = map.getZoom();
  
  if (zoom < 15) {
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
 * Lay out ONU tooltips using iterative force-based relaxation.
 * - Collects ALL tooltip bounding boxes (ONU movable, FOB/OLT fixed obstacles)
 * - Iteratively pushes ONU tooltips apart from each other and from obstacles
 * - Draws leader lines for displaced ONU tooltips
 */
function layoutONUTooltips() {
  onuLeaderLines.forEach((l) => map.removeLayer(l));
  onuLeaderLines = [];

  const zoom = map.getZoom();
  if (zoom < 15) return;

  const onus = nodes.filter((n) => n.type === "ONU" || n.type === "MDU");
  if (onus.length === 0) return;

  const bounds = map.getBounds().pad(0.15);
  const visibleOnus = onus.filter((n) => bounds.contains([n.lat, n.lng]));
  if (visibleOnus.length === 0) return;

  // --- Tooltip size estimates (px) ---
  const ONU_W = 110, ONU_H = 40;
  const FOB_W = 145, FOB_H = 120;
  const OLT_W = 140, OLT_H = 70;

  // --- Collect fixed obstacles (FOB/OLT tooltips + their markers) ---
  const fixed = [];
  nodes.forEach((n) => {
    if ((n.type === "FOB" || n.type === "OLT") && n.marker && bounds.contains([n.lat, n.lng])) {
      const pt = map.latLngToContainerPoint([n.lat, n.lng]);
      const w = n.type === "FOB" ? FOB_W : OLT_W;
      const h = n.type === "FOB" ? FOB_H : OLT_H;
      fixed.push({ cx: pt.x, cy: pt.y + 5 + h / 2, w, h });
    }
  });

  // --- Build movable ONU items ---
  const items = visibleOnus.map((n) => {
    const pt = map.latLngToContainerPoint([n.lat, n.lng]);
    return {
      node: n,
      ax: pt.x,                     // anchor X (marker position)
      ay: pt.y,                     // anchor Y
      cx: pt.x,                     // tooltip center X (starts at anchor)
      cy: pt.y + 5 + ONU_H / 2,    // tooltip center Y (starts below marker)
      w: ONU_W,
      h: ONU_H,
    };
  });

  // --- AABB overlap check returning push vector ---
  function overlap(a, b) {
    const ax1 = a.cx - a.w / 2, ax2 = a.cx + a.w / 2;
    const ay1 = a.cy - a.h / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, bx2 = b.cx + b.w / 2;
    const by1 = b.cy - b.h / 2, by2 = b.cy + b.h / 2;
    if (ax1 >= bx2 || ax2 <= bx1 || ay1 >= by2 || ay2 <= by1) return null;
    return {
      ox: Math.min(ax2 - bx1, bx2 - ax1),
      oy: Math.min(ay2 - by1, by2 - ay1),
    };
  }

  // --- Zoom-aware force parameters ---
  const t = Math.min(1, Math.max(0, (zoom - 15) / 4)); // 0 at z15, 1 at z19
  const PUSH_ONU  = 0.52 - t * 0.20;   // 0.52 → 0.32
  const PUSH_OBS  = 0.70 - t * 0.25;   // 0.70 → 0.45
  const MAX_DISP  = 120  - t * 70;      // 120  → 50
  const ITERS     = Math.round(15 - t * 7); // 15 → 8

  // Phase 1: Pure separation — push overlapping tooltips apart (NO anchor pull)
  for (let iter = 0; iter < ITERS; iter++) {
    // ONU vs ONU
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const ov = overlap(items[i], items[j]);
        if (!ov) continue;
        if (ov.ox < ov.oy) {
          const d = (items[i].cx < items[j].cx ? -1 : 1) * ov.ox * PUSH_ONU;
          items[i].cx += d; items[j].cx -= d;
        } else {
          const d = (items[i].cy < items[j].cy ? -1 : 1) * ov.oy * PUSH_ONU;
          items[i].cy += d; items[j].cy -= d;
        }
      }
    }
    // ONU vs fixed FOB/OLT
    for (const it of items) {
      for (const obs of fixed) {
        const ov = overlap(it, obs);
        if (!ov) continue;
        if (ov.ox < ov.oy) {
          it.cx += (it.cx < obs.cx ? -1 : 1) * ov.ox * PUSH_OBS;
        } else {
          it.cy += (it.cy < obs.cy ? -1 : 1) * ov.oy * PUSH_OBS;
        }
      }
    }
  }

  // Phase 2: One-time gentle anchor pull + cap displacement
  const ANCHOR = 0.15 + t * 0.10; // 0.15 at z16, 0.25 at z19
  for (const it of items) {
    it.cx += (it.ax - it.cx) * ANCHOR;
    it.cy += (it.ay + 5 + ONU_H / 2 - it.cy) * ANCHOR;
    // Cap max displacement
    const dx = it.cx - it.ax;
    const dy = it.cy - (it.ay + 5 + ONU_H / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > MAX_DISP) {
      const scale = MAX_DISP / d;
      it.cx = it.ax + dx * scale;
      it.cy = (it.ay + 5 + ONU_H / 2) + dy * scale;
    }
  }

  // --- Apply: rebind tooltips + draw leader lines ---
  for (const it of items) {
    const n = it.node;
    const offX = Math.round(it.cx - it.ax);
    const offY = Math.round(it.cy - ONU_H / 2 - it.ay);
    const dist = Math.sqrt(offX * offX + offY * offY);
    const moved = dist > 15;

    let dir;
    if (Math.abs(offX) > Math.abs(offY)) {
      dir = offX > 0 ? "right" : "left";
    } else {
      dir = offY > 0 ? "bottom" : "top";
    }

    n._tooltipDir = dir;
    n._tooltipOffset = [offX, offY];
    n._hasLeader = moved;

    // Leader line
    if (moved) {
      const tp = L.point(it.ax + offX, it.ay + offY);
      const mLL = map.containerPointToLatLng(L.point(it.ax, it.ay));
      const tLL = map.containerPointToLatLng(tp);
      const line = L.polyline([mLL, tLL], {
        weight: 1.5, color: "#ffffffbb", dashArray: "6,4",
        interactive: false, className: "onu-leader-line", pmIgnore: true,
      }).addTo(map);
      onuLeaderLines.push(line);
    }
  }
}

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
        const color = ["#ff4444", "#3fb950", "#58a6ff", "#f0883e"][i % 4];
        t += `PON ${i + 1} ➔ ${targetNodes}: <span style='color:${color}'>${activeCores.length} жил(и) підключено</span><br>`;
      }
    }
    return t;
  } else if (n.type === "FOB") {
    let t = `<strong style='color:#c084fc'>${n.name}</strong><br>`;
    if (n.inputConn) {
      const si = sigIn(n);
      t += `📥 IN: <span style='color:${sigClass(si) === "ok" ? "#3fb950" : sigClass(si) === "warn" ? "#d29922" : "#f85149"}'>${si.toFixed(2)} дБ</span><br>`;
      let branchTag = "";
      if (n.inputConn.branch) branchTag = ` (гілка ${n.inputConn.branch})`;
      else if (n.inputConn.from.type === "FOB" && n.inputConn.from.plcType) branchTag = ` (через PLC)`;
      let capStr = n.inputConn.capacity ? ` (${n.inputConn.capacity} жил)` : "";
      t += `📡 Від: ${n.inputConn.from.name || n.inputConn.from.type}${capStr}${branchTag}<br>`;
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
    t += `🔌 Виходи:<br>`;
    pi.rich.forEach((pp) => (t += `${pp}<br>`));
    return t;
  } else if (n.type === "ONU") {
    const s = sigAtONU(n);
    const conn = conns.find((c) => c.to === n && c.type === "patchcord");
    let t = `<strong style='color:#4ade80'>${n.name}</strong><br>`;
    if (s !== null) {
      t += `📶 Сигнал: <span style='color:${sigClass(s) === "ok" ? "#3fb950" : sigClass(s) === "warn" ? "#d29922" : "#f85149"}'>${s.toFixed(2)} дБ</span><br>`;
      if (conn?.from) t += `📦 FOB: ${conn.from.name}<br>`;
      
      let xcTag = false;
      if (conn?.from?.crossConnects) {
         const xc = conn.from.crossConnects.find(x => x.toType === "CABLE" && x.toId === conn.id);
         if (xc) {
            if (xc.fromType === "SPLITTER") {
               let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
               let port = xc.fromCore !== undefined ? xc.fromCore + 1 : xc.fromBranch;
               t += `🔗 Від: ${spName} (Вихід ${port})<br>`;
               xcTag = true;
            } else if (xc.fromType === "CABLE") {
               let inConn = conns.find(c => c.id === xc.fromId);
               let srcName = inConn ? inConn.from.name : "?";
               let srcCap = inConn && inConn.capacity ? ` з ${inConn.capacity}` : "";
               t += `🔗 Транзит: ${srcName} (Жила ${(xc.fromCore || 0) + 1}${srcCap})<br>`;
               xcTag = true;
            }
         }
      }
    } else {
      t += `⚠️ Не підключений (немає кросування)`;
    }
    return t;
  } else if (n.type === "MDU") {
    const s = sigAtONU(n);
    const conn = conns.find((c) => c.to === n && c.type === "patchcord");
    let t = `<strong style='color:#a371f7'>${n.name}</strong><br>`;
    if (s !== null) {
      t += `📶 Сигнал: <span style='color:${sigClass(s) === "ok" ? "#3fb950" : sigClass(s) === "warn" ? "#d29922" : "#f85149"}'>${s.toFixed(2)} дБ</span><br>`;
      if (conn?.from) t += `📦 FOB: ${conn.from.name}<br>`;
      
      let xcTag = false;
      if (conn?.from?.crossConnects) {
         const xc = conn.from.crossConnects.find(x => x.toType === "CABLE" && x.toId === conn.id);
         if (xc) {
            if (xc.fromType === "SPLITTER") {
               let spName = xc.fromId === "legacy_plc" ? "PLC" : (xc.fromId === "legacy_fbt" ? "FBT" : "Сплітер");
               let port = xc.fromCore !== undefined ? xc.fromCore : xc.fromBranch;
               t += `🔀 Від: ${spName} (Вихід ${port})<br>`;
               xcTag = true;
            } else if (xc.fromType === "CABLE") {
               let inConn = conns.find(c => c.id === xc.fromId);
               let srcName = inConn ? inConn.from.name : "?";
               t += `🔀 Транзит: ${srcName} (Жила ${(xc.fromCore || 0) + 1})<br>`;
               xcTag = true;
            }
         }
      }
    } else {
      t += `⚠️ Не підключений (немає кросування)`;
    }
    return t;
  }
  return "";
}

/** @param {any} n */
function showProps(n) {
  const p = document.getElementById("props");
  if (!p) return;
  if (!n) {
    p.innerHTML =
      '<div style="padding:40px;text-align:center;color:#d5dce5">👆 Оберіть елемент</div>';
    return;
  }

  let h = `<div class="node-card"><h3>${n.type === "OLT" ? "🔷" : n.type === "FOB" ? "📦" : "🏠"} ${n.name}</h3>`;

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
    h += `<div style="margin-bottom:6px">Портів: <input type="number" value="${n.ports}" min="1" max="16" style="width:55px" onchange="updNode('${n.id}','ports', parseInt(this.value))"></div>`;
    h += `<div style="margin-bottom:8px">Макс ONU/порт: <input type="number" value="${n.maxOnuPerPort || 64}" min="1" max="128" style="width:55px" onchange="updNode('${n.id}','maxOnuPerPort', parseInt(this.value))"></div>`;

    // Port usage stats (bars per port)
    for (let i = 0; i < n.ports; i++) {
      const c = cntONUport(n, i);
      const max = n.maxOnuPerPort || 64;
      const pct = Math.round((c / max) * 100);
      const barColor =
        c > max ? "#f85149" : c > max * 0.75 ? "#d29922" : "#3fb950";
      h += `<div style="font-size:11px;margin-top:3px">
        <span style="color:#8b949e">Порт ${i + 1}:</span> ${c}/${max} ONU
        <div style="height:3px;background:#21262d;border-radius:2px;margin-top:2px">
          <div style="height:3px;width:${Math.min(pct, 100)}%;background:${barColor};border-radius:2px"></div>
        </div>
      </div>`;
    }

    h += `<button class="btn" style="margin-top:15px;width:100%;border-color:#58a6ff" onclick="window.openPatchPanel('${n.id}')">🎛️ Оптичний крос (ODF)</button>`;
  } else if (n.type === "FOB") {
    h += `<div>FBT: <select onchange="updNode('${n.id}','fbtType',this.value)"><option value="">--</option>${Object.keys(
      FBT_LOSSES,
    )
      .map(
        (k) =>
          `<option value="${k}" ${n.fbtType === k ? "selected" : ""}>${k}</option>`,
      )
      .join("")}</select></div>`;
    h += `<div>PLC: <select onchange="updNode('${n.id}','plcType',this.value)"><option value="">--</option>${Object.keys(
      PLC_LOSSES,
    )
      .map(
        (k) =>
          `<option value="${k}" ${n.plcType === k ? "selected" : ""}>${k}</option>`,
      )
      .join("")}</select></div>`;
    if (n.fbtType && n.plcType) {
      h += `<div>Гілка PLC: <select onchange="updNode('${n.id}','plcBranch',this.value)"><option value="X" ${n.plcBranch === "X" ? "selected" : ""}>X</option><option value="Y" ${n.plcBranch !== "X" ? "selected" : ""}>Y</option></select></div>`;
    }

    h += `<button class="btn" style="margin-top:15px;width:100%;border-color:#c084fc" onclick="window.openCrossConnect('${n.id}')">🪛 Касета (Зварювання)</button>`;

    if (n.inputConn) {
      const dist = connKm(n.inputConn) * 1000;
      const loss = (dist / 1000) * FIBER_DB_KM;
      const s = sigIn(n);
      h += `<div class="info-pill" style="margin-top:10px">Input <br> ${dist.toFixed(0)}м (${loss.toFixed(2)}дБ)<br>Sig: `;
      if (s !== null) {
        h += `<b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
      } else {
        h += `<b>---</b></div>`;
      }
      
      let fromInfo = n.inputConn.from.name || n.inputConn.from.type;
      if (n.inputConn.branch) fromInfo += ` (гілка ${n.inputConn.branch})`;
      else if (n.inputConn.from.type === "FOB" && n.inputConn.from.plcType) fromInfo += ` (через PLC)`;
      
      h += `<div style="font-size:10px;color:#8b949e;margin-top:4px;">Від: ${fromInfo}</div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено</div>`;
    }

    const fC = freeCablePorts(n);
    const fP = freePatchPorts(n);

    // We now use pure optical tracing, no legacy branch dropdowns
    const outConns = conns.filter((c) => c.from === n);

    h += `<div style="font-size:10px;margin-top:6px;border-top:1px solid #30363d;padding-top:4px">
      Free Cable: ${fC} <br> Free ONU: ${fP}
    </div>`;
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
    h += `<div class="info-pill" style="margin-top:4px;background:#2d333b">Всього квартир: <b style="color:#58a6ff">${totalAbon}</b></div>`;

    const s = sigAtONU(n);
    if (s !== null) {
      h += `<div class="info-pill" style="margin-top:10px">Оптичний Сигнал: <b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено до PON</div>`;
    }
  }

  h += `<button class="del-btn" style="margin-top:15px" onclick="deleteNodeById('${n.id}')">Видалити</button></div>`;
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
  if (prop === "outputPower") nodes.forEach((x) => updateNodeLabel(x));
  showProps(n);
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

function showOLTPortSel(olt, fob) {
  const p = document.getElementById("props");
  if (!p) return;
  const usedPorts = conns
    .filter((c) => c.from === olt && c.type === "cable")
    .map((c) => ({ port: c.fromPort, to: c.to?.name || "?" }));
  let h = `<div class="node-card"><h3>Порт OLT</h3><div class="port-grid">`;
  for (let i = 0; i < olt.ports; i++) {
    const used = usedPorts.find((u) => u.port === i);
    if (used) {
      h += `<button class="port-btn" disabled title="Зайнятий: ${used.to}" style="opacity:0.4">Порт ${i + 1} 🔒</button>`;
    } else {
      h += `<button class="port-btn" onclick="finishOLT('${olt.id}','${fob.id}',${i})">Порт ${i + 1}</button>`;
    }
  }
  h += `</div><button class="del-btn" onclick="showSelectedProps()">Скасувати</button></div>`;
  p.innerHTML = h;
}

export function finishOLT(oid, fid, port) {
  const o = nodes.find((x) => x.id === oid);
  const f = nodes.find((x) => x.id === fid);
  showProps(null); // hide standard properties
  const color = ["#00d4ff", "#ff69b4", "#ff8c00", "#b4ff00"][port % 4];
  promptCableCapacity(o, f, "cable", color, () => {
    if (typeof window.openPatchPanel === "function") window.openPatchPanel(o.id);
  }, { fromPort: port });
}

function showFOBBranchSel(src, tgt) {
  const p = document.getElementById("props");
  if (!p) return;
  const [x, y] = src.fbtType.split("/");
  const ux = isBranchFull(src, "X");
  const uy = isBranchFull(src, "Y");

  p.innerHTML = `<div class="node-card"><h3>Гілка FBT</h3>
    <button class="port-btn" ${ux ? "disabled" : ""} onclick="finishFBT('${src.id}','${tgt.id}','X')">X (${x}%) ${ux ? "(Full)" : ""}</button>
    <button class="port-btn" ${uy ? "disabled" : ""} onclick="finishFBT('${src.id}','${tgt.id}','Y')">Y (${y}%) ${uy ? "(Full)" : ""}</button>
    <button class="del-btn" onclick="selectNodeById('${src.id}')">Скасувати</button></div>`;
}

export function finishFBT(sid, tid, br) {
  const src = nodes.find((x) => x.id === sid);
  const chainColor = getChainColor(/** @type {FOBNode} */ (src));
  createConnection(src, nodes.find((x) => x.id === tid), "cable", chainColor, {
    branch: br,
  });
}

function showFOBBranchSel_Combo(src, tgt) {
  const p = document.getElementById("props");
  if (!p) return;
  const plcBr = src.plcBranch || "Y";
  const freeBr = plcBr === "X" ? "Y" : "X";

  const plcFull = isBranchFull(src, plcBr);
  const freeFull = isBranchFull(src, freeBr);

  p.innerHTML = `<div class="node-card"><h3>FBT+PLC</h3>
    <button class="port-btn" ${freeFull ? "disabled" : ""} onclick="finishCombo('${src.id}','${tgt.id}','FREE')">FBT гілка ${freeBr} ${freeFull ? "(Full)" : ""}</button>
    <button class="port-btn" ${plcFull ? "disabled" : ""} onclick="finishCombo('${src.id}','${tgt.id}','PLC')">PLC ${src.plcType} (${plcBr}) ${plcFull ? "(Full)" : ""}</button>
    <button class="del-btn" onclick="selectNodeById('${src.id}')">Cancel</button>
  </div>`;
}

export function finishCombo(sid, tid, type) {
  const s = nodes.find((x) => x.id === sid);
  const plcBr = /** @type {any} */ (s).plcBranch || "Y";
  const chainColor = getChainColor(/** @type {FOBNode} */ (s));
  if (type === "FREE") {
    const br = plcBr === "X" ? "Y" : "X";
    createConnection(s, nodes.find((x) => x.id === tid), "cable", chainColor, {
      branch: br,
    });
  } else {
    createConnection(s, nodes.find((x) => x.id === tid), "cable", chainColor, {
      branch: plcBr,
    });
  }
}

export function updateStats() {
  document.getElementById("s-olt").textContent = String(nodes.filter((n) => n.type === "OLT").length);
  document.getElementById("s-fob").textContent = String(nodes.filter((n) => n.type === "FOB").length);
  document.getElementById("s-onu").textContent = String(nodes.filter((n) => n.type === "ONU").length);
  document.getElementById("s-conn").textContent = String(conns.length);
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
  if (typeof updateTooltipsVisibility === "function") updateTooltipsVisibility();
  updateStats();
};

window.updNode = updNode;
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
window.finishFBT = finishFBT;
window.finishCombo = finishCombo;
window.reassignBranch = reassignBranch;