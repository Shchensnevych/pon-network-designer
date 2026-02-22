// @ts-check
// PON signal calculation and port logic.
// Pure functions that compute signal levels, losses, port status, distances.

import { FBT_LOSSES, PLC_LOSSES, MECH, ONU_MIN, FIBER_DB_KM } from "./config.js";
import { conns, map } from "./state.js";

// ═══════════════════════════════════════════════
//  CHAIN COLOR
// ═══════════════════════════════════════════════

/**
 * Walk upstream from FOB to find the OLT cable color.
 * @param {FOBNode} fob
 * @returns {string}
 */
export function getChainColor(fob) {
  /** @type {PONNode} */
  let node = fob;
  while (node && node.type === "FOB" && node.inputConn) {
    const c = node.inputConn;
    if (c.from.type === "OLT" && c.color) return c.color;
    if (c.color && c.from.type === "OLT") return c.color;
    node = c.from;
  }
  return "#e0e0e0";
}

// ═══════════════════════════════════════════════
//  PORT COUNTS
// ═══════════════════════════════════════════════

/**
 * Count cables going FROM this FOB.
 * @param {FOBNode} fob
 * @returns {number}
 */
export function usedCables(fob) {
  return conns.filter((c) => c.from === fob && c.type === "cable").length;
}

/**
 * Count patchcords going FROM this FOB.
 * @param {FOBNode} fob
 * @returns {number}
 */
export function usedPatches(fob) {
  return conns.filter((c) => c.from === fob && c.type === "patchcord").length;
}

/**
 * Total used outputs (cables + patches).
 * @param {FOBNode} fob
 * @returns {number}
 */
export function usedOutputs(fob) {
  return usedCables(fob) + usedPatches(fob);
}

/**
 * Maximum output ports for a FOB node.
 * @param {FOBNode} fob
 * @returns {number}
 */
export function maxOutputs(fob) {
  if (!fob.plcType && !fob.fbtType) return 1;
  if (fob.plcType && !fob.fbtType) return parseInt(fob.plcType.split("x")[1]);
  if (fob.fbtType && !fob.plcType) return 2;
  if (fob.fbtType && fob.plcType) return 1 + parseInt(fob.plcType.split("x")[1]);
  return 1;
}

/**
 * Free cable ports on the FOB.
 * @param {FOBNode} fob
 * @returns {number}
 */
