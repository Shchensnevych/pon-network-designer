// Signal path highlighting & signal animation overlays.
// Extracted from network.js — pure visualization, no business logic.

import { nodes, conns, map } from "./state.js";

// ═══════════════════════════════════════════════
//  SIGNAL PATH HIGHLIGHTING
// ═══════════════════════════════════════════════

let pathGlowLayers = [];

/** Check whether a signal-path glow is currently active. */
export function hasActiveGlow() {
  return pathGlowLayers.length > 0;
}

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

export function highlightSignalPath(node) {
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

export function clearSignalPath() {
  pathGlowLayers.forEach((l) => map.removeLayer(l));
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

export function removeSignalAnimOverlays() {
  signalAnimLayers.forEach((l) => map.removeLayer(l));
  signalAnimLayers = [];
}

export function refreshSignalAnim() {
  if (signalAnimActive) createSignalAnimOverlays();
}
