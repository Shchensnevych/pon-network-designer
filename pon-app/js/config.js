// @ts-check
// Core constants and icon definitions for modular PON Designer.
// Extracted from the original PON_Leaflet.html <script> block.

// Splitter losses (dB) for FBT couplers
/** @type {Record<string, {x: number, y: number}>} */
export const FBT_LOSSES = {
  "5/95": { x: 13.7, y: 0.32 },
  "10/90": { x: 10.08, y: 0.49 },
  "20/80": { x: 7.11, y: 1.06 },
  "30/70": { x: 5.39, y: 1.56 },
  "50/50": { x: 3.17, y: 3.19 },
};

// PLC splitter insertion losses (dB)
/** @type {Record<string, number>} */
export const PLC_LOSSES = {
  "1x2": 4.3,
  "1x4": 7.4,
  "1x8": 10.7,
  "1x16": 13.9,
  "1x32": 17.2,
  "1x64": 21.5,
};

// Mechanical loss per connection (dB)
/** @type {number} */
export const MECH = 0.5;

// Minimum acceptable ONU signal (dB)
/** @type {number} */
export const ONU_MIN = -26;

// Fiber attenuation (dB/km), user-configurable
/** @type {number} */
export let FIBER_DB_KM = 0.4;

// Node counters (for naming FOB / ONU)
/** @type {number} */
export let fobCounter = 1;
/** @type {number} */
export let onuCounter = 1;

/** @returns {number} */
export function nextFobNumber() {
  return fobCounter++;
}

/** @returns {number} */
export function nextOnuNumber() {
  return onuCounter++;
}

/** @param {{ fobCounter?: number, onuCounter?: number } | null} next */
export function setCounters(next) {
  if (!next) return;
  if (typeof next.fobCounter === "number") fobCounter = next.fobCounter;
  if (typeof next.onuCounter === "number") onuCounter = next.onuCounter;
}

/**
 * Update global fiber loss coefficient from user input.
 * @param {string | number} value
 */
export function setFiberLoss(value) {
  const num = Number(value);
  if (!Number.isNaN(num) && num > 0) {
    FIBER_DB_KM = num;
  }
}

// Leaflet icons for OLT / FOB / ONU
export const iconOLT = L.divIcon({
  html: '<div style="background:#58a6ff;width:16px;height:16px;border:2px solid #fff;border-radius:2px;box-shadow:0 0 4px rgba(0,0,0,0.5)"></div>',
  className: "icon-olt",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export const iconFOB = L.divIcon({
  html: '<div style="background:#ff6b6b;width:14px;height:14px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.5)"></div>',
  className: "icon-fob",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export const iconONU = L.divIcon({
  html: '<div style="background:#4ade80;width:10px;height:10px;border:1px solid #fff;border-radius:2px;box-shadow:0 0 4px rgba(0,0,0,0.5)"></div>',
  className: "icon-onu",
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});