export function freeCablePorts(fob) {
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

/**
 * Free patchcord ports on the FOB.
 * @param {FOBNode} fob
 * @returns {number}
 */
export function freePatchPorts(fob) {
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

// ═══════════════════════════════════════════════
//  FOB PORT STATUS (for tooltip & popup)
// ═══════════════════════════════════════════════

/**
 * Build port-status description for a FOB node.
 * @param {FOBNode} n
 * @returns {{ lines: string[], rich: string[], details: Array<{label: string, targets: string[]}> }}
 */
export function fobPortStatus(n) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const rich = [];
  /** @type {Array<{label: string, targets: string[]}>} */
  const details = [];

  /**
   * Build compact type tag like (FOB), (ONU), (FOB/ONU) from connections
   * @param {typeof conns} arr
   * @returns {string}
   */
  const typeTag = (arr) => {
    const types = [...new Set(arr.map((c) => c.to.type))];
    return types.length > 0 ? ` (${types.join("/")})` : "";
  };

  if (!n.fbtType && !n.plcType) {
    const outConns = conns.filter((c) => c.from === n);
    const used = outConns.length;
    const clr = used === 0 ? "#3fb950" : "#f85149";
    lines.push(`<span style="color:#f97316">⇄ ${used}/1${typeTag(outConns)}</span>`);
    const target = outConns.length > 0 ? outConns[0].to.name : "";
    rich.push(`📦 Транзит: <span style="color:${clr}">${used}/1</span>${target ? ` → ${target}` : ""}`);
    details.push({ label: "Транзит", targets: outConns.map((c) => c.to.name) });
  }

  if (n.fbtType && !n.plcType) {
    const xConns = conns.filter((c) => c.from === n && c.branch === "X");
    const yConns = conns.filter((c) => c.from === n && c.branch === "Y");
    const xUsed = xConns.length;
    const yUsed = yConns.length;
    const total = xUsed + yUsed;
    const xClr = xUsed ? "#f85149" : "#3fb950";
    const yClr = yUsed ? "#f85149" : "#3fb950";
    const xName = xConns.length > 0 ? xConns[0].to.name : "";
    const yName = yConns.length > 0 ? yConns[0].to.name : "";
    lines.push(
      `<span style="color:#ff6b6b">FBT X: <span style="color:${xClr}">${xUsed}/1${typeTag(xConns)}</span></span>`,
    );
    lines.push(
      `<span style="color:#ff6b6b">FBT Y: <span style="color:${yClr}">${yUsed}/1${typeTag(yConns)}</span></span>`,
    );
    rich.push(
      `🔀 FBT ${n.fbtType}: <span style="color:${xClr}">X=${xUsed ? "зайн." : "вільн."}</span>${xName ? ` → ${xName}` : ""} <span style="color:${yClr}">Y=${yUsed ? "зайн." : "вільн."}</span>${yName ? ` → ${yName}` : ""} (${total}/2)`,
    );
    details.push({ label: `FBT X`, targets: xConns.map((c) => c.to.name) });
    details.push({ label: `FBT Y`, targets: yConns.map((c) => c.to.name) });
  }

  if (!n.fbtType && n.plcType) {
    const plcMax = parseInt(n.plcType.split("x")[1]);
    const plcConns = conns.filter((c) => c.from === n);
    const plcUsed = plcConns.length;
    const plcFree = plcMax - plcUsed;
    const clr = plcFree > 0 ? "#3fb950" : "#f85149";
    lines.push(
      `<span style="color:#c084fc">PLC ${n.plcType}: <span style="color:${clr}">${plcUsed}/${plcMax}${typeTag(plcConns)}</span></span>`,
    );
    const names = plcConns.map((c) => c.to.name).join(", ");
    rich.push(
      `📊 PLC ${n.plcType}: ${plcUsed}/${plcMax} (<span style="color:${clr}">вільно: ${plcFree}</span>)${names ? `<br>  └ ${names}` : ""}`,
    );
    details.push({ label: `PLC`, targets: plcConns.map((c) => c.to.name) });
  }

  if (n.fbtType && n.plcType) {
    const plcBr = n.plcBranch || "Y";
    const freeBr = plcBr === "X" ? "Y" : "X";
    const freeBrConns = conns.filter((c) => c.from === n && c.branch === freeBr);
    const freeBrUsed = freeBrConns.length > 0;
    const freeClr = freeBrUsed ? "#f85149" : "#3fb950";
    const freeBrName = freeBrConns.length > 0 ? freeBrConns[0].to.name : "";
    // Free branch tag: (FOB), (ONU), etc.
    const freeBrTag = typeTag(freeBrConns);

    const plcMax = parseInt(n.plcType.split("x")[1]);
    const plcConns = conns.filter((c) => c.from === n && c.branch === plcBr);
    const plcUsed = plcConns.length;
    const plcFree = plcMax - plcUsed;
    const plcClr = plcFree > 0 ? "#3fb950" : "#f85149";
    // PLC branch tag: always PLC + connected node types if any
    const plcOccupants = typeTag(plcConns);
    const plcTag = plcOccupants ? ` (PLC${plcOccupants})` : " (PLC)";

    // FBT line: show BOTH branches — X and Y — with who occupies each
    const brX = plcBr === "X"
      ? `<span style="color:#f85149">X:1/1${plcTag}</span>`
      : `<span style="color:${freeClr}">X:${freeBrUsed ? "1/1" : "0/1"}${freeBrTag}</span>`;
    const brY = plcBr === "Y"
      ? `<span style="color:#f85149">Y:1/1${plcTag}</span>`
      : `<span style="color:${freeClr}">Y:${freeBrUsed ? "1/1" : "0/1"}${freeBrTag}</span>`;
    lines.push(
      `<span style="color:#ff6b6b">FBT ${brX}</span>`,
    );
    lines.push(
      `<span style="color:#ff6b6b">FBT ${brY}</span>`,
    );
    lines.push(
      `<span style="color:#c084fc">PLC [${plcBr}] ${n.plcType}: <span style="color:${plcClr}">${plcUsed}/${plcMax}${typeTag(plcConns)}</span></span>`,
    );
    rich.push(
      `🔀 FBT ${n.fbtType}: гілка ${plcBr} = <span style="color:#f85149">PLC ${n.plcType}</span>`,
    );
    rich.push(
      `🔀 FBT ${n.fbtType}: гілка ${freeBr} = <span style="color:${freeClr}">${freeBrUsed ? "зайнята" : "вільна"}</span>${freeBrName ? ` → ${freeBrName}` : ""}`,
    );
    const plcNames = plcConns.map((c) => c.to.name).join(", ");
    rich.push(
      `📊 PLC ${n.plcType} (гілка ${plcBr}): ${plcUsed}/${plcMax} (<span style="color:${plcClr}">вільно: ${plcFree}</span>)${plcNames ? `<br>  └ ${plcNames}` : ""}`,
    );
    details.push({ label: `FBT ${freeBr}`, targets: freeBrConns.map((c) => c.to.name) });
    details.push({ label: `PLC`, targets: plcConns.map((c) => c.to.name) });
  }

  return { lines, rich, details };
}


// ═══════════════════════════════════════════════
//  DISTANCE & SIGNAL CALCULATIONS
// ═══════════════════════════════════════════════

/**
 * Straight-line distance between two nodes (meters).
 * @param {PONNode} n1
 * @param {PONNode} n2
 * @returns {number}
 */
export function getDistM(n1, n2) {
  if (!map) return 0;
  return map.distance(L.latLng(n1.lat, n1.lng), L.latLng(n2.lat, n2.lng));
}

/**
 * Cable length in km (along polyline or straight-line fallback).
 * @param {PONConnection} c
 * @returns {number}
 */
export function connKm(c) {
  if (!c.polyline || !map) return getDistM(c.from, c.to) / 1000.0;
  let dist = 0;
  const pts = c.polyline.getLatLngs();
  const flatPts =
    (L.LineUtil.isFlat && L.LineUtil.isFlat(/** @type {import('leaflet').LatLng[]} */ (pts))) ||
    (pts.length > 0 && typeof /** @type {any} */ (pts[0]).lat === "number")
      ? pts
      : /** @type {any} */ (pts[0]);
  if (!flatPts || flatPts.length < 2) return getDistM(c.from, c.to) / 1000.0;
  for (let i = 0; i < flatPts.length - 1; i++) {
    dist += map.distance(flatPts[i], flatPts[i + 1]);
  }
  return dist / 1000.0;
}

/**
 * Signal level at FOB input (dBm).
 * @param {FOBNode} fob
 * @returns {number}
 */
export function sigIn(fob) {
  if (!fob.inputConn) return 0;
  const c = fob.inputConn;
  const cLoss = connKm(c) * FIBER_DB_KM;
  if (c.from.type === "OLT") return /** @type {OLTNode} */ (c.from).outputPower - cLoss - MECH;
  if (c.from.type === "FOB") return sigOnOutput(/** @type {FOBNode} */ (c.from), c) - cLoss - MECH;
  return 0;
}

/**
 * Signal on a specific output of a FOB (dBm).
 * @param {FOBNode} fob
 * @param {PONConnection} conn
 * @returns {number}
 */
export function sigOnOutput(fob, conn) {
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

/**
 * Check if a FOB has a path to an OLT.
 * @param {FOBNode} fob
 * @returns {boolean}
 */
export function hasOLTPath(fob) {
  if (!fob || !fob.inputConn) return false;
  if (fob.inputConn.from.type === "OLT") return true;
  if (fob.inputConn.from.type === "FOB") return hasOLTPath(/** @type {FOBNode} */ (fob.inputConn.from));
  return false;
}

/**
 * Signal level at ONU/MDU (dBm).
 * @param {ONUNode | MDUNode} onu
 * @returns {number}
 */
export function sigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return 0;
  if (!hasOLTPath(/** @type {FOBNode} */ (c.from))) return 0;
  const fobOut = sigOnOutput(/** @type {FOBNode} */ (c.from), c);
  const patchLoss = connKm(c) * FIBER_DB_KM;
  return fobOut - patchLoss;
}

/**
 * Signal after FBT split on a specific branch.
 * @param {FOBNode} fob
 * @param {string} branch - "X" or "Y"
 * @returns {number}
 */
export function sigFBT(fob, branch) {
  const base = sigIn(fob);
  if (!fob.fbtType) return base;
  return (
    base -
    (branch === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y) -
    MECH
  );
}

/**
 * Expected signal at ONU for a FOB.
 * @param {FOBNode} fob
 * @returns {number}
 */
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

/**
 * Count ONUs on a specific OLT port.
 * @param {OLTNode} olt
 * @param {number} port
 * @returns {number}
 */
export function cntONUport(olt, port) {
  return conns
    .filter((c) => c.from === olt && c.fromPort === port)
    .reduce((a, c) => a + cntDn(c.to), 0);
}

/**
 * Count downstream ONUs from a node.
 * @param {PONNode} n
 * @returns {number}
 */
export function cntDn(n) {
  if (n.type === "ONU") return 1;
  if (n.type === "MDU") return (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
  if (n.type === "FOB") {
    const d = conns.filter((c) => c.from === n && c.type === "patchcord").length;
    const sub = conns
      .filter((c) => c.from === n && c.type === "cable")
      .reduce((a, c) => a + cntDn(c.to), 0);
    return d + sub;
  }
  return 0;
}

// ═══════════════════════════════════════════════
//  COLOR-CODED CABLES
// ═══════════════════════════════════════════════

/**
 * Get CSS color for a signal level.
 * @param {number | null | undefined} sig
 * @returns {string}
 */
export function getSignalColor(sig) {
  if (sig === 0 || sig === null || sig === undefined) return "#6b7280";
  if (sig >= ONU_MIN) return "#3fb950";
  if (sig >= ONU_MIN - 3) return "#d29922";
  return "#f85149";
}

/** Update cable glow colors based on current signal levels. */
export function updateCableColors() {
  conns.forEach((c) => {
    if (!c.polyline) return;
    /** @type {number | null} */
    let sig = null;
    if (c.type === "cable" && c.to?.type === "FOB" && c.to.inputConn && hasOLTPath(/** @type {FOBNode} */ (c.to))) {
      sig = sigIn(/** @type {FOBNode} */ (c.to));
    } else if (c.type === "patchcord" && (c.to?.type === "ONU" || c.to?.type === "MDU") && c.from && hasOLTPath(/** @type {FOBNode} */ (c.from))) {
      sig = sigAtONU(/** @type {ONUNode|MDUNode} */ (c.to));
    }
    if (sig !== null) {
      const glowColor = getSignalColor(sig);
      /** @type {any} */ (c.polyline).getElement()?.style?.setProperty("filter", `drop-shadow(0 0 4px ${glowColor})`);
    } else {
      /** @type {any} */ (c.polyline).getElement()?.style?.setProperty("filter", "none");
    }
  });
}
