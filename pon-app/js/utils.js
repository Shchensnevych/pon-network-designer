// @ts-check
// Generic helpers and signal classification utilities.
// Extracted from the original PON_Leaflet.html logic.

import { ONU_MIN } from "./config.js";

/**
 * Classify signal level vs ONU_MIN into semantic buckets.
 * @param {number} v — signal level in dB
 * @returns {"ok" | "warn" | "err"}
 */
export function sigClass(v) {
  return v >= ONU_MIN ? "ok" : v >= ONU_MIN - 3 ? "warn" : "err";
}

/**
 * Map signal level to CSS class used in labels.
 * @param {number} v — signal level in dB
 * @returns {"lbl-ok" | "lbl-warn" | "lbl-err"}
 */
export function sigColorClass(v) {
  return sigClass(v) === "ok"
    ? "lbl-ok"
    : sigClass(v) === "warn"
      ? "lbl-warn"
      : "lbl-err";
}
