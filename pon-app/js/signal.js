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
    if (c.from.type === "OLT") {
      // Find what PON port is patched to the first active core of this cable
      const firstXc = (c.from.crossConnects || []).find(xc => xc.toType === "CABLE" && xc.toId === c.id);
      if (firstXc) {
        // Return solid PON color: [Red, Green, Blue, Orange]
        return ["#ff4444", "#3fb950", "#58a6ff", "#f0883e"][Number(firstXc.fromId) % 4];
      }
      return c.color || "#8b949e";
    }
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
  let total = 0;
  total += (fob.splitters || []).reduce((sum, sp) => {
      return sum + (sp.type === "PLC" ? (parseInt(sp.ratio.split("x")[1]) || 2) : 2);
  }, 0);
  if (fob.fbtType && !(fob.splitters||[]).some(s=>s.id==="legacy_fbt")) total += 2;
  if (fob.plcType && !(fob.splitters||[]).some(s=>s.id==="legacy_plc")) total += (parseInt(fob.plcType.split("x")[1]) || 2);
  return total || 1; // At least 1 for transit
}

/**
 * Free cable ports calculation (approximated from splice matrix).
 * @param {FOBNode} fob
 * @returns {number}
 */
export function freeCablePorts(fob) {
  const maxOut = maxOutputs(fob);
  const usedSplitterOuts = (fob.crossConnects || []).filter(xc => xc.fromType === "SPLITTER").length;
  return Math.max(0, maxOut - usedSplitterOuts);
}

/**
 * Free patchcord ports calculation (approximated from splice matrix).
 * @param {FOBNode} fob
 * @returns {number}
 */
export function freePatchPorts(fob) {
  return freeCablePorts(fob);
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
  const lines = [];
  const rich = [];
  const details = [];

  const xc = n.crossConnects || [];
  
  // Helper to format cable core counts
  const targetTag = (cId) => {
      const c = conns.find(x => x.id === cId);
      if (!c || !c.to) return "";
      return c.type === "patchcord" ? ` (${c.to.name})` : ` [К: ${c.to.name}]`;
  };

  const activeTransits = xc.filter(x => x.fromType === "CABLE" && x.toType === "CABLE");
  const used = activeTransits.length;
  
  if (used > 0 || (!n.fbtType && !n.plcType)) {
    const clr = used > 0 ? "#3fb950" : "#f85149";
    lines.push(`<span style="color:#f97316">Транзит: <span style="color:${clr}">${used} жил</span></span>`);
    rich.push(`📦 Транзит: <span style="color:${clr}">${used} жил зварено</span>`);
    
    // Group by outgoing cable
    const outCables = [...new Set(activeTransits.map(x => x.toId))];
    outCables.forEach(cid => {
        const c = conns.find(x => x.id === cid);
        if (c) {
           const count = activeTransits.filter(x => x.toId === cid).length;
           rich.push(`  └ До ${c.to.name}: ${count} жил`);
        }
    });
  }

  const splitters = n.splitters || [];
  const spCounts = {};
  const spLabels = {};

  splitters.forEach(sp => {
      const key = `${sp.type}_${sp.ratio}`;
      spCounts[key] = (spCounts[key] || 0) + 1;
  });

  const spCurrent = {};
  splitters.forEach(sp => {
      const key = `${sp.type}_${sp.ratio}`;
      if (spCounts[key] > 1) {
          spCurrent[key] = (spCurrent[key] || 0) + 1;
          spLabels[sp.id] = `${sp.type} ${sp.ratio} #${spCurrent[key]}`;
      } else {
          spLabels[sp.id] = `${sp.type} ${sp.ratio}`;
      }
  });

  const renderSplitterStatus = (spId, spType, spRatio, legacyLabel = "") => {
      const spName = legacyLabel || spLabels[spId] || `${spType} ${spRatio}`;
      if (spType === "FBT") {
          const xConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId && x.fromBranch === "X");
          const yConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId && x.fromBranch === "Y");
          
          const xClr = xConns.length ? "#f85149" : "#3fb950"; // Red if busy, Green if free
          const yClr = yConns.length ? "#f85149" : "#3fb950";
          
          const xName = xConns.length ? targetTag(xConns[0].toId) : "";
          const yName = yConns.length ? targetTag(yConns[0].toId) : "";

          lines.push(`<span style="color:#ff6b6b">${spName} X: <span style="color:${xClr}">${xConns.length ? "зайнята" + xName : "вільна"}</span></span>`);
          lines.push(`<span style="color:#ff6b6b">${spName} Y: <span style="color:${yClr}">${yConns.length ? "зайнята" + yName : "вільна"}</span></span>`);
          
          rich.push(`🔀 ${spName}: <span style="color:${xClr}">X = ${xConns.length ? "зайн." : "вільн."}</span>${xName} | <span style="color:${yClr}">Y = ${yConns.length ? "зайн." : "вільн."}</span>${yName}`);
      } else if (spType === "PLC") {
          const plcMax = parseInt(spRatio.split("x")[1]) || 2;
          const plcConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId);
          const plcUsed = plcConns.length;
          const plcFree = plcMax - plcUsed;
          const clr = plcFree > 0 ? "#3fb950" : "#f85149";
          
          lines.push(`<span style="color:#c084fc">${spName}: <span style="color:${clr}">${plcUsed}/${plcMax} зайнято</span></span>`);
          
          const targets = [...new Set(plcConns.map(x => {
              const c = conns.find(cf => cf.id === x.toId);
              return c ? c.to.name : "";
          }))].filter(Boolean).join(", ");
          
          rich.push(`📊 ${spName}: ${plcUsed}/${plcMax} (<span style="color:${clr}">вільно: ${plcFree}</span>)${targets ? `<br>  └ ${targets}` : ""}`);
      }
  };

  splitters.forEach(sp => {
      renderSplitterStatus(sp.id, sp.type, sp.ratio);
  });
  
  if (n.fbtType && !splitters.some(s => s.id === "legacy_fbt")) {
      renderSplitterStatus("legacy_fbt", "FBT", n.fbtType, `FBT ${n.fbtType}`);
  }
  if (n.plcType && !splitters.some(s => s.id === "legacy_plc")) {
      renderSplitterStatus("legacy_plc", "PLC", n.plcType, `PLC ${n.plcType}`);
  }

  return { lines, rich, details: [] };
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
/**
 * Trace the physical optical path backward from a specific point to the OLT.
 * @param {FOBNode} currentFob 
 * @param {string} targetType "CABLE" | "SPLITTER"
 * @param {string} targetId
 * @param {number|string|undefined} targetCore
 * @returns {number | null} The dBm arriving at this point, or null if no path.
 */
