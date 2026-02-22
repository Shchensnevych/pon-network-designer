// @ts-check
// Signal path highlighting & signal animation overlays.
// Extracted from network.js — pure visualization, no business logic.
import { nodes, conns, map } from "./state.js";
import { traceOpticalPath, hasOLTPath } from "./signal.js";

// ═══════════════════════════════════════════════
//  SIGNAL PATH HIGHLIGHTING
// ═══════════════════════════════════════════════

/** @type {import('leaflet').Polyline[]} */
let pathGlowLayers = [];

/** Check whether a signal-path glow is currently active. */
export function hasActiveGlow() {
  return pathGlowLayers.length > 0;
}

/**
 * Trace signal path from node upstream to OLT.
 * @param {PONNode} node
 * @returns {{ conns: PONConnection[], nodes: PONNode[] }}
 */
function getSignalPath(node) {
  /** @type {PONConnection[]} */
  const pathConns = [];
  /** @type {PONNode[]} */
  const pathNodes = [node];
  let current = node;
  /** @type {Set<string>} */
  const visited = new Set();
  
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    /** @type {PONConnection | undefined} */
    let upConn = undefined;
    
    if (current.type === "ONU" || current.type === "MDU") {
      upConn = conns.find((c) => c.to === current && c.type === "patchcord");
    } else if (current.type === "FOB") {
      // Find the active incoming cable based on cross connect traces instead of legacy inputConn
      const inConns = conns.filter(c => c.to === current && c.type === "cable");
      
      // Let's use the old inputConn loosely if it exists, or just find any upstream cable
      upConn = current.inputConn || inConns.find(c => c.from.type !== "FOB" || c.from.inputConn || hasOLTPath(c.from));
      if (!upConn && inConns.length > 0) upConn = inConns[0];
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

/**
 * Get all downstream connections from a node.
 * @param {PONNode} node
 * @returns {PONConnection[]}
 */
function getDownstreamConns(node) {
  /** @type {PONConnection[]} */
  const result = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {PONNode} n */
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

/**
 * Highlight signal path for a node (glow overlay on cables).
 * @param {PONNode} node
 */
export function highlightSignalPath(node) {
  clearSignalPath();
  /** @type {PONConnection[]} */
  let pathConns = [];
  /** @type {PONNode[]} */
  let pathNodes = [];

  if (node.type === "ONU" || node.type === "FOB") {
    const path = getSignalPath(node);
    pathConns = path.conns;
    pathNodes = path.nodes;
  } else if (node.type === "OLT") {
    pathNodes = [node];
    const downstream = getDownstreamConns(node);
    pathConns = downstream;
    downstream.forEach((c) => {
      if (c.to && !pathNodes.includes(c.to)) pathNodes.push(c.to);
    });
  }

  if (pathConns.length === 0) return;

  pathConns.forEach((c) => {
    if (!c.polyline || !map) return;
    const pts = /** @type {import('leaflet').LatLngExpression[]} */ (c.polyline.getLatLngs());
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

  pathNodes.forEach((n) => {
    if (n.marker && n.marker._icon) {
      n.marker._icon.classList.add("highlighted-marker");
    }
  });
}

/** Remove all signal path glow overlays. */
export function clearSignalPath() {
  if (map) {
    pathGlowLayers.forEach((l) => map.removeLayer(l));
  }
  pathGlowLayers = [];
  nodes.forEach((n) => {
    if (n.marker && n.marker._icon) {
      n.marker._icon.classList.remove("highlighted-marker");
    }
  });
}

// ═══════════════════════════════════════════════
//  SIGNAL ANIMATION
// ═══════════════════════════════════════════════
/** @type {import('leaflet').Polyline[]} */
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
    if (!c.polyline || !map) return;
    const pts = /** @type {import('leaflet').LatLngExpression[]} */ (c.polyline.getLatLngs());
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

export function removeSignalAnimOverlays() {
  if (map) {
    signalAnimLayers.forEach((l) => map.removeLayer(l));
  }
  signalAnimLayers = [];
}

export function refreshSignalAnim() {
  if (signalAnimActive) createSignalAnimOverlays();
}
