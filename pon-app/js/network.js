// Core map + network logic for modular PON Designer.
// This is a first extracted version: focuses on map init and basic node management.

import {
  FBT_LOSSES,
  PLC_LOSSES,
  MECH,
  ONU_MIN,
  FIBER_DB_KM,
  fobCounter,
  onuCounter,
  setCounters,
  nextFobNumber,
  nextOnuNumber,
  iconOLT,
  iconFOB,
  iconONU,
} from "./config.js";
import { sigClass, sigColorClass } from "./utils.js";

// Global-ish state for the modular app
let map;
let streets;
let satellite;
let hybrid;

export const nodes = [];
export const conns = [];

let tool = "select";
let selNode = null;
let connStart = null;
let pathGlowLayers = [];

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
  map = L.map("map", {
    center: [50.4501, 30.5234],
    zoom: 13,
    zoomControl: false,
  });

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
          if (e.enabled) {
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
    if (!e.target.matches("#btn-layers")) {
      const menu = document.getElementById("layer-menu");
      if (menu && menu.classList.contains("show")) {
        menu.classList.remove("show");
      }
    }
  });

  // Drag & drop from toolbox onto map
  document.querySelectorAll(".tool-btn[draggable]").forEach((btn) => {
    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", btn.dataset.type);
    });
  });
  mapContainer.addEventListener("dragover", (e) => e.preventDefault());
  mapContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/plain");
    if (!["olt", "fob", "onu"].includes(type)) return;
    const rect = mapContainer.getBoundingClientRect();
    const pt = L.point(e.clientX - rect.left, e.clientY - rect.top);
    const latlng = map.containerPointToLatLng(pt);
    addNode(type, latlng);
    selectTool("select");
  });

  // Mini-legend + toolbar (keeps original HTML; relies on window.undo/etc)
  const legendPanel = L.control({ position: "bottomleft" });
  legendPanel.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-legend-panel");
    div.innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:6px">
        <div class="leaflet-legend">
          <div class="legend-title" onclick="this.parentElement.classList.toggle('collapsed')">📋 Легенда ▾</div>
          <div class="legend-body">
            <div><span style="display:inline-block;width:12px;height:12px;background:#58a6ff;border-radius:2px;margin-right:6px;vertical-align:middle"></span>OLT</div>
            <div><span style="display:inline-block;width:12px;height:12px;background:#ff6b6b;border-radius:50%;margin-right:6px;vertical-align:middle"></span>FOB</div>
            <div><span style="display:inline-block;width:10px;height:10px;background:#4ade80;border-radius:2px;margin-right:6px;vertical-align:middle"></span>ONU</div>
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
          <button onclick="openOnboarding()" id="btn-help-pulse" title="Онбординг: основи роботи, типи сплітерів, поради">
            ?
          </button>
        </div>
      </div>`;
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
  if (["olt", "fob", "onu"].includes(tool)) {
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
  }

  n.marker.addTo(map);
  n.marker.nodeRef = n;

  n.marker.on("click", (evt) => onNodeClick(n, evt));
  n.marker.on("drag", () => onNodeDrag(n));
  // Context menu / advanced actions will be wired later

  updateNodeLabel(n);

  nodes.push(n);
  selNode = n;
  showProps(n);
  updateStats();
}

// ═══════════════════════════════════════════════
//  SIGNAL PATH HIGHLIGHTING
// ═══════════════════════════════════════════════

// Trace signal path from node upstream to OLT
function getSignalPath(node) {
  const pathConns = [];
  const pathNodes = [node];
  let current = node;
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    // Find upstream connection (cable INTO this node)
    let upConn = null;
    if (current.type === "ONU") {
      upConn = conns.find((c) => c.to === current && c.type === "patchcord");
    } else if (current.type === "FOB") {
      upConn = current.inputConn;
    }
    if (upConn) {
      pathConns.push(upConn);
      pathNodes.push(upConn.from);
      current = upConn.from;
    } else {
      break;
    }
  }
  return { conns: pathConns, nodes: pathNodes };
}

// Get all downstream connections from a node
function getDownstreamConns(node) {
  const result = [];
  const visited = new Set();
  function walk(n) {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    conns.forEach((c) => {
      if (c.from === n) {
        result.push(c);
        if (c.to) walk(c.to);
      }
    });
  }
  walk(node);
  return result;
}

function highlightSignalPath(node) {
  clearSignalPath();
  let pathConns = [];
  let pathNodes = [];

  if (node.type === "ONU" || node.type === "FOB") {
    const path = getSignalPath(node);
    pathConns = path.conns;
    pathNodes = path.nodes;
  } else if (node.type === "OLT") {
    // For OLT: highlight all downstream
    pathNodes = [node];
    const downstream = getDownstreamConns(node);
    pathConns = downstream;
    downstream.forEach((c) => {
      if (c.to && !pathNodes.includes(c.to)) pathNodes.push(c.to);
    });
  }

  if (pathConns.length === 0) return;

  // Create glow overlay polylines
  pathConns.forEach((c) => {
    if (!c.polyline) return;
    const pts = c.polyline.getLatLngs();
    const glow = L.polyline(pts, {
      color: "#00d4ff",
      weight: 10,
      opacity: 0.4,
      className: "signal-path-glow",
      interactive: false,
      pmIgnore: true,
    }).addTo(map);
    pathGlowLayers.push(glow);
  });

  // Highlight markers
  pathNodes.forEach((n) => {
    if (n.marker && n.marker._icon) {
      n.marker._icon.classList.add("highlighted-marker");
    }
  });
}

function clearSignalPath() {
  pathGlowLayers.forEach((l) => map.removeLayer(l));
  pathGlowLayers = [];
  nodes.forEach((n) => {
    if (n.marker && n.marker._icon) {
      n.marker._icon.classList.remove("highlighted-marker");
    }
  });
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
      const { marker, inputConn, ...rest } = n;
      return rest;
    }),
    conns: conns.map((c) => {
      const { polyline, from, to, _distTooltip, ...rest } = c;
      return {
        ...rest,
        from: from.id,
        to: to.id,
        pts: polyline ? polyline.getLatLngs().map((ll) => [ll.lat, ll.lng]) : null,
      };
    }),
    fobCounter,
    onuCounter,
  });
}

function saveState() {
  if (_restoring) return;
  undoHistory.push(serializeNetwork());
  if (undoHistory.length > MAX_HISTORY) undoHistory.shift();
  redoHistory = [];
}

export function restoreNetwork(json) {
  _restoring = true;
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
  nodes.forEach((n) => map.removeLayer(n.marker));
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
    }
    if (n.type === "FOB") {
      if (typeof n.fbtType !== "string") n.fbtType = "";
      if (typeof n.plcType !== "string") n.plcType = "";
      if (typeof n.plcBranch !== "string") n.plcBranch = "";
      if (!n.name) n.name = "FOB";
    }
    if (n.type === "ONU") {
      if (!n.name) n.name = "ONU";
    }
    if (typeof n.price !== "number") n.price = 0;
    const icon = n.type === "OLT" ? iconOLT : n.type === "ONU" ? iconONU : iconFOB;
    n.marker = L.marker(
      { lat: n.lat, lng: n.lng },
      { icon, draggable: true, pmIgnore: true },
    ).addTo(map);
    n.marker.nodeRef = n;
    n.inputConn = null;
    n.marker.on("click", (e) => onNodeClick(n, e));
    n.marker.on("drag", (e) => onNodeDrag(n, e));
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
        pts: c.pts,
      });
  });

  setCounters({ fobCounter: d.fobCounter || 1, onuCounter: d.onuCounter || 1 });
  selNode = null;
  showProps(null);
  updateStats();
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
  nodes.forEach((n) => map.removeLayer(n.marker));

  nodes.length = 0;
  conns.length = 0;

  setCounters({ fobCounter: 1, onuCounter: 1 });
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
      const latlngs = [
        [c.from.lat, c.from.lng],
        [c.to.lat, c.to.lng],
      ];
      c.polyline.setLatLngs(latlngs);
      // Refresh distance label
      if (c.type === "cable") updateConnLabel(c);
    }
  });
  // Refresh labels (distances changed)
  nodes.forEach((x) => updateNodeLabel(x));
  refreshSignalAnim();
  // Refresh signal path highlight if active
  if (selNode && pathGlowLayers.length > 0) highlightSignalPath(selNode);
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
      showOLTPortSel(from, to);
      return;
    }

    // FOB -> FOB Rules
    const chainColor = getChainColor(from);
    if (!from.fbtType && !from.plcType) {
      if (usedOutputs(from) >= 1) {
        alert(`${from.name} (Транзит) вже має вихід!`);
        return;
      }
      createConnection(from, to, type, chainColor);
      return;
    }
    if (from.plcType && !from.fbtType) {
      const max = parseInt(from.plcType.split("x")[1]);
      if (usedOutputs(from) >= max) {
        alert(`${from.name}: PLC ${from.plcType} повністю зайнятий (${max}/${max})!`);
        return;
      }
      createConnection(from, to, type, chainColor);
      return;
    }
    if (from.fbtType && !from.plcType) {
      showFOBBranchSel(from, to);
      return;
    }
    if (from.fbtType && from.plcType) {
      showFOBBranchSel_Combo(from, to);
      return;
    }
  } else if (type === "patchcord") {
    if (from.type !== "FOB" || to.type !== "ONU") {
      alert("Патчкорд: FOB → ONU");
      return;
    }
    if (!from.plcType && !from.fbtType) {
      alert(`${from.name} (Транзит) — немає сплітера для ONU!`);
      return;
    }

    if (from.plcType && !from.fbtType) {
      const max = parseInt(from.plcType.split("x")[1]);
      if (usedOutputs(from) >= max) {
        alert(`${from.name}: PLC ${from.plcType} повністю зайнятий (${max}/${max})!`);
        return;
      }
      createConnection(from, to, type, "#ffd700");
      return;
    }
    if (from.fbtType && !from.plcType) {
      const usedX = conns.some((c) => c.from === from && c.branch === "X");
      const usedY = conns.some((c) => c.from === from && c.branch === "Y");
      const br = !usedX ? "X" : !usedY ? "Y" : null;
      if (!br) {
        alert(`${from.name}: FBT ${from.fbtType} повністю зайнятий!`);
        return;
      }
      createConnection(from, to, type, "#ffd700", { branch: br });
      return;
    }
    if (from.fbtType && from.plcType) {
      const plcBr = from.plcBranch || "Y";
      const max = parseInt(from.plcType.split("x")[1]);
      const usedOnPLC = conns.filter((c) => c.from === from && c.branch === plcBr).length;
      if (usedOnPLC >= max) {
        alert(`${from.name}: PLC ${from.plcType} (гілка ${plcBr}) повністю зайнятий!`);
        return;
      }
      createConnection(from, to, type, "#ffd700", { branch: plcBr });
      return;
    }
  }
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
    if (selNode && pathGlowLayers.length > 0) highlightSignalPath(selNode);
  });
  polyline.on("pm:markerdragend", () => {
    updateStats();
    if (c.type === "cable") updateConnLabel(c);
    nodes.forEach((x) => updateNodeLabel(x));
    if (selNode === c.to || selNode === c.from) showProps(selNode);
    // Оновити підсвітку магістралі після перетягування вершини
    if (selNode && pathGlowLayers.length > 0) highlightSignalPath(selNode);
  });

  polyline.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    showConnCtx(e, c);
  });
  polyline.on("contextmenu", (e) => {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    showConnCtx(e, c);
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
  c._distTooltip = L.tooltip({
    permanent: true,
    direction: "top",
    className: "conn-dist-label",
    offset: [0, -5],
  })
    .setContent(`${dist.toFixed(1)} м`)
    .setLatLng(midPt)
    .addTo(map);
}

// ═══════════════════════════════════════════════
//  COLOR-CODED CABLES
// ═══════════════════════════════════════════════
function getSignalColor(sig) {
  if (sig === 0 || sig === null || sig === undefined) return "#6b7280";
  if (sig >= ONU_MIN) return "#3fb950";
  if (sig >= ONU_MIN - 3) return "#d29922";
  return "#f85149";
}

function updateCableColors() {
  conns.forEach((c) => {
    if (!c.polyline) return;
    let sig = null;
    if (c.type === "cable" && c.to?.type === "FOB" && c.to.inputConn && hasOLTPath(c.to)) {
      sig = sigIn(c.to);
    } else if (c.type === "patchcord" && c.to?.type === "ONU" && c.from && hasOLTPath(c.from)) {
      sig = sigAtONU(c.to);
    }
    if (sig !== null) {
      const glowColor = getSignalColor(sig);
      c.polyline.getElement()?.style?.setProperty("filter", `drop-shadow(0 0 4px ${glowColor})`);
    } else {
      c.polyline.getElement()?.style?.setProperty("filter", "none");
    }
  });
}

// ═══════════════════════════════════════════════
//  SIGNAL ANIMATION
// ═══════════════════════════════════════════════
let signalAnimLayers = [];
let signalAnimActive = false;

export function toggleSignalAnim() {
  signalAnimActive = !signalAnimActive;
  const btn = document.getElementById("btn-anim");
  if (btn) btn.classList.toggle("active", signalAnimActive);
  if (signalAnimActive) createSignalAnimOverlays();
  else removeSignalAnimOverlays();
}

function createSignalAnimOverlays() {
  removeSignalAnimOverlays();
  conns.forEach((c) => {
    if (!c.polyline) return;
    const pts = c.polyline.getLatLngs();
    const overlay = L.polyline(pts, {
      color: "#ffffff",
      weight: 2,
      opacity: 0.7,
      dashArray: "6, 18",
      className: "signal-anim-overlay",
      interactive: false,
      pmIgnore: true,
    }).addTo(map);
    signalAnimLayers.push(overlay);
  });
}

function removeSignalAnimOverlays() {
  signalAnimLayers.forEach((l) => map.removeLayer(l));
  signalAnimLayers = [];
}

function refreshSignalAnim() {
  if (signalAnimActive) createSignalAnimOverlays();
}

// ═══════════════════════════════════════════════
//  P O N   L O G I C (helpers used by connection rules & labels)
// ═══════════════════════════════════════════════

function getChainColor(fob) {
  let node = fob;
  while (node && node.type === "FOB" && node.inputConn) {
    const c = node.inputConn;
    if (c.from.type === "OLT" && c.color) return c.color;
    if (c.color && c.from.type === "OLT") return c.color;
    node = c.from;
  }
  return "#e0e0e0";
}

function usedCables(fob) {
  return conns.filter((c) => c.from === fob && c.type === "cable").length;
}
function usedPatches(fob) {
  return conns.filter((c) => c.from === fob && c.type === "patchcord").length;
}
function usedOutputs(fob) {
  return usedCables(fob) + usedPatches(fob);
}

function maxOutputs(fob) {
  if (!fob.plcType && !fob.fbtType) return 1;
  if (fob.plcType && !fob.fbtType) return parseInt(fob.plcType.split("x")[1]);
  if (fob.fbtType && !fob.plcType) return 2;
  if (fob.fbtType && fob.plcType) return 1 + parseInt(fob.plcType.split("x")[1]);
  return 1;
}

function freeCablePorts(fob) {
  if (!fob.plcType && !fob.fbtType) return usedCables(fob) === 0 ? 1 : 0;
  if (fob.plcType && !fob.fbtType) {
    const max = parseInt(fob.plcType.split("x")[1]);
    return Math.max(0, max - usedOutputs(fob));
  }
  if (fob.fbtType && !fob.plcType) {
    const x = conns.some((c) => c.from === fob && c.branch === "X");
    const y = conns.some((c) => c.from === fob && c.branch === "Y");
    return (x ? 0 : 1) + (y ? 0 : 1);
  }
  if (fob.fbtType && fob.plcType) {
    let free = 0;
    const freeBr = fob.plcBranch === "X" ? "Y" : "X";
    if (!conns.some((c) => c.from === fob && c.branch === freeBr)) free++;

    const maxPLC = parseInt(fob.plcType.split("x")[1]);
    const plcBr = fob.plcBranch || "Y";
    const usedOnPLC = conns.filter((c) => c.from === fob && c.branch === plcBr).length;
    free += Math.max(0, maxPLC - usedOnPLC);
    return free;
  }
  return 0;
}

function freePatchPorts(fob) {
  if (!fob.plcType && !fob.fbtType) return 0;
  if (fob.plcType && !fob.fbtType)
    return Math.max(0, parseInt(fob.plcType.split("x")[1]) - usedOutputs(fob));
  if (fob.fbtType && !fob.plcType) {
    const x = conns.some((c) => c.from === fob && c.branch === "X");
    const y = conns.some((c) => c.from === fob && c.branch === "Y");
    return (x ? 0 : 1) + (y ? 0 : 1);
  }
  if (fob.fbtType && fob.plcType) {
    const max = parseInt(fob.plcType.split("x")[1]);
    const plcBr = fob.plcBranch || "Y";
    return Math.max(0, max - conns.filter((c) => c.from === fob && c.branch === plcBr).length);
  }
  return 0;
}

// Unified FOB port status for tooltip & popup
function fobPortStatus(n) {
  const lines = [];
  const rich = [];

  if (!n.fbtType && !n.plcType) {
    const used = usedOutputs(n);
    const clr = used === 0 ? "#3fb950" : "#f85149";
    lines.push(`<span style="color:#f97316">⇄ ${used}/1</span>`);
    rich.push(`📦 Транзит: <span style="color:${clr}">${used}/1</span>`);
  }

  if (n.fbtType && !n.plcType) {
    const xUsed = conns.filter((c) => c.from === n && c.branch === "X").length;
    const yUsed = conns.filter((c) => c.from === n && c.branch === "Y").length;
    const total = xUsed + yUsed;
    const xClr = xUsed ? "#f85149" : "#3fb950";
    const yClr = yUsed ? "#f85149" : "#3fb950";
    lines.push(
      `<span style="color:#ff6b6b">FBT ${n.fbtType}: <span style="color:${xClr}">X:${xUsed}/1</span> <span style="color:${yClr}">Y:${yUsed}/1</span></span>`,
    );
    rich.push(
      `🔀 FBT ${n.fbtType}: <span style="color:${xClr}">X=${xUsed ? "зайн." : "вільн."}</span> <span style="color:${yClr}">Y=${yUsed ? "зайн." : "вільн."}</span> (${total}/2)`,
    );
  }

  if (!n.fbtType && n.plcType) {
    const plcMax = parseInt(n.plcType.split("x")[1]);
    const plcUsed = usedOutputs(n);
    const plcFree = plcMax - plcUsed;
    const clr = plcFree > 0 ? "#3fb950" : "#f85149";
    lines.push(
      `<span style="color:#c084fc">PLC ${n.plcType}: <span style="color:${clr}">${plcUsed}/${plcMax}</span></span>`,
    );
    rich.push(
      `📊 PLC ${n.plcType}: ${plcUsed}/${plcMax} (<span style="color:${clr}">вільно: ${plcFree}</span>)`,
    );
  }

  if (n.fbtType && n.plcType) {
    const plcBr = n.plcBranch || "Y";
    const freeBr = plcBr === "X" ? "Y" : "X";
    const freeBrUsed = conns.some((c) => c.from === n && c.branch === freeBr);
    const fbtClr = freeBrUsed ? "#f85149" : "#3fb950";

    const plcMax = parseInt(n.plcType.split("x")[1]);
    const plcUsed = conns.filter((c) => c.from === n && c.branch === plcBr).length;
    const plcFree = plcMax - plcUsed;
    const plcClr = plcFree > 0 ? "#3fb950" : "#f85149";

    lines.push(
      `<span style="color:#ff6b6b">FBT ${freeBr}:<span style="color:${fbtClr}">${freeBrUsed ? "1/1" : "0/1"}</span></span>`,
    );
    lines.push(
      `<span style="color:#c084fc">PLC ${n.plcType}: <span style="color:${plcClr}">${plcUsed}/${plcMax}</span></span>`,
    );
    rich.push(
      `🔀 FBT ${n.fbtType}: гілка ${freeBr} = <span style="color:${fbtClr}">${freeBrUsed ? "зайнята" : "вільна"}</span>`,
    );
    rich.push(
      `📊 PLC ${n.plcType}: ${plcUsed}/${plcMax} (<span style="color:${plcClr}">вільно: ${plcFree}</span>)`,
    );
  }

  return { lines, rich };
}

function getDistM(n1, n2) {
  return map.distance(L.latLng(n1.lat, n1.lng), L.latLng(n2.lat, n2.lng));
}

export function connKm(c) {
  if (!c.polyline) return getDistM(c.from, c.to) / 1000.0;
  let dist = 0;
  const pts = c.polyline.getLatLngs();
  const flatPts =
    (L.LineUtil.isFlat && L.LineUtil.isFlat(pts)) ||
    (pts.length > 0 && typeof pts[0].lat === "number")
      ? pts
      : pts[0];
  if (!flatPts || flatPts.length < 2) return getDistM(c.from, c.to) / 1000.0;
  for (let i = 0; i < flatPts.length - 1; i++) {
    dist += map.distance(flatPts[i], flatPts[i + 1]);
  }
  return dist / 1000.0;
}

export function sigIn(fob) {
  if (!fob.inputConn) return 0;
  const c = fob.inputConn;
  const cLoss = connKm(c) * FIBER_DB_KM;
  if (c.from.type === "OLT") return c.from.outputPower - cLoss - MECH;
  if (c.from.type === "FOB") return sigOnOutput(c.from, c) - cLoss - MECH;
  return 0;
}

function sigOnOutput(fob, conn) {
  const base = sigIn(fob);
  if (fob.fbtType && fob.plcType) {
    if (conn.type === "patchcord") {
      const brLoss = fob.plcBranch === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y;
      return base - brLoss - MECH - PLC_LOSSES[fob.plcType] - MECH;
    } else {
      const br = conn.branch || (fob.plcBranch === "X" ? "Y" : "X");
      const brLoss = br === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y;
      if (br === fob.plcBranch) {
        return base - brLoss - MECH - PLC_LOSSES[fob.plcType] - MECH;
      }
      return base - brLoss - MECH;
    }
  }
  if (fob.fbtType && !fob.plcType) {
    const br = conn.branch;
    if (!br) return base;
    return base - (br === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y) - MECH;
  }
  if (!fob.fbtType && fob.plcType) return base - PLC_LOSSES[fob.plcType] - MECH;
  return base;
}

export function hasOLTPath(fob) {
  if (!fob || !fob.inputConn) return false;
  if (fob.inputConn.from.type === "OLT") return true;
  if (fob.inputConn.from.type === "FOB") return hasOLTPath(fob.inputConn.from);
  return false;
}

function sigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return 0;
  if (!hasOLTPath(c.from)) return 0;
  const fobOut = sigOnOutput(c.from, c);
  const patchLoss = connKm(c) * FIBER_DB_KM;
  return fobOut - patchLoss;
}

function sigFBT(fob, branch) {
  const base = sigIn(fob);
  if (!fob.fbtType) return base;
  return (
    base -
    (branch === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y) -
    MECH
  );
}

export function sigONU(fob) {
  if (fob.fbtType && fob.plcType) {
    const bLoss =
      fob.plcBranch === "X"
        ? FBT_LOSSES[fob.fbtType].x
        : FBT_LOSSES[fob.fbtType].y;
    return sigIn(fob) - bLoss - MECH - PLC_LOSSES[fob.plcType] - MECH;
  }
  if (fob.fbtType) return sigIn(fob);
  if (fob.plcType) return sigIn(fob) - PLC_LOSSES[fob.plcType] - MECH;
  return sigIn(fob);
}

export function cntONUport(olt, port) {
  return conns
    .filter((c) => c.from === olt && c.fromPort === port)
    .reduce((a, c) => a + cntDn(c.to), 0);
}

function cntDn(n) {
  if (n.type === "ONU") return 1;
  if (n.type === "FOB") {
    const d = conns.filter((c) => c.from === n && c.type === "patchcord").length;
    const sub = conns
      .filter((c) => c.from === n && c.type === "cable")
      .reduce((a, c) => a + cntDn(c.to), 0);
    return d + sub;
  }
  return 0;
}

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
  const ll = n.marker.getLatLng();
  n.lat = ll.lat;
  n.lng = ll.lng;
  updateConnections(n);
  if (selNode === n) showProps(n);
}

function updateNodeLabel(n) {
  let L1 = "";
  let L2 = "";

  if (n.type === "OLT") {
    L1 = `<span class="lbl-name lbl-olt">${n.name}</span>`;
    L2 = `<span class="lbl-dim">${n.outputPower} дБ</span>`;
    // Per-port ONU stats
    const portInfo = [];
    for (let i = 0; i < n.ports; i++) {
      const c = cntONUport(n, i);
      if (c > 0) portInfo.push(`P${i + 1}: ${c}`);
    }
    if (portInfo.length)
      L2 += `<br><span class="lbl-dim">${portInfo.join(" | ")}</span>`;
  } else if (n.type === "FOB") {
    L1 = `<span class="lbl-name lbl-fob">${n.name}</span>`;

    // Input signal
    if (n.inputConn) {
      const si = sigIn(n);
      L2 = `<span class="lbl-dim">IN:</span><span class="lbl-sig ${sigColorClass(si)}">${si.toFixed(1)}дБ</span>`;
    }

    // Port status
    const pi = fobPortStatus(n);
    pi.lines.forEach((l) => (L2 += `<br>${l}`));

    // FBT branch signals
    if (n.fbtType && n.inputConn) {
      const sx = sigFBT(n, "X");
      const sy = sigFBT(n, "Y");
      L2 += `<br><span class="${sigColorClass(sx)}">X:${sx.toFixed(1)}дБ</span>`;
      L2 += ` <span class="${sigColorClass(sy)}">Y:${sy.toFixed(1)}дБ</span>`;
    }

    // PLC ONU signal
    if (n.plcType && n.inputConn) {
      const so = sigONU(n);
      L2 += `<br><span class="${sigColorClass(so)}">→ONU:${so.toFixed(1)}дБ</span>`;
    }

    // Transit indicator
    if (!n.fbtType && !n.plcType) {
      L2 += `<br><span class="lbl-transit">→ транзит</span>`;
    }
  } else if (n.type === "ONU") {
    L1 = `<span class="lbl-name lbl-onu">${n.name}</span>`;
    const s = sigAtONU(n);
    const conn = conns.find((x) => x.to === n && x.type === "patchcord");
    if (s !== 0) {
      L2 = `<span class="lbl-sig ${sigColorClass(s)}">${s.toFixed(1)}дБ</span>`;
      if (conn && conn.from) {
        let tag = "";
        if (conn.branch) tag += `[${conn.branch}]`;
        if (conn.from.plcType) tag += conn.from.plcType;
        else if (conn.from.fbtType) tag += conn.from.fbtType;
        if (tag) L2 += ` <span class="lbl-dim">${tag}</span>`;
      }
    }
  }

  const content = L1 + (L2 ? "<br>" + L2 : "");

  n.marker.unbindTooltip();
  n.marker.bindTooltip(content, {
    permanent: true,
    direction: "bottom",
    className: "node-label",
    offset: [0, 5],
  });

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

// updateStats() is defined below (ported from monolith)

/**
 * Fit map view to all nodes (basic implementation).
 */
export function fitNetwork() {
  if (!map || nodes.length === 0) return;
  const group = L.featureGroup(nodes.map((n) => n.marker));
  map.fitBounds(group.getBounds().pad(0.2));
}

// ═══════════════════════════════════════════════
//  UI HELPERS (tooltips, props, ctx, selectors)
// ═══════════════════════════════════════════════

function buildTooltip(n) {
  if (n.type === "OLT") {
    let t = `<strong style='color:#58a6ff'>${n.name}</strong><br>`;
    t += `⚡ Потужність: ${n.outputPower} дБ<br>`;
    for (let i = 0; i < n.ports; i++) {
      const c = cntONUport(n, i);
      if (c > 0)
        t += `P${i + 1}: <span style='color:${["#ff4444", "#3fb950", "#58a6ff", "#f0883e"][i % 4]}'>${c} ONU${c > (n.maxOnuPerPort || 64) ? " ⚠" : ""}</span><br>`;
    }
    return t;
  } else if (n.type === "FOB") {
    let t = `<strong style='color:#c084fc'>${n.name}</strong><br>`;
    if (n.inputConn) {
      const si = sigIn(n);
      t += `📥 IN: <span style='color:${sigClass(si) === "ok" ? "#3fb950" : sigClass(si) === "warn" ? "#d29922" : "#f85149"}'>${si.toFixed(2)} дБ</span><br>`;
      t += `📡 Від: ${n.inputConn.from.name || n.inputConn.from.type}<br>`;
    } else {
      t += `⚠️ Не підключений (Input)<br>`;
    }
    if (n.fbtType) t += `🔀 FBT: ${n.fbtType}<br>`;
    if (n.plcType) {
      t += `📊 PLC: ${n.plcType}<br>`;
      if (n.inputConn) {
        const so = sigONU(n);
        t += `→ONU: <span style='color:${sigClass(so) === "ok" ? "#3fb950" : sigClass(so) === "warn" ? "#d29922" : "#f85149"}'>${so.toFixed(2)} дБ</span><br>`;
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
    if (s !== 0) {
      t += `📶 Сигнал: <span style='color:${sigClass(s) === "ok" ? "#3fb950" : sigClass(s) === "warn" ? "#d29922" : "#f85149"}'>${s.toFixed(2)} дБ</span><br>`;
      if (conn?.from) t += `📦 FOB: ${conn.from.name}<br>`;
      if (conn?.branch) t += `🔀 Гілка: ${conn.branch}<br>`;
      if (conn?.from?.plcType) t += `📊 PLC: ${conn.from.plcType}`;
    } else {
      t += `⚠️ Не підключений`;
    }
    return t;
  }
  return "";
}

function showProps(n) {
  const p = document.getElementById("props");
  if (!p) return;
  if (!n) {
    p.innerHTML =
      '<div style="padding:40px;text-align:center;color:#666">👆 Оберіть елемент</div>';
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

    if (n.inputConn) {
      const dist = connKm(n.inputConn) * 1000;
      const loss = (dist / 1000) * FIBER_DB_KM;
      const s = sigIn(n);
      h += `<div class="info-pill" style="margin-top:10px">Input <br> ${dist.toFixed(0)}м (${loss.toFixed(2)}дБ)<br>Sig: <b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
      h += `<div style="font-size:10px;color:#8b949e">From: ${n.inputConn.from.name}</div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено</div>`;
    }

    const fC = freeCablePorts(n);
    const fP = freePatchPorts(n);

    // Branch reassignment UI (per-connection branch chooser)
    const outConns = conns.filter((c) => c.from === n);
    if (n.fbtType && outConns.length > 0) {
      h += `<div style="margin-top:8px;border-top:1px solid #30363d;padding-top:6px">`;
      h += `<div style="font-size:10px;color:#8b949e;margin-bottom:4px">🔌 Підключення (гілки):</div>`;
      outConns.forEach((c) => {
        const target = c.to ? c.to.name : "?";
        const typeIcon = c.type === "cable" ? "━" : "╌";
        const typeLabel = c.type === "cable" ? "каб" : "патч";

        let options = "";
        if (n.fbtType && n.plcType) {
          const plcBr = n.plcBranch || "Y";
          const freeBr = plcBr === "X" ? "Y" : "X";
          const plcFull = isBranchFull(n, plcBr) && c.branch !== plcBr;
          const freeFull = isBranchFull(n, freeBr) && c.branch !== freeBr;

          options = `<option value="${plcBr}" ${c.branch === plcBr ? "selected" : ""} ${plcFull ? "disabled" : ""}>PLC (${plcBr}) ${plcFull ? "(Full)" : ""}</option>
                     <option value="${freeBr}" ${c.branch === freeBr ? "selected" : ""} ${freeFull ? "disabled" : ""}>FBT (${freeBr}) ${freeFull ? "(Full)" : ""}</option>`;
        } else if (n.fbtType) {
          const xFull = isBranchFull(n, "X") && c.branch !== "X";
          const yFull = isBranchFull(n, "Y") && c.branch !== "Y";
          options = `<option value="X" ${c.branch === "X" ? "selected" : ""} ${xFull ? "disabled" : ""}>X ${xFull ? "(Full)" : ""}</option>
                     <option value="Y" ${c.branch === "Y" ? "selected" : ""} ${yFull ? "disabled" : ""}>Y ${yFull ? "(Full)" : ""}</option>`;
        }

        h += `<div style="display:flex;align-items:center;gap:4px;font-size:11px;margin-bottom:3px">
          <span style="color:#58a6ff">${typeIcon}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${typeLabel} → ${target}">${target}</span>
          <select style="width:95px;font-size:10px" onchange="reassignBranch('${c.id}',this.value)">${options}</select>
        </div>`;
      });
      h += `</div>`;
    }

    h += `<div style="font-size:10px;margin-top:6px;border-top:1px solid #30363d;padding-top:4px">
      Free Cable: ${fC} <br> Free ONU: ${fP}
    </div>`;
  } else if (n.type === "ONU") {
    const s = sigAtONU(n);
    if (s !== 0) {
      h += `<div class="info-pill" style="margin-top:10px">Сигнал: <b class="${sigClass(s)}">${s.toFixed(2)} дБ</b></div>`;
    } else {
      h += `<div class="warn-pill" style="margin-top:10px">Не підключено</div>`;
    }
  }

  h += `<button class="del-btn" style="margin-top:15px" onclick="deleteNodeById('${n.id}')">Видалити</button></div>`;
  p.innerHTML = h;
}

function updNode(id, prop, val) {
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
  map.removeLayer(n.marker);
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
  createConnection(o, f, "cable", "#888", {
    fromPort: port,
    color: ["#00d4ff", "#ff69b4", "#ff8c00", "#b4ff00"][port % 4],
  });
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
  const chainColor = getChainColor(src);
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
  const plcBr = s.plcBranch || "Y";
  const chainColor = getChainColor(s);
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
  document.getElementById("s-olt").textContent = nodes.filter((n) => n.type === "OLT").length;
  document.getElementById("s-fob").textContent = nodes.filter((n) => n.type === "FOB").length;
  document.getElementById("s-onu").textContent = nodes.filter((n) => n.type === "ONU").length;
  document.getElementById("s-conn").textContent = conns.length;
  updateCableColors();
  refreshSignalAnim();
}

// Expose internal functions for inline HTML handlers
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