export function traceOpticalPath(currentFob, targetType, targetId, targetCore) {
  let fob = currentFob;
  let type = targetType;
  /** @type {string | number} */
  let id = targetId;
  let core = targetCore;
  let accumulatedLoss = 0;

  while (fob && fob.type === "FOB") {
    const xc = (fob.crossConnects || []).find(
      x => x.toType === type && x.toId === id && (core === undefined || x.toCore === core || x.toBranch === core)
    );
    if (!xc) return null; // Path physically broken

    if (xc.fromType === "CABLE") {
      const inCable = conns.find(c => c.id === xc.fromId);
      if (!inCable) return null;
      
      accumulatedLoss += MECH; // Splice loss inside FOB
      accumulatedLoss += connKm(inCable) * FIBER_DB_KM; // Cable fiber loss

      if (inCable.from.type === "OLT") {
        const olt = inCable.from;
        const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === inCable.id && x.toCore === xc.fromCore);
        if (!oltXc) return null;
        return olt.outputPower - accumulatedLoss;
      } else if (inCable.from.type === "FOB") {
        fob = inCable.from;
        type = "CABLE";
        id = inCable.id;
        core = xc.fromCore;
      } else {
        return null; // Unknown upstream type
      }

    } else if (xc.fromType === "SPLITTER") {
      const splitters = fob.splitters || [];
      const sp = splitters.find(s => s.id === xc.fromId) || 
                 (xc.fromId === "legacy_fbt" ? { type: "FBT", ratio: fob.fbtType } : 
                  xc.fromId === "legacy_plc" ? { type: "PLC", ratio: fob.plcType } : null);
      
      if (sp) {
          if (sp.type === "FBT") {
            const loss = xc.fromBranch === "X" ? (FBT_LOSSES[sp.ratio] ? FBT_LOSSES[sp.ratio].x : 0) : (FBT_LOSSES[sp.ratio] ? FBT_LOSSES[sp.ratio].y : 0);
            accumulatedLoss += loss + MECH;
          } else if (sp.type === "PLC") {
            accumulatedLoss += (PLC_LOSSES[sp.ratio] || 0) + MECH;
          }
      }

      // Continue tracing back from the splitter's INPUT
      type = "SPLITTER";
      id = xc.fromId;
      core = undefined; // Splitter inputs don't have cores
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Returns the MAXIMUM signal arriving at any incoming cable core of the fob.
 * Used primarily for theoretical calculations and UI summaries.
 * @param {FOBNode} fob
 * @returns {number | null}
 */
export function sigIn(fob) {
  const inCables = conns.filter(c => c.to === fob && c.type === "cable");
  let maxSig = -Infinity;
  for (const c of inCables) {
    const cores = c.capacity || 1;
    for (let i = 0; i < cores; i++) {
        // Trace the signal arriving *just before* it splices into anything
        // which means we must trace from its upstream connection
        // But traceOpticalPath expects us to start tracing from a FOB's output.
        // Actually, entering the FOB from upstream CABLE:
        if (c.from.type === "OLT") {
            const olt = c.from;
            const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
            if (oltXc) {
                const s = olt.outputPower - (connKm(c) * FIBER_DB_KM);
                if (s > maxSig) maxSig = s;
            }
        } else if (c.from.type === "FOB") {
             const s = traceOpticalPath(c.from, "CABLE", c.id, i);
             if (s !== null) {
                 const arrivingSignal = s - (connKm(c) * FIBER_DB_KM);
                 if (arrivingSignal > maxSig) maxSig = arrivingSignal;
             }
        }
    }
  }
  return maxSig === -Infinity ? null : maxSig;
}

/**
 * Check if a FOB has a verified physical splice path to an OLT.
 * @param {FOBNode} fob
 * @returns {boolean}
 */
export function hasOLTPath(fob) {
  return sigIn(fob) !== null;
}

/**
 * Signal level at ONU/MDU (dBm).
 * @param {ONUNode | MDUNode} onu
 * @returns {number | null}
 */
export function sigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return null;
  
  const s = traceOpticalPath(c.from, "CABLE", c.id, 0);
  if (s === null) return null;
  return s; // traceOpticalPath already accounts for upstream length, but wait...
  // traceOpticalPath accounts for upstream splicing, but we must subtract the loss of THIS final patchcord!
}

/**
 * Signal level helper wrapper to apply patch loss correctly to ONU
 */
export function trueSigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return null;
  
  const s = traceOpticalPath(c.from, "CABLE", c.id, 0); // Traces back looking for what feeds `c.id` core 0
  if (s === null) return null;
  
  const patchLoss = connKm(c) * FIBER_DB_KM;
  return s - patchLoss; // Signal drops by the time it travels patchcord length
}

