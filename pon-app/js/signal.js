// @ts-check
/// <reference path="./types.d.ts" />
// PON signal calculation and port logic.
// Pure functions that compute signal levels, losses, port status, distances.

/** @type {typeof import('leaflet')} */
const L = window["L"];

import { FBT_LOSSES, PLC_LOSSES, MECH, ONU_MIN, FIBER_DB_KM } from "./config.js";
import { nodes, conns, map } from "./state.js";

// Trunk cable palette — max contrast, avoids signal-indicator hues (green/yellow/red)
export const PON_COLORS = ["#58a6ff", "#f778ba", "#56d4dd", "#b07efc", "#79c0ff", "#ff9bce", "#3dd6c8", "#d2a8ff"];

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
  while (node && (node.type === "FOB" || node.type === "MDU") && node.inputConn) {
    const c = node.inputConn;
    if (c.from.type === "OLT") {
      // Find what PON port is patched to the first active core of this cable
      const firstXc = (c.from.crossConnects || []).find(xc => xc.toType === "CABLE" && xc.toId === c.id);
      if (firstXc) {
        if (c.customColor) return c.customColor;
        return PON_COLORS[Number(firstXc.fromId) % PON_COLORS.length];
      }
      return "#8b949e";
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

  const xc = n.crossConnects || [];
  
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

  const getTargetTag = (xcEntry) => {
      if (xcEntry.toType === "SPLITTER") {
          const spTarget = splitters.find(s => s.id === xcEntry.toId) || 
                           (xcEntry.toId === "legacy_plc" ? { id: "legacy_plc", type: "PLC", ratio: n.plcType || "" } : 
                            xcEntry.toId === "legacy_fbt" ? { id: "legacy_fbt", type: "FBT", ratio: n.fbtType || "" } : null);
          if (spTarget) {
              return ` [🔀 ${spLabels[spTarget.id] || (spTarget.type + " " + spTarget.ratio)}]`;
          }
          return ` [🔀 Сплітер]`;
      }
      const c = conns.find(x => x.id === xcEntry.toId);
      if (!c || !c.to) return "";

      let targetLabel = c.to.name;
      if (c.to.type === "MDU" && c.type === "cable") {
          const mdu = c.to;
          let fls = [];
          if (mdu.flats) {
              // Helper to trace if a target is fed by the given cable core
              const isFedByCore = (type, id) => {
                  if (type === "CABLE" && id === xcEntry.toId) return true; // Direct
                  if (type === "SPLITTER") {
                      // Check mainBox
                      let spXc = (mdu.mainBox?.crossConnects || []).find(x => x.toId === id);
                      if (spXc) {
                           if (spXc.fromType === "CABLE" && spXc.fromId === xcEntry.toId && spXc.fromCore === xcEntry.toCore) return true;
                           if (spXc.fromType === "SPLITTER") return isFedByCore("SPLITTER", spXc.fromId);
                      }
                      // Check floorBoxes
                      for (let fb of (mdu.floorBoxes || [])) {
                          spXc = (fb.crossConnects || []).find(x => x.toId === id);
                          if (spXc) {
                               if (spXc.fromType === "CABLE" && spXc.fromId === xcEntry.toId && spXc.fromCore === xcEntry.toCore) return true;
                               if (spXc.fromType === "SPLITTER") return isFedByCore("SPLITTER", spXc.fromId);
                          }
                      }
                  }
                  return false;
              };

              fls = mdu.flats.filter(f => f.crossConnect && isFedByCore(f.crossConnect.fromType, f.crossConnect.fromId)).map(f => f.flat);
          }
          if (fls.length === 1) {
              targetLabel += `, Кв. ${fls[0]}`;
          } else if (fls.length > 1) {
              targetLabel += ` (${fls.length} кв.)`;
          }
      }

      return c.type === "patchcord" ? ` (${targetLabel})` : ` [К: ${targetLabel}]`;
  };

  const renderSplitterStatus = (spId, spType, spRatio, legacyLabel = "") => {
      const spName = legacyLabel || spLabels[spId] || `${spType} ${spRatio}`;
      if (spType === "FBT") {
          const xConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId && x.fromBranch === "X");
          const yConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId && x.fromBranch === "Y");
          
          const xClr = xConns.length ? "#f85149" : "#3fb950"; // Red if busy, Green if free
          const yClr = yConns.length ? "#f85149" : "#3fb950";
          
          const xName = xConns.length ? getTargetTag(xConns[0]) : "";
          const yName = yConns.length ? getTargetTag(yConns[0]) : "";

          lines.push(`<span style="color:#ff6b6b">${spName} X: <span style="color:${xClr}">${xConns.length ? "зайнята" + xName : "вільна"}</span></span>`);
          lines.push(`<span style="color:#ff6b6b">${spName} Y: <span style="color:${yClr}">${yConns.length ? "зайнята" + yName : "вільна"}</span></span>`);
          
          rich.push(`🔀 ${spName}:<br>&nbsp;&nbsp;<span style="color:${xClr}">X = ${xConns.length ? "зайн." : "вільн."}</span>${xName}<br>&nbsp;&nbsp;<span style="color:${yClr}">Y = ${yConns.length ? "зайн." : "вільн."}</span>${yName}`);
      } else if (spType === "PLC") {
          const plcMax = parseInt(spRatio.split("x")[1]) || 2;
          const plcConns = xc.filter(x => x.fromType === "SPLITTER" && x.fromId === spId);
          const plcUsed = plcConns.length;
          const plcFree = plcMax - plcUsed;
          const clr = plcFree > 0 ? "#3fb950" : "#f85149";
          
          const targetsRaw = [...new Set(plcConns.map(x => {
              if (x.toType === "SPLITTER") {
                  const spTarget = splitters.find(s => s.id === x.toId) || 
                                   (x.toId === "legacy_plc" ? { id: "legacy_plc", type: "PLC", ratio: n.plcType || "" } : null);
                  return spTarget ? { type: "SPLITTER", name: (spLabels[spTarget.id] || (spTarget.type + " " + spTarget.ratio)) } : { type: "SPLITTER", name: "Сплітер" };
              }
              const c = conns.find(cf => cf.id === x.toId);
              return c && c.to ? { type: c.to.type, name: c.to.name } : null;
          }))].filter(Boolean);
          
          let onuCnt = 0, mduCnt = 0;
          let otherArr = [];
          targetsRaw.forEach(t => {
              if (t.type === "ONU") onuCnt++;
              else if (t.type === "MDU") mduCnt++;
              else if (t.type === "SPLITTER") otherArr.push(t.name);
              else otherArr.push(`К: ${t.name}`);
          });
          
          let tagArr = [];
          if (onuCnt > 0) tagArr.push(`ONU x${onuCnt}`);
          if (mduCnt > 0) tagArr.push(`MDU x${mduCnt}`);
          if (otherArr.length > 0) tagArr.push(...otherArr);
          const targetStr = tagArr.join(", ");
          
          const tgtLabel = targetStr ? ` <span style="color:#8b949e">[${targetStr}]</span>` : "";
          lines.push(`<span style="color:#c084fc">${spName}: <span style="color:${clr}">${plcUsed}/${plcMax} зайнято</span>${tgtLabel}</span>`);
          rich.push(`📊 ${spName}: ${plcUsed}/${plcMax} (<span style="color:${clr}">вільно: ${plcFree}</span>)${targetStr ? `<br>  └ ${targetStr}` : ""}`);
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
 * @param {string} targetType "CABLE" | "SPLITTER" | "PATCHCORD"
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
  
  const visited = new Set(); // Prevent infinite loops in ring topologies

  while (fob && (fob.type === "FOB" || fob.type === "MDU")) {
    const stepKey = `${fob.id}|${type}|${id}|${core}`;
    if (visited.has(stepKey)) return null;
    visited.add(stepKey);

    // If we're tracing from a patchcord, we don't need a core match
    const xc = (fob.crossConnects || []).find(x => {
        if (x.toType !== type || String(x.toId) !== String(id)) return false;
        if (type === "PATCHCORD" || type === "LOCAL" || core === undefined) return true;
        return x.toCore === core || x.toBranch === String(core) || String(x.toCore) === String(core);
    });
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
      } else if (inCable.from.type === "FOB" || inCable.from.type === "MDU") {
        fob = /** @type {any} */ (inCable.from);
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
        } else if (c.from.type === "FOB" || c.from.type === "MDU") {
             const s = traceOpticalPath(/** @type {any} */ (c.from), "CABLE", c.id, i);
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

const mduSigsCache = new WeakMap();

/**
 * Signal level at MDU (dBm) derived from internal FTTH cascade.
 * @param {MDUNode} mdu
 * @returns {number | null}
 */
export function calculateMDUSignal(mdu) {
  const inCables = conns.filter(c => c.to === mdu && c.type === "cable");
  const inPatches = conns.filter(c => c.to === mdu && c.type === "patchcord");
  
  const mduSigs = { spIn: {}, spOut: {}, flats: {} };
  mduSigsCache.set(mdu, mduSigs);
  
  if (inCables.length === 0 && inPatches.length === 0) return null;

  // We find the signal entering the MDU
  const inSignals = {}; // key: "CABLE|id|core" or "PATCHCORD|id|0", value: number
  
  inCables.forEach(c => {
      const cores = c.capacity || 1;
      for (let i = 0; i < cores; i++) {
          let s = null;
          if (c.from.type === "OLT") {
              const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
              if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
          } else if (c.from.type === "FOB" || c.from.type === "MDU") {
              const upstream = traceOpticalPath(/** @type {any} */ (c.from), "CABLE", c.id, i);
              if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
          }
           if (s !== null) inSignals[`CABLE|${c.id}|${i}`] = s;
      }
  });

  inPatches.forEach(c => {
      if (c.from.type === "FOB" || c.from.type === "MDU") {
          const s = traceOpticalPath(/** @type {any} */ (c.from), "PATCHCORD", c.id, 0);
          if (s !== null) inSignals[`PATCHCORD|${c.id}|0`] = s - (connKm(c) * FIBER_DB_KM);
      }
  });

  if (Object.keys(inSignals).length === 0) return null;

  if (mdu.architecture === "FTTB") {
    // Check for LOCAL uplink via cross-connect (e.g., splitter output → this MDU)
    const localXc = (mdu.crossConnects || []).find(xc => xc.toType === "LOCAL");
    if (localXc) {
        // Trace signal through the LOCAL cross-connect
        const localSig = traceOpticalPath(/** @type {any} */ (mdu), "LOCAL", "self", 0);
        return localSig !== null ? localSig : null;
    }
    return null;
  }
  
  // If FTTH, we simulate tracing through Splitters
  let worstSignal = Infinity;
  let foundAny = false;
  
  // Map Main Box Splitters
  (mdu.mainBox?.crossConnects || []).forEach(xc => {
      if (xc.toType === "SPLITTER") {
          const sp = (mdu.mainBox?.splitters || []).find(s => s.id === xc.toId);
          if (!sp) return;
          
          let inputSig = null;
          if (xc.fromType === "CABLE" || xc.fromType === "PATCHCORD") {
              inputSig = inSignals[`${xc.fromType}|${xc.fromId}|${xc.fromCore || 0}`];
          } else if (xc.fromType === "SPLITTER") {
              inputSig = mduSigs.spOut[`${xc.fromId}|${xc.fromBranch}`];
          }
          
          if (inputSig !== undefined && inputSig !== null) {
              mduSigs.spIn[sp.id] = inputSig;
              if (sp.type === "PLC") {
                  const loss = PLC_LOSSES[sp.ratio] || 0;
                  const outs = parseInt(sp.ratio.split('x')[1]) || 2;
                  for(let i=1; i<=outs; i++) mduSigs.spOut[`${sp.id}|${i}`] = inputSig - loss - MECH;
              } else if (sp.type === "FBT") {
                  const lossX = FBT_LOSSES[sp.ratio]?.x || 0;
                  const lossY = FBT_LOSSES[sp.ratio]?.y || 0;
                  mduSigs.spOut[`${sp.id}|X`] = inputSig - lossX - MECH;
                  mduSigs.spOut[`${sp.id}|Y`] = inputSig - lossY - MECH;
              }
          }
      }
  });
  
  // Map Floor Box Splitters
  (mdu.floorBoxes || []).forEach(fb => {
      (fb.crossConnects || []).forEach(xc => {
          if (xc.toType === "SPLITTER") {
              const sp = (fb.splitters || []).find(s => s.id === xc.toId);
              if (!sp) return;
              
              let inputSig = null;
              if (xc.fromType === "CABLE" || xc.fromType === "PATCHCORD") {
                  inputSig = inSignals[`${xc.fromType}|${xc.fromId}|${xc.fromCore||0}`];
              } else if (xc.fromType === "SPLITTER") {
                  inputSig = mduSigs.spOut[`${xc.fromId}|${xc.fromBranch}`];
              }
              
              if (inputSig !== undefined && inputSig !== null) {
                  mduSigs.spIn[sp.id] = inputSig;
                  if (sp.type === "PLC") {
                      const loss = PLC_LOSSES[sp.ratio] || 0;
                      const finalSig = inputSig - loss - MECH;
                      const outs = parseInt(sp.ratio.split('x')[1]) || 2;
                      for(let i=1; i<=outs; i++) mduSigs.spOut[`${sp.id}|${i}`] = finalSig;
                      if (finalSig < worstSignal) worstSignal = finalSig;
                      foundAny = true;
                  } else if (sp.type === "FBT") {
                      const lossX = FBT_LOSSES[sp.ratio]?.x || 0;
                      const lossY = FBT_LOSSES[sp.ratio]?.y || 0;
                      mduSigs.spOut[`${sp.id}|X`] = inputSig - lossX - MECH;
                      mduSigs.spOut[`${sp.id}|Y`] = inputSig - lossY - MECH;
                      foundAny = true;
                  }
              }
          }
      });
  });

  // Calculate flat end signals
  (mdu.flats || []).forEach(f => {
      if (f.crossConnect && f.crossConnect.fromType === "SPLITTER") {
          const outSig = mduSigs.spOut[`${f.crossConnect.fromId}|${f.crossConnect.fromBranch||"1"}`];
          if (outSig !== undefined) {
              mduSigs.flats[f.flat] = outSig;
          }
      }
  });
  
  // If no floor boxes are connected, return main box best or input best
  if (!foundAny) {
      const oVals = Object.values(mduSigs.spOut);
      if (oVals.length > 0) return Math.min(...oVals);
      if (Object.keys(inSignals).length > 0) return Math.max(...Object.values(inSignals));
      return null;
  }
  
  return worstSignal === Infinity ? null : worstSignal;
}

export function getMduSig(mdu, type, id) {
    if (!mdu) return null;
    calculateMDUSignal(mdu); // Ensures simulation cache is fresh
    const sigs = mduSigsCache.get(mdu);
    if (!sigs) return null;
    if (type === "spIn") return sigs.spIn ? (sigs.spIn[id] ?? null) : null;
    if (type === "spOut") return sigs.spOut ? (sigs.spOut[id] ?? null) : null;
    if (type === "flat") return sigs.flats ? (sigs.flats[id] ?? null) : null;
    return null;
}

export function sigAtONU(onu) {
  if (onu.type === "MDU") return calculateMDUSignal(onu);
  
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || (c.from.type !== "FOB" && c.from.type !== "MDU")) return null;
  
  const s = traceOpticalPath(/** @type {any} */ (c.from), "PATCHCORD", c.id, 0);
  if (s === null) return null;
  return s;
}

/**
 * Signal level helper wrapper to apply patch loss correctly to ONU
 */
export function trueSigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return null;
  
  const s = traceOpticalPath(c.from, "PATCHCORD", c.id, 0); // Traces back looking for what feeds `c.id`
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
 * Helper: Traces the optical path strictly to find the originating OLT and Port.
 * @param {FOBNode} currentFob 
 * @param {string} targetType 
 * @param {string} targetId 
 * @param {number|string|undefined} targetCore 
 * @returns {{ olt: OLTNode, port: number } | null}
 */
export function getOltPortForPath(currentFob, targetType, targetId, targetCore) {
  let fob = currentFob;
  let type = targetType;
  let id = targetId;
  let core = targetCore;

  const visited = new Set();

  while (fob && (fob.type === "FOB" || fob.type === "MDU")) {
    const stepKey = `${fob.id}|${type}|${id}|${core}`;
    if (visited.has(stepKey)) return null;
    visited.add(stepKey);

    const xc = (fob.crossConnects || []).find(
      x => x.toType === type && String(x.toId) === String(id) && 
           (type === "PATCHCORD" || type === "LOCAL" || core === undefined || x.toCore === core || x.toBranch === core)
    );
    if (!xc) return null;

    if (xc.fromType === "CABLE") {
      const inCable = conns.find(c => c.id === xc.fromId);
      if (!inCable) return null;
      
      if (inCable.from.type === "OLT") {
        const olt = inCable.from;
        const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === inCable.id && x.toCore === xc.fromCore);
        if (!oltXc) return null;
        return { olt, port: parseInt(String(oltXc.fromId)) };
      } else if (inCable.from.type === "FOB" || inCable.from.type === "MDU") {
        fob = /** @type {any} */ (inCable.from);
        type = "CABLE";
        id = String(inCable.id);
        core = xc.fromCore;
      } else {
        return null;
      }
    } else if (xc.fromType === "SPLITTER") {
      type = "SPLITTER";
      id = String(xc.fromId);
      core = undefined;
    } else {
      return null;
    }
  }
  return null;
}

export function getMDUFlatOltPort(mdu, flatNum) {
  const flatConn = (mdu.flats || []).find(f => f.flat === flatNum);
  if (!flatConn || !flatConn.crossConnect) return null;

  let currentXc = flatConn.crossConnect;
  
  // Trace back through MDU internal splitters
  for (let i = 0; i < 5; i++) { // Max depth protection
      if (currentXc.fromType === "CABLE" || currentXc.fromType === "PATCHCORD") {
          const inConn = conns.find(c => c.id === currentXc.fromId);
          if (!inConn) return null;
          
          if (inConn.from.type === "OLT") {
              const oltXc = (inConn.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === inConn.id && x.toCore === currentXc.fromCore);
              if (oltXc) return { olt: inConn.from, port: parseInt(String(oltXc.fromId)) };
              return null;
          } else if (inConn.from.type === "FOB" || inConn.from.type === "MDU") {
              return getOltPortForPath(/** @type {any} */ (inConn.from), currentXc.fromType, currentXc.fromId, currentXc.fromCore);
          }
          return null;
      } else if (currentXc.fromType === "SPLITTER") {
          // Find the splitter in floorBoxes or mainBox
          let spXc = null;
          for (const fb of (mdu.floorBoxes || [])) {
              spXc = (fb.crossConnects || []).find(x => x.toType === "SPLITTER" && x.toId === currentXc.fromId);
              if (spXc) break;
          }
          if (!spXc) {
              spXc = (mdu.mainBox?.crossConnects || []).find(x => x.toType === "SPLITTER" && x.toId === currentXc.fromId);
          }
          if (!spXc) return null;
          currentXc = spXc;
      } else {
          return null;
      }
  }
  return null;
}

// deleted isTransitFiber

/**
 * Count ONUs on a specific OLT port.
 * @param {OLTNode} olt
 * @param {number} port
 * @returns {number}
 */
export function cntONUport(olt, port) {
  let count = 0;
  for (const onu of nodes) {
      if (onu.type === "ONU") {
          const patch = conns.find(x => x.to === onu && x.type === "patchcord");
          if (patch && patch.from && (patch.from.type === "FOB" || patch.from.type === "MDU")) {
              const origin = getOltPortForPath(/** @type {any} */ (patch.from), "PATCHCORD", patch.id, 0);
              if (origin && origin.olt === olt && origin.port === port) {
                  count += 1;
              }
          }
      } else if (onu.type === "MDU") {
          if (onu.architecture === "FTTB") {
              // Check for LOCAL uplink via cross-connect first
              const localXc = (onu.crossConnects || []).find(xc => xc.toType === "LOCAL");
              if (localXc) {
                  const origin = getOltPortForPath(/** @type {any} */ (onu), "LOCAL", "self", 0);
                  if (origin && origin.olt === olt && origin.port === port) {
                      count += 1;
                  }
              }
          } else {
              // FTTH: Count each active flat on this port
              const totalFlats = (onu.floors || 0) * (onu.entrances || 0) * (onu.flatsPerFloor || 0);
              for (let f = 1; f <= totalFlats; f++) {
                  const origin = getMDUFlatOltPort(onu, f);
                  if (origin && origin.olt === olt && origin.port === port) {
                      count += 1;
                  }
              }
          }
      }
  }
  return count;
}

/**
 * Count active subscribers (apartments/units) on a specific OLT port.
 * @param {OLTNode} olt
 * @param {number} port
 * @returns {number}
 */
export function cntSubsPort(olt, port) {
  let subs = 0;
  for (const onu of nodes) {
      if (onu.type === "ONU") {
          const patch = conns.find(x => x.to === onu && x.type === "patchcord");
          if (patch && patch.from && (patch.from.type === "FOB" || patch.from.type === "MDU")) {
              const origin = getOltPortForPath(/** @type {any} */ (patch.from), "PATCHCORD", patch.id, 0);
              if (origin && origin.olt === olt && origin.port === port) {
                  subs += 1;
              }
          }
      } else if (onu.type === "MDU") {
          if (onu.architecture === "FTTB") {
              // Check for LOCAL uplink via cross-connect first
              const localXc = (onu.crossConnects || []).find(xc => xc.toType === "LOCAL");
              if (localXc) {
                  const origin = getOltPortForPath(/** @type {any} */ (onu), "LOCAL", "self", 0);
                  if (origin && origin.olt === olt && origin.port === port) {
                      const totalAbon = (onu.floors || 0) * (onu.entrances || 0) * (onu.flatsPerFloor || 0);
                      const pen = typeof onu.penetrationRate === "number" ? onu.penetrationRate : 100;
                      subs += Math.ceil(totalAbon * (pen / 100));
                  }
              }
          } else {
              // FTTH: 1 connected flat = 1 subscriber
              const totalFlats = (onu.floors || 0) * (onu.entrances || 0) * (onu.flatsPerFloor || 0);
              for (let f = 1; f <= totalFlats; f++) {
                  const origin = getMDUFlatOltPort(onu, f);
                  if (origin && origin.olt === olt && origin.port === port) {
                      subs += 1;
                  }
              }
          }
      }
  }
  return subs;
}

/**
 * Count downstream ONUs from a node (for map tooltips, FOB capacity, etc).
 * @param {PONNode} n
 * @returns {number}
 */
export function cntDn(n) {
  if (n.type === "ONU") return 1;
  if (n.type === "MDU") {
      if (n.architecture === "FTTB") return 1;
      // FTTH: Count configured flats
      return (n.flats || []).filter(f => f.crossConnect).length;
  }
  if (n.type === "FOB") {
    const d = conns.filter((c) => c.from === n && c.type === "patchcord").reduce((a, c) => a + cntDn(c.to), 0);
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
    if (c.type === "cable" && (c.to?.type === "FOB" || c.to?.type === "MDU") && c.to.inputConn && hasOLTPath(/** @type {any} */ (c.to))) {
      sig = sigIn(/** @type {any} */ (c.to));
    } else if (c.type === "patchcord" && (c.to?.type === "ONU" || c.to?.type === "MDU") && c.from && hasOLTPath(/** @type {any} */ (c.from))) {
      sig = sigAtONU(/** @type {any} */ (c.to));
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
          newColor = c.customColor ? c.customColor : PON_COLORS[Number(firstXc.fromId) % PON_COLORS.length];
        } else {
          newColor = "#8b949e";
        }
      } else if (c.from && (c.from.type === "FOB" || c.from.type === "MDU")) {
        newColor = getChainColor(/** @type {any} */ (c.from));
      }
      
      if (c.color !== newColor) {
        c.color = newColor;
        if (c.polyline) c.polyline.setStyle({ color: newColor });
      }
    }
  });
}
