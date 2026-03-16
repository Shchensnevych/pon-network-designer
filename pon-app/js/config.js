// @ts-check
/// <reference path="./types.d.ts" />
/** @type {typeof import('leaflet')} */
const L = window["L"];

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

// Node counters (for naming FOB / ONU / MDU / MUFTA)
/** @type {number} */
export let fobCounter = 1;
/** @type {number} */
export let muftaCounter = 1;
/** @type {number} */
export let onuCounter = 1;
/** @type {number} */
export let mduCounter = 1;

/** @returns {number} */
export function nextFobNumber() {
  return fobCounter++;
}

/** @returns {number} */
export function nextMuftaNumber() {
  return muftaCounter++;
}

/** @returns {number} */
export function nextOnuNumber() {
  return onuCounter++;
}

/** @returns {number} */
export function nextMduNumber() {
  return mduCounter++;
}

/** @param {{ fobCounter?: number, muftaCounter?: number, onuCounter?: number, mduCounter?: number } | null} next */
export function setCounters(next) {
  if (!next) return;
  if (typeof next.fobCounter === "number") fobCounter = next.fobCounter;
  if (typeof next.muftaCounter === "number") muftaCounter = next.muftaCounter;
  if (typeof next.onuCounter === "number") onuCounter = next.onuCounter;
  if (typeof next.mduCounter === "number") mduCounter = next.mduCounter;
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

// Leaflet icons for OLT / FOB / ONU — unified with sidebar emojis
// Dark circle + unique neon accent border per unit type (pure CSS, no filters for perf)
const baseIcon = 'display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(250,250,250,0.95);';

export const iconOLT = L.divIcon({
  html: `<div style="${baseIcon}width:28px;height:28px;border:2px solid #58a6ff;font-size:16px">🗄️</div>`,
  className: "icon-olt",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

export const iconFOB = L.divIcon({
  html: `<div style="${baseIcon}width:26px;height:26px;border:2px solid #3fb950;font-size:15px">📦</div>`,
  className: "icon-fob",
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

export const iconMUFTA = L.divIcon({
  html: `<div style="${baseIcon}width:26px;height:26px;border:2px solid #e3b341;font-size:15px">🛢️</div>`,
  className: "icon-mufta",
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

export const iconONU = L.divIcon({
  html: `<div style="${baseIcon}width:22px;height:22px;border:2px solid #ff7b72;font-size:13px">🏠</div>`,
  className: "icon-onu",
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

export const iconMDU = L.divIcon({
  html: `<div style="${baseIcon}width:30px;height:30px;border:2px solid #a371f7;font-size:18px">🏢</div>`,
  className: "icon-mdu",
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});
