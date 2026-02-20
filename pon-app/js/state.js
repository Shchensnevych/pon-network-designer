// Shared state for PON Designer modules.
// Only exports what MUST be shared between modules.

// Shared node/connection arrays — mutated by network.js, read by signal.js and ui.js
export const nodes = [];
export const conns = [];

// Map instance — set once by network.js, read by signal.js for distance calculations
export let map = null;
export function setMap(m) { map = m; }
