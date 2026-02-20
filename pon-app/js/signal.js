// PON signal calculation and port logic.
// Pure functions that compute signal levels, losses, port status, distances.

import { FBT_LOSSES, PLC_LOSSES, MECH, ONU_MIN, FIBER_DB_KM } from "./config.js";
import { conns, map } from "./state.js";

// ═══════════════════════════════════════════════
//  CHAIN COLOR
// ═══════════════════════════════════════════════

export function getChainColor(fob) {
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

export function usedCables(fob) {
  return conns.filter((c) => c.from === fob && c.type === "cable").length;
}

export function usedPatches(fob) {
  return conns.filter((c) => c.from === fob && c.type === "patchcord").length;
}

export function usedOutputs(fob) {
  return usedCables(fob) + usedPatches(fob);
}

export function maxOutputs(fob) {
  if (!fob.plcType && !fob.fbtType) return 1;
  if (fob.plcType && !fob.fbtType) return parseInt(fob.plcType.split("x")[1]);
  if (fob.fbtType && !fob.plcType) return 2;
  if (fob.fbtType && fob.plcType) return 1 + parseInt(fob.plcType.split("x")[1]);
  return 1;
}

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

export function fobPortStatus(n) {
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

// ═══════════════════════════════════════════════
//  DISTANCE & SIGNAL CALCULATIONS
// ═══════════════════════════════════════════════

export function getDistM(n1, n2) {
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

export function hasOLTPath(fob) {
  if (!fob || !fob.inputConn) return false;
  if (fob.inputConn.from.type === "OLT") return true;
  if (fob.inputConn.from.type === "FOB") return hasOLTPath(fob.inputConn.from);
  return false;
}

export function sigAtONU(onu) {
  const c = conns.find((x) => x.to === onu && x.type === "patchcord");
  if (!c || c.from.type !== "FOB") return 0;
  if (!hasOLTPath(c.from)) return 0;
  const fobOut = sigOnOutput(c.from, c);
  const patchLoss = connKm(c) * FIBER_DB_KM;
  return fobOut - patchLoss;
}

export function sigFBT(fob, branch) {
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

export function cntDn(n) {
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

// ═══════════════════════════════════════════════
//  COLOR-CODED CABLES
// ═══════════════════════════════════════════════

export function getSignalColor(sig) {
  if (sig === 0 || sig === null || sig === undefined) return "#6b7280";
  if (sig >= ONU_MIN) return "#3fb950";
  if (sig >= ONU_MIN - 3) return "#d29922";
  return "#f85149";
}

export function updateCableColors() {
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
