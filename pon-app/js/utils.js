// Generic helpers and signal classification utilities.
// Extracted from the original PON_Leaflet.html logic.

import { ONU_MIN } from "./config.js";

/**
 * Classify signal level vs ONU_MIN into semantic buckets.
 * Returns one of: "ok" | "warn" | "err".
 */
export function sigClass(v) {
  return v >= ONU_MIN ? "ok" : v >= ONU_MIN - 3 ? "warn" : "err";
}

/**
 * Map signal level to CSS class used in labels.
 * Returns one of: "lbl-ok" | "lbl-warn" | "lbl-err".
 */
export function sigColorClass(v) {
  return sigClass(v) === "ok"
    ? "lbl-ok"
    : sigClass(v) === "warn"
      ? "lbl-warn"
      : "lbl-err";
}

