// ═══════════════════════════════════════════════
//  PON Designer — Shared Type Definitions
//  Used by JSDoc annotations across all modules
// ═══════════════════════════════════════════════

import * as _L from 'leaflet';

// ─── Augment Leaflet types ───
declare module 'leaflet' {
  // Geoman plugin
  interface Map {
    pm: {
      addControls(options: Record<string, unknown>): void;
      enableGlobalEditMode(options?: Record<string, unknown>): void;
      disableGlobalEditMode(): void;
      globalEditModeEnabled(): boolean;
      setGlobalOptions(options: Record<string, unknown>): void;
      toggleGlobalEditMode(options?: Record<string, unknown>): void;
    };
  }
  interface PolylineOptions {
    /** Geoman: exclude this polyline from editing */
    pmIgnore?: boolean;
  }
  interface Polyline {
    pm: {
      enable(options?: Record<string, unknown>): void;
      disable(): void;
    };
  }
  interface MarkerOptions {
    /** Geoman: exclude this marker from editing */
    pmIgnore?: boolean;
  }
  interface Marker {
    nodeRef?: PONNode;
    _icon?: HTMLElement;
    _map?: Map;
  }
}

declare global {
  // ─── Make Leaflet 'L' available as a global value ───
  // (loaded via <script src="leaflet.js"> in index.html)
  const L: typeof _L;

  // ─── html2canvas global ───
  function html2canvas(
    element: HTMLElement,
    options?: Record<string, unknown>
  ): Promise<HTMLCanvasElement>;

  // ─── Window augmentation for onclick handlers ───
  interface Window {
    // network.js
    updNode: Function;
    selectNodeById: Function;
    showSelectedProps: Function;
    deleteNodeById: Function;
    deleteConnById: Function;
    finishOLT: Function;
    finishFBT: Function;
    finishCombo: Function;
    reassignBranch: Function;
    openPatchPanel: Function;
    openCrossConnect: Function;
    autoTransit: Function;
    refreshNetworkUI: Function;
    addSplitter: Function;
    removeSplitter: Function;

    // main.js
    selectTool: Function;
    fitNetwork: Function;
    undo: Function;
    redo: Function;
    toggleEditMode: Function;
    toggleSignalAnim: Function;
    updateFiberLoss: Function;
    setLayer: Function;
    openReport: Function;
    closeModal: Function;
    downloadCSV: Function;
    downloadTXT: Function;
    showSuggestions: Function;
    showTopology: Function;
    showScenarioCompare: Function;
    focusNode: Function;
    openHelp: Function;
    closeHelp: Function;
    switchOnboardingTab: Function;
    exportToJSON: Function;
    loadProject: Function;
    exportToPNG: Function;
    clearNetwork: Function;
    openSettings: Function;
    closeSettings: Function;
    switchTab: Function;
    updateProjectName: Function;
    toggleAutoSave: Function;
    updateAutoSaveInterval: Function;
    updateMaxBackups: Function;
    renderBackupsList: Function;
    restoreBackup: Function;
    deleteBackup: Function;
    BackupManager: unknown;
    openOnboarding: Function;
    closeOnboarding: Function;
  }

  // ═══════════════════════════════════════════════
  //  PON NODE TYPES
  // ═══════════════════════════════════════════════

  interface PONNodeBase {
    id: string;
    type: "OLT" | "FOB" | "ONU" | "MDU";
    name: string;
    lat: number;
    lng: number;
    price: number;
    marker: _L.Marker;
    inputConn: PONConnection | null;
    /** Internal flag used during drag throttling */
    _isDragging?: boolean;
    /** Tooltip direction set by layoutONUTooltips */
    _tooltipDir?: string;
    /** Tooltip offset [x, y] */
    _tooltipOffset?: [number, number];
    /** Whether a leader line is active */
    _hasLeader?: boolean;
    
    /** Splice Matrix / ODF Matrix data */
    crossConnects?: CrossConnection[];
  }

  interface SplitterModule {
    id: string; // e.g., "plc_1", "fbt_2"
    type: "FBT" | "PLC";
    ratio: string; // "10/90", "1x8", etc.
  }

  interface CrossConnection {
    id: string;
    fromType: "PORT" | "CABLE" | "SPLITTER";
    fromId: string | number; // OLT port number, Cable ID, or Splitter ID
    fromCore?: number;       // Specific core inside a cable, or branch of a PLC
    fromBranch?: string;     // String branch (e.g. "X" or "Y" for FBT)
    
    toType: "CABLE" | "SPLITTER" | "UNIT";
    toId: string; // Cable ID, Splitter ID
    toCore?: number;
    toBranch?: string;
  }

  interface OLTNode extends PONNodeBase {
    type: "OLT";
    /** Number of PON ports (typically 4, 8, 16) */
    ports: number;
    /** Output power in dBm */
    outputPower: number;
    /** Max ONUs per port (typically 64 or 128) */
    maxOnuPerPort: number;
    
    /** Patch panel connections mapping PON ports to outgoing cables */
    crossConnects?: CrossConnection[];
  }

  interface FOBNode extends PONNodeBase {
    type: "FOB";
    /** Legacy properties (to be migrated) */
    /** @deprecated Use splitters[] + crossConnects[] */
    fbtType?: string;
    /** @deprecated Use splitters[] + crossConnects[] */
    plcType?: string;
    /** @deprecated Use splitters[] + crossConnects[] */
    plcBranch?: string;
    
    /** Independent internal splitter modules */
    splitters?: SplitterModule[];
    /** Internal crossing/routing matrix (Splice Cassette) */
    crossConnects?: CrossConnection[];
  }

  interface ONUNode extends PONNodeBase {
    type: "ONU";
  }

  interface MDUNode extends PONNodeBase {
    type: "MDU";
    floors: number;
    entrances: number;
    flatsPerFloor: number;
  }

  type PONNode = OLTNode | FOBNode | ONUNode | MDUNode;

  // ═══════════════════════════════════════════════
  //  CONNECTION
  // ═══════════════════════════════════════════════

  interface PONConnection {
    id: string;
    type: "cable" | "patchcord";
    from: PONNode;
    to: PONNode;
    capacity?: number;
    color: string;
    polyline: _L.Polyline;
    /** OLT port index (0-based) */
    fromPort?: number;
    /** Legacy FBT branch: "X" or "Y" */
    branch?: string;
    /** Distance tooltip on the cable */
    _distTooltip?: _L.Tooltip;
  }

  // ═══════════════════════════════════════════════
  //  SERIALIZATION (for save/load/undo)
  // ═══════════════════════════════════════════════

  interface SerializedNode {
    id: string;
    type: "OLT" | "FOB" | "ONU" | "MDU";
    name: string;
    lat: number;
    lng: number;
    price: number;
    ports?: number;
    outputPower?: number;
    maxOnuPerPort?: number;
    fbtType?: string;
    plcType?: string;
    plcBranch?: string;
    floors?: number;
    entrances?: number;
    flatsPerFloor?: number;

    // --- NEW INTERNAL ROUTING ---
    splitters?: SplitterModule[];
    crossConnects?: CrossConnection[];
  }

  interface SerializedConnection {
    id: string;
    type: "cable" | "patchcord";
    from: string;
    to: string;
    color: string;
    fromPort?: number;
    branch?: string;
    pts: [number, number][] | null;
  }

  interface SerializedNetwork {
    schemaVersion: string;
    nodes: SerializedNode[];
    conns: SerializedConnection[];
    fobCounter: number;
    onuCounter: number;
  }

  interface FOBPortStatusResult {
    lines: string[];
    rich: string;
  }
}

export {};