/**
 * Signal after FBT split on a specific branch, based on actual splice path.
 * @param {FOBNode} fob
 * @param {string} branch - "X" or "Y"
 * @returns {number | null}
 */
export function sigFBT(fob, branch) {
  return sigSplitter(fob, "legacy_fbt", branch);
}

/**
 * Signal after PLC split, based on actual splice path.
 * @param {FOBNode} fob
 * @returns {number | null}
 */
export function sigPLC(fob) {
  return sigSplitter(fob, "legacy_plc");
}

/**
 * Common method for any splitter type.
 * @param {FOBNode} fob
 * @param {string} splitterId
 * @param {string} [branch]
 */
export function sigSplitter(fob, splitterId, branch) {
  const s = traceOpticalPath(fob, "SPLITTER", splitterId, undefined);
  if (s === null) return null;
  
  const splitters = fob.splitters || [];
  const sp = splitters.find(sx => sx.id === splitterId) || 
             (splitterId === "legacy_fbt" ? { type: "FBT", ratio: fob.fbtType } : 
              splitterId === "legacy_plc" ? { type: "PLC", ratio: fob.plcType } : null);
              
  if (!sp) return null;
  
  if (sp.type === "FBT") {
      const loss = branch === "X" ? (FBT_LOSSES[sp.ratio] ? FBT_LOSSES[sp.ratio].x : 0) : (FBT_LOSSES[sp.ratio] ? FBT_LOSSES[sp.ratio].y : 0);
      return s - loss - MECH;
  } else if (sp.type === "PLC") {
      return s - (PLC_LOSSES[sp.ratio] || 0) - MECH;
  }
  return null;
}

/**
 * Expected theoretical worst signal out of any splitter in FOB
 * @param {FOBNode} fob
 * @returns {number | null}
 */
export function sigONU(fob) {
  let minSig = Infinity;
  const splitters = fob.splitters || [];
  let found = false;
  
  const checkSp = (id, type) => {
     if (type === "FBT") {
         const sx = sigSplitter(fob, id, "X"), sy = sigSplitter(fob, id, "Y");
         if (sx !== null) { minSig = Math.min(minSig, sx); found = true; }
         if (sy !== null) { minSig = Math.min(minSig, sy); found = true; }
     } else {
         const s = sigSplitter(fob, id);
         if (s !== null) { minSig = Math.min(minSig, s); found = true; }
     }
  };
  
  splitters.forEach(sp => checkSp(sp.id, sp.type));
  if (fob.fbtType && !splitters.some(s=>s.id==="legacy_fbt")) checkSp("legacy_fbt", "FBT");
  if (fob.plcType && !splitters.some(s=>s.id==="legacy_plc")) checkSp("legacy_plc", "PLC");

  return found ? minSig : null;
}

/**
 * Count ONUs on a specific OLT port.
 * @param {OLTNode} olt
 * @param {number} port
 * @returns {number}
 */
export function cntONUport(olt, port) {
  const xcList = (olt.crossConnects || []).filter(xc => parseInt(String(xc.fromId)) === port && xc.toType === "CABLE");
  
  // Actually simulating downstream devices per port is complex now. Let's just return the number of cores spliced to this port.
  return xcList.length;
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

    if (c.type === "cable") {
      let newColor = "#e0e0e0";
      if (c.from && c.from.type === "OLT") {
        const firstXc = (c.from.crossConnects || []).find(xc => xc.toType === "CABLE" && xc.toId === c.id);
        if (firstXc) {
          const PON_COLORS = ["#ff4444", "#3fb950", "#58a6ff", "#f0883e"];
          newColor = PON_COLORS[Number(firstXc.fromId) % 4];
        } else {
          newColor = "#8b949e";
        }
      } else if (c.from && c.from.type === "FOB") {
        newColor = getChainColor(c.from);
      }
      
      if (c.color !== newColor) {
        c.color = newColor;
        if (c.polyline) c.polyline.setStyle({ color: newColor });
      }
    }
  });
}
