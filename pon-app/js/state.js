// @ts-check
// Shared state for PON Designer modules.
// Only exports what MUST be shared between modules.

// Shared node/connection arrays — mutated by network.js, read by signal.js and ui.js
/** @type {PONNode[]} */
export const nodes = [];

/** @type {PONConnection[]} */
export const conns = [];

// Map instance — set once by network.js, read by signal.js for distance calculations
/** @type {import('leaflet').Map | null} */
export let map = null;

/** @param {import('leaflet').Map} m */
export function setMap(m) { map = m; }
