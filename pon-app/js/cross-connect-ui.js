import { nodes, conns } from "./state.js";
import { FIBER_DB_KM, FBT_LOSSES, PLC_LOSSES } from "./config.js";
import { traceOpticalPath, sigFBT, sigPLC, connKm, sigSplitter } from "./signal.js";

// Modal HTML generation
function createModalContainer() {
  let modal = document.getElementById("cross-connect-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "cross-connect-modal";
    modal.style.cssText = `
      display: none; position: fixed; z-index: 10000; left: 0; top: 0; width: 100%; height: 100%;
      background-color: rgba(0,0,0,0.85);
    `;
    modal.innerHTML = `
      <div style="background-color: #0d1117; margin: 2% auto; padding: 20px; border: 1px solid #30363d; border-radius: 8px; width: 85%; max-width: 1200px; color: #c9d1d9; font-family: sans-serif; height: 85vh; display: flex; flex-direction: column;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #30363d; padding-bottom: 10px; margin-bottom: 10px;">
          <h2 id="cc-modal-title" style="margin: 0; color: #58a6ff;">Налаштування маршрутизації</h2>
          <span id="cc-modal-close" style="color: #8b949e; float: right; font-size: 28px; font-weight: bold; cursor: pointer;">&times;</span>
        </div>
        <div id="cc-modal-body" style="flex: 1; overflow-y: hidden; display: flex; gap: 15px;">
            <!-- UI populated dynamically -->
        </div>
        <div style="border-top: 1px solid #30363d; padding-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
            <button id="cc-modal-cancel" class="btn" style="background:#21262d; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; cursor: pointer; color:#c9d1d9;">Скасувати</button>
            <button id="cc-modal-save" class="btn" style="background:#238636; border: 1px solid rgba(240,246,252,0.1); padding: 8px 16px; border-radius: 6px; cursor: pointer; color:#fff; font-weight:bold;">Зберегти та Закрити</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("cc-modal-close").onclick = closeCrossConnectModal;
    document.getElementById("cc-modal-cancel").onclick = closeCrossConnectModal;
    
    // Clicking outside closes the modal
    modal.onclick = (e) => {
        if (e.target === modal) closeCrossConnectModal();
    };
  }
  return modal;
}

function closeCrossConnectModal() {
  const modal = document.getElementById("cross-connect-modal");
  if (modal) modal.style.display = "none";
}

// ═══════════════════════════════════════════════
//  FIBER STANDARDS
// ═══════════════════════════════════════════════
const FIBER_COLORS = [
    "#0d6efd", // 1. Blue
    "#fd7e14", // 2. Orange
    "#198754", // 3. Green
    "#8b4513", // 4. Brown
    "#6c757d", // 5. Slate/Gray
    "#ffffff", // 6. White
    "#dc3545", // 7. Red
    "#000000", // 8. Black
    "#ffc107", // 9. Yellow
    "#6f42c1", // 10. Violet
    "#d63384", // 11. Rose
    "#0dcaf0"  // 12. Aqua
];
const FIBER_NAMES = [
    "Синя", "Помаранчова", "Зелена", "Коричнева", "Сіра", "Біла",
    "Червона", "Чорна", "Жовта", "Фіолетова", "Рожева", "Бірюзова"
];

function getFiberColor(index) {
    return FIBER_COLORS[index % 12];
}
function getFiberDotHtml(index) {
    const c = getFiberColor(index);
    // Add white border to black fiber for visibility
    const border = c === "#000000" ? "border: 1px solid #c9d1d9;" : "border: 1px solid rgba(0,0,0,0.2);";
    return `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${c}; ${border} margin-right:6px;" title="${FIBER_NAMES[index % 12]}"></span>`;
}

function getSplitterColor(type, ratio, label) {
    let index = 0;
    if (label) {
        const match = label.match(/#(\d+)/);
        if (match) index = parseInt(match[1]);
    }
    
    // Bright distinct palette for splitters (avoiding reds that look like errors)
    const brightColors = [
        "#0d6efd", "#fd7e14", "#198754", "#20c997", 
        "#ffc107", "#6f42c1", "#d63384", "#0dcaf0", 
        "#3fb950", "#a371f7", "#e3b341", "#055160"
    ];

    if (index > 0) {
        let hash = 0;
        const str = `${type}_${ratio}_${index}`;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return brightColors[Math.abs(hash) % brightColors.length];
    }
    
    if (type === "PLC") {
        if (ratio === "1x2") return "#a371f7"; // Purple
        if (ratio === "1x4") return "#3fb950"; // Green
        if (ratio === "1x8") return "#d29922"; // Orange
        if (ratio === "1x16") return "#0dcaf0"; // Cyan
        if (ratio === "1x32") return "#6f42c1"; // Violet
        return "#c084fc";
    }

    if (type === "FBT") {
        const val = parseInt(ratio.split("/")[0]);
        if (!isNaN(val)) {
            if (val === 5) return "#0dcaf0"; // Aqua
            if (val === 10) return "#d63384"; // Rose
            if (val === 15) return "#fd7e14"; // Orange
            if (val === 20) return "#198754"; // Green
            if (val === 25) return "#6f42c1"; // Violet
            if (val === 30) return "#20c997"; // Teal
            if (val === 35) return "#ffc107"; // Yellow
            if (val === 40) return "#0d6efd"; // Blue
            if (val === 45) return "#a371f7"; // Purple
            if (val === 50) return "#ffffff"; // White
            
            return brightColors[(val * 3) % brightColors.length];
        }
    }
    
    return "#58a6ff"; // Default FBT Blue
}

function getSplitterIcon(type, ratio, location = "main") {
   // Location shapes: Attic/Main = ⬢ (Hexagon), Floor = ⯁ (Black Diamond)
   const locShapeIcon = location === "floor" ? "⯁" : "⬢";
   return locShapeIcon; 
}

// ═══════════════════════════════════════════════
//  OLT PATCH PANEL
// ═══════════════════════════════════════════════

export function openPatchPanel(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.type !== "OLT") return;

    const modal = createModalContainer();
    document.getElementById("cc-modal-title").innerText = `🎛️ Оптичний крос (ODF): ${node.name}`;
    document.getElementById("cc-modal-title").style.color = "#58a6ff";
    
    const body = document.getElementById("cc-modal-body");
    body.innerHTML = renderOLTPatchUI(node);

    document.getElementById("cc-modal-save").onclick = () => savePatchPanel(nodeId);
    modal.style.display = "block";
    
    // Apply labels immediately
    setTimeout(() => {
        if (typeof window.checkOltPorts === "function") window.checkOltPorts(null);
    }, 10);
}

function renderOLTPatchUI(node) {
    // Left side: PON Ports
    let inHtml = `<div style="flex: 1; border: 1px solid #30363d; border-radius: 6px; padding: 15px; background: #161b22; overflow-y: auto; overflow-x: hidden;">
        <h3 style="margin-top:0; color: #8b949e; text-align:center;">🔴 Порти PON (IN)</h3>
        <div style="display:flex; flex-direction:column; gap:10px;">
    `;
    for(let i=0; i<node.ports; i++) {
        inHtml += `<div style="background:#21262d; padding:10px; border-radius:4px; text-align:center; font-family:monospace; border:1px solid #30363d;">
            PON ${i+1}
        </div>`;
    }
    inHtml += `</div></div>`;

    // Right side: Outgoing Cables
    const outCables = conns.filter(c => c.from === node && c.type === "cable");
    let outHtml = `<div style="flex: 1; border: 1px solid #30363d; border-radius: 6px; padding: 15px; background: #161b22; overflow-y: auto; overflow-x: hidden;">
        <h3 style="margin-top:0; color: #8b949e; text-align:center;">🟢 Магістралі (OUT)</h3>
        <div style="display:flex; flex-direction:column; gap:10px;">
    `;
    if(outCables.length === 0) {
        outHtml += `<div style="text-align:center; color:#8b949e; font-style:italic;">Немає підключених магістралей</div>`;
    } else {
        outCables.forEach(c => {
            const numCores = c.capacity || 1;
            const PON_COLORS = ["#58a6ff", "#f778ba", "#56d4dd", "#b07efc", "#79c0ff", "#ff9bce", "#3dd6c8", "#d2a8ff"];
            const firstXc = (node.crossConnects || []).find(xc => xc.toType === "CABLE" && xc.toId === c.id);
            const isConnected = !!firstXc;
            
            let activeColor = "#8b949e";
            if (isConnected) {
                activeColor = c.customColor || PON_COLORS[Number(firstXc.fromId) % PON_COLORS.length];
            }
            const disabledAttr = isConnected ? "" : "disabled";
            const cursorStyle = isConnected ? "cursor:pointer" : "cursor:not-allowed; opacity:0.5";

            outHtml += `<div style="background:#21262d; padding:10px; border-radius:4px; border:1px solid #30363d;">
                <div style="font-weight:bold; margin-bottom:12px; padding-bottom:8px; border-bottom:1px dashed #30363d; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:14px; width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${c.to.name}">Вузол: <span style="color:#c9d1d9">${c.to.name}</span></span>
                    
                    <div style="display:flex; align-items:center; justify-content:flex-end; gap:10px; flex:1;">
                        <div style="display:flex; align-items:center; gap:6px; background:#0d1117; padding:2px 8px; border-radius:12px; border:1px solid #30363d;">
                            <span style="font-size:11px; color:#8b949e; text-transform:uppercase;">Колір магістралі:</span>
                            <div id="dot-color-${c.id}" style="width:12px; height:12px; border-radius:50%; background:${activeColor}; box-shadow: 0 0 4px ${activeColor};"></div>
                            
                            <span style="font-size:11px; color:#8b949e; text-transform:uppercase; margin-left:6px;">Обрати:</span>
                            <input type="color" id="picker-color-${c.id}" title="${isConnected ? 'Обрати власний колір магістралі' : 'Підключіть порт щоб обрати колір'}" 
                                   value="${activeColor}" 
                                   ${disabledAttr}
                                   data-customcolor="${c.customColor || ''}"
                                   style="background:none; border:none; width:20px; height:22px; padding:0; margin-left:2px; ${cursorStyle};" 
                                   onchange="window.updateConnColor('${c.id}', this.value, '${node.id}', 'OLT');">
                        </div>
                        
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="color:#8b949e; font-size:12px;">ЖИЛ:</span>
                            <input type="number" min="1" max="144" value="${numCores}" style="width:40px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:3px; text-align:center; padding:2px; font-weight:bold;" onchange="window.updateConnCapacity('${c.id}', this.value, '${node.id}', 'OLT');">
                        </div>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">`;
            for(let i=0; i<numCores; i++) {
                // Find existing connection if any
                const existing = (node.crossConnects || []).find(xc => xc.toId === c.id && xc.toCore === i);
                const selectedPort = existing ? existing.fromId : "";
                
                let selectHtml = `<select class="patch-select" data-cable="${c.id}" data-core="${i}" style="flex:1; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:3px; padding:2px;" onchange="window.checkOltPorts(this)">
                    <option value="">-- ВІЛЬНО --</option>`;
                
                const xcArr = node.crossConnects || [];
                const usedPons = xcArr.map(xc => parseInt(xc.fromId));

                for(let p=0; p<node.ports; p++) {
                    const isSelected = selectedPort === p;
                    const isBusy = !isSelected && usedPons.includes(p);
                    const disabledStr = isBusy ? "disabled" : "";
                    const busyStr = isBusy ? " (ЗАЙНЯТО)" : "";
                    const colorStr = isBusy ? "color:#ff5555" : "";
                    
                    selectHtml += `<option value="${p}" ${isSelected ? "selected" : ""} ${disabledStr} style="${colorStr}">PON ${p+1}${busyStr}</option>`;
                }
                selectHtml += `</select>`;
                
                outHtml += `<div style="display:flex; align-items:center; gap:10px;">
                    <div style="font-size:12px;width:70px; display:flex; align-items:center;">
                        ${getFiberDotHtml(i)} Жила ${i+1}
                    </div>
                    ${selectHtml}
                </div>`;
            }
            outHtml += `</div></div>`;
        });
    }
    outHtml += `</div></div>`;

    return inHtml + outHtml;
}

function savePatchPanel(nodeId, skipClose = false, skipGlobalRefresh = false) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const selects = document.querySelectorAll(".patch-select");
    const newCross = [];
    
    selects.forEach(sel => {
        const element = /** @type {HTMLSelectElement} */ (sel);
        if (element.value !== "") {
            newCross.push({
                id: "xc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                fromType: "PORT",
                fromId: parseInt(element.value), // PON Port index
                toType: "CABLE",
                toId: element.dataset.cable,
                toCore: parseInt(element.dataset.core)
            });
        }
    });

    node.crossConnects = newCross;
    
    if (!skipGlobalRefresh) {
        // Save state globally so Undo works
        if (typeof window.saveState === "function") window.saveState();
        if (typeof window.refreshNetworkUI === "function") window.refreshNetworkUI();
    }
    
    if (!skipClose) {
        closeCrossConnectModal();
        if (typeof window.showSelectedProps === "function") window.showSelectedProps();
    }
}

// ═══════════════════════════════════════════════
//  FOB SPLICE CASSETTE (Cross-Connect)
// ═══════════════════════════════════════════════

export function openCrossConnect(nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || (node.type !== "FOB" && node.type !== "MDU")) return;

    // FTTH MDU uses its own internal topology modal
    if (node.type === "MDU" && node.architecture === "FTTH") {
        if (typeof window.openMDUInternalTopology === "function") {
            window.openMDUInternalTopology(nodeId, { expandTransit: true });
        }
        return;
    }

    const modal = createModalContainer();
    const titlePrefix = node.type === "MDU" ? "🪛 Транзитний крос MDU" : "🪛 Касета (Зварювання)";
    const suffix = node.type === "MDU" ? ` (${node.architecture || "FTTB"})` : "";
    document.getElementById("cc-modal-title").innerText = `${titlePrefix}: ${node.name}${suffix}`;
    document.getElementById("cc-modal-title").style.color = "#c084fc";
    
    const body = document.getElementById("cc-modal-body");
    body.innerHTML = renderFOBCrossUI(node);

    document.getElementById("cc-modal-save").onclick = () => saveCrossConnect(nodeId);
    modal.style.display = "block";

    // Apply labels immediately
    setTimeout(() => {
        if (typeof window.checkFobPorts === "function") window.checkFobPorts(null);
    }, 10);
}

function getIncomingCorePath(targetFob, cableId, coreIndex) {
    let currentFob = targetFob;
    let currentCableId = cableId;
    let currentCore = coreIndex;

    while (currentFob && (currentFob.type === "FOB" || currentFob.type === "MDU")) {
        const inCable = conns.find(c => c.id === currentCableId);
        if (!inCable) break;
        
        if (inCable.from.type === "OLT") {
            const olt = inCable.from;
            const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === currentCableId && x.toCore === currentCore);
            if (oltXc) return `від OLT ${olt.name} - PON ${parseInt(String(oltXc.fromId)) + 1}`;
            return `від OLT ${olt.name} (немає кросу)`;
        }
        
        const prevInFob = inCable.from;
        if (prevInFob.type !== "FOB" && prevInFob.type !== "MDU") break;
        
        const ftthXc = prevInFob.type === "MDU" ? (prevInFob.mainBox?.crossConnects || []) : [];
        const xcList = [...(prevInFob.crossConnects || []), ...ftthXc];
        const xc = xcList.find(x => x.toType === "CABLE" && String(x.toId) === String(currentCableId) && x.toCore === currentCore);
        
        if (xc) {
            if (xc.fromType === "SPLITTER") {
                // It comes from a splitter in the previous FOB
                let spName = xc.fromId;
                const sp = (/** @type {any} */ (prevInFob).splitters || []).find(s => s.id === xc.fromId);
                if (sp) spName = `${sp.type} ${sp.ratio}`;
                else if (xc.fromId === "legacy_fbt") spName = `FBT ${/** @type {any} */ (prevInFob).fbtType}`;
                else if (xc.fromId === "legacy_plc") spName = `PLC ${/** @type {any} */ (prevInFob).plcType}`;
                
                const branchLbl = xc.fromBranch ? `(Гілка ${xc.fromBranch})` : `(Вихід ${parseInt(String(xc.fromCore||0))+1})`;
                return `від ${prevInFob.name} 👉 ${spName} ${branchLbl}`;
            } else if (xc.fromType === "CABLE") {
                // It's a transit cable, continue tracing backward
                currentFob = prevInFob;
                currentCableId = xc.fromId;
                currentCore = xc.fromCore;
            } else {
                return `від ${prevInFob.name}`;
            }
        } else {
            return `від ${prevInFob.name} (немає кросу)`;
        }
    }
    return "";
}


window.getFobSourceOptions = function(node) {
    const inCables = conns.filter(c => c.to === node && c.type === "cable");
    inCables.sort((a, b) => {
        if (!a.to && b.to) return -1;
        if (a.to && !b.to) return 1;
        return (a.to ? a.to.name : "").localeCompare(b.to ? b.to.name : "");
    });
    
    let sourceOptions = `<option value="">--- Не підключено ---</option>`;
    
    inCables.forEach(c => {
        const cores = c.capacity || 1;
        for(let i=0; i<cores; i++) {
            let sigStr = "";
            let s = null;
            if (c.from.type === "OLT") {
                const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
                if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
            } else if (c.from.type === "FOB" || c.from.type === "MDU") {
                const upstream = traceOpticalPath(/** @type {any} */ (c.from), "CABLE", c.id, i);
                if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
            }
            if (s !== null) sigStr = ` ⚡${s.toFixed(1)}дБ`;

            const pathStr = getIncomingCorePath(node, c.id, i);
            const pathLabel = pathStr ? ` [${pathStr}]` : ``;
            sourceOptions += `<option value="CABLE|${c.id}|${i}" style="color:#58a6ff" data-color="#58a6ff">◼ Вхід: ${c.from.name} - Жила ${i+1}${sigStr}${pathLabel}</option>`;
        }
    });
    const inPatchcords = conns.filter(c => c.to === node && c.type === "patchcord");
    inPatchcords.forEach(c => {
        let sigStr = "";
        let s = null;
        if (c.from.type === "FOB" || c.from.type === "MDU") {
            const upstream = traceOpticalPath(/** @type {any} */ (c.from), "PATCHCORD", c.id, 0);
            if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
        }
        if (s !== null) sigStr = ` ⚡${s.toFixed(1)}дБ`;
        sourceOptions += `<option value="PATCHCORD|${c.id}|0" style="color:#e3b341" data-color="#e3b341">● Вхід: Патчкорд від ${c.from.name}${sigStr}</option>`;
    });

    const splitters = node.splitters || [];
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

    splitters.forEach(sp => {
        const label = spLabels[sp.id];
        const color = getSplitterColor(sp.type, sp.ratio, label);
        const icon = getSplitterIcon(sp.type, sp.ratio);
        
        if (sp.type === "FBT") {
            const sx = sigSplitter(node, sp.id, "X");
            const sy = sigSplitter(node, sp.id, "Y");
            const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
            const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
            sourceOptions += `<option value="SPLITTER|${sp.id}|X" style="color:${color}" data-color="${color}">${icon} Від: ${label} (Гілка X)${sxStr}</option>`;
            sourceOptions += `<option value="SPLITTER|${sp.id}|Y" style="color:${color}" data-color="${color}">${icon} Від: ${label} (Гілка Y)${syStr}</option>`;
        } else if (sp.type === "PLC") {
            const s = sigSplitter(node, sp.id);
            const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
            const plcOuts = parseInt(sp.ratio.split("x")[1]) || 2;
            for(let i=1; i<=plcOuts; i++) {
                sourceOptions += `<option value="SPLITTER|${sp.id}|${i}" style="color:${color}" data-color="${color}">${icon} Від: ${label} (Вихід ${i})${sStr}</option>`;
            }
        }
    });

    if (node.fbtType && !splitters.some(s => s.id === "legacy_fbt")) {
        const sx = sigFBT(node, "X");
        const sy = sigFBT(node, "Y");
        const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
        const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
        const color = getSplitterColor("FBT", node.fbtType);
        const icon = getSplitterIcon("FBT", node.fbtType);
        sourceOptions += `<option value="SPLITTER|legacy_fbt|X" style="color:${color}" data-color="${color}">${icon} Від: FBT ${node.fbtType} (Гілка X)${sxStr}</option>`;
        sourceOptions += `<option value="SPLITTER|legacy_fbt|Y" style="color:${color}" data-color="${color}">${icon} Від: FBT ${node.fbtType} (Гілка Y)${syStr}</option>`;
    }
    if (node.plcType && !splitters.some(s => s.id === "legacy_plc")) {
        const s = sigPLC(node);
        const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
        const plcOuts = parseInt(node.plcType.split("x")[1]) || 2;
        const color = getSplitterColor("PLC", node.plcType);
        const icon = getSplitterIcon("PLC", node.plcType);
        for(let i=1; i<=plcOuts; i++) {
            sourceOptions += `<option value="SPLITTER|legacy_plc|${i}" style="color:${color}" data-color="${color}">${icon} Від: PLC ${node.plcType} (Вихід ${i})${sStr}</option>`;
        }
    }
    
    return sourceOptions;
};

/**
 * @param {any} node
 * @returns {string}
 */
function renderFOBCrossUI(node) {
    // Top section

    let sourceOptions = window.getFobSourceOptions(node);

    const splitters = node.splitters || [];
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

    // --- HTML Structure ---
    
    // Top: INCOMING (Full Width, Compact Grid)
    let inHtml = `<div style="border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; margin-bottom: 15px; max-height: 180px; overflow-y: auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; font-size:14px; text-align:center;">📥 Входи (IN)</h3>`;

    const inCables = conns.filter(c => c.to === node && c.type === "cable");
    inCables.sort((a, b) => {
        if (!a.to && b.to) return -1;
        if (a.to && !b.to) return 1;
        return (a.to ? a.to.name : "").localeCompare(b.to ? b.to.name : "");
    });

    inCables.forEach(c => {
        const cores = c.capacity || 1;
        inHtml += `<div style="background:#21262d; border-radius:4px; border:1px solid #30363d; margin-bottom:8px; overflow:hidden;">
            <div style="font-weight:bold; color:#58a6ff; font-size:12px; text-align:center; padding: 4px; background: #30363d;">Від: ${c.from.name}</div>
            <div style="display: grid; grid-template-columns: repeat(8, 1fr); gap: 1px; background: #30363d; border-top: 1px solid #30363d;">`;
        for(let i=0; i<cores; i++) {
            let coreSigHtml = "";
            let s = null;
            if (c.from.type === "OLT") {
                const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
                if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
            } else if (c.from.type === "FOB" || c.from.type === "MDU") {
                const upstream = traceOpticalPath(/** @type {any} */ (c.from), "CABLE", c.id, i);
                if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
            }
            if (s !== null) {
                const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
            }

            inHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:#0d1117; padding:4px 8px; font-size:11px;">
                <div style="display:flex; align-items:center;">${getFiberDotHtml(i)} Жила ${i+1}</div>
                ${coreSigHtml}
            </div>`;
        }
        
        // Pad with empty cells to ensure the grid has complete rows visually
        const remainder = cores % 8;
        if (remainder !== 0) {
            const emptyCells = 8 - remainder;
            for (let i = 0; i < emptyCells; i++) {
                inHtml += `<div style="background:#0d1117; padding:4px 8px;"></div>`;
            }
        }
        
        inHtml += `</div></div>`;
    });
    if(inCables.length===0) inHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає вхідних кабелів</div>`;
    inHtml += `</div>`;

    // Split Wrapper for Middle & Bottom
    let bottomWrapperStart = `<div style="display: flex; gap: 15px; flex: 1; overflow: hidden; min-height: 0;">`;
    
    // Middle: DEVICES (Splitters)
    let midHtml = `<div style="flex: 1; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y:auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">📦 Сплітери</h3>
        
        <div style="background:#21262d; border:1px solid #30363d; padding:10px; border-radius:6px; margin-bottom:20px;">
            <div style="font-size:12px; color:#c9d1d9; font-weight:bold; margin-bottom:6px;">🛠️ Додати новий дільник</div>
            <div style="display:flex; gap:5px; margin-bottom:5px;">
                <select id="cc-add-fbt" style="flex:1; padding:4px; font-size:11px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:3px;">
                    <option value="">+ FBT (Несиметричний)</option>
                    ${Object.keys(FBT_LOSSES).map(k => `<option value="${k}">${k}</option>`).join('')}
                </select>
                <button onclick="const v=document.getElementById('cc-add-fbt').value; if(v) window.addSplitter('${node.id}', 'FBT', v);" style="background:#2ea043; color:white; border:none; border-radius:3px; cursor:pointer; font-size:11px; padding:0 12px; font-weight:bold;">Додати</button>
            </div>
            <div style="display:flex; gap:5px;">
                <select id="cc-add-plc" style="flex:1; padding:4px; font-size:11px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:3px;">
                    <option value="">+ PLC (Симетричний)</option>
                    ${Object.keys(PLC_LOSSES).map(k => `<option value="${k}">${k}</option>`).join('')}
                </select>
                <button onclick="const v=document.getElementById('cc-add-plc').value; if(v) window.addSplitter('${node.id}', 'PLC', v);" style="background:#2ea043; color:white; border:none; border-radius:3px; cursor:pointer; font-size:11px; padding:0 12px; font-weight:bold;">Додати</button>
            </div>
        </div>`;
        
    const buildSplitterBox = (id, type, name, ratio) => {
        const existing = (node.crossConnects || []).find(xc => xc.toType === "SPLITTER" && xc.toId === id);
        const selVal = existing ? existing.fromType+"|"+existing.fromId+"|"+(existing.fromCore !== undefined ? existing.fromCore : (existing.fromBranch || "")) : "";
        
        let safeSourceOptions = sourceOptions;
        // Prevent self-loop in the option list!
        if (id !== "legacy_fbt" && id !== "legacy_plc") {
            const regex = new RegExp(`<option value="SPLITTER\\|${id}\\|[^>]+>.*?</option>`, "g");
            safeSourceOptions = safeSourceOptions.replace(regex, "");
        }
        if (id === "legacy_fbt") safeSourceOptions = safeSourceOptions.replace(/<option value="SPLITTER\|legacy_fbt[^>]+>.*?<\/option>/g, "");
        if (id === "legacy_plc") safeSourceOptions = safeSourceOptions.replace(/<option value="SPLITTER\|legacy_plc[^>]+>.*?<\/option>/g, "");
        
        const spLbl = spLabels[id] || `${type} ${ratio}`;
        let color = getSplitterColor(type, ratio, spLbl);
        
        let sOpt = safeSourceOptions;
        if (selVal) {
            sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
        } else {
            sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
        }
        
        const spTotalOuts = type === "PLC" ? parseInt((ratio || "1x2").split("x")[1] || 2) : 2;
        
        const delBtnHtml = id !== "legacy_fbt" && id !== "legacy_plc" 
            ? `<button onclick="window.removeSplitter('${node.id}', '${id}')" style="background:transparent; border:none; color:#f85149; cursor:pointer; font-size:14px; padding:0; display:flex; align-items:center;" title="Видалити цей дільник">✕</button>` 
            : "";

        return `<div style="background:#21262d; padding:8px; border-radius:4px; border:1px solid #30363d; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; gap:8px;">
                <div style="display:flex; align-items:center; gap:8px; flex-shrink:0; padding-top:4px;">
                    <b style="color:${color}; font-size:12px; white-space:nowrap;">${getSplitterIcon(type, ratio, "main")} ${spLbl}</b>
                    ${delBtnHtml}
                </div>
                <div style="display:flex; flex-direction:column; flex:1; min-width:0; align-items:flex-end;">
                    <span style="font-size:10px; color:#8b949e; margin-bottom:2px;">Вхід (IN):</span>
                    <select class="fob-cross" data-totype="SPLITTER" data-toid="${id}" data-targetname="${name}" style="width:100%; max-width:100%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;" onchange="window.checkFobPorts(this, '${node.id}')">
                        ${sOpt}
                    </select>
                </div>
            </div>
            <div class="splitter-progress-bar" data-spid="${id}" data-total="${spTotalOuts}"></div>
        </div>`;
    };

    splitters.forEach(sp => {
        midHtml += buildSplitterBox(sp.id, sp.type, spLabels[sp.id], sp.ratio);
    });

    if (node.fbtType && !splitters.some(s => s.id === "legacy_fbt")) midHtml += buildSplitterBox("legacy_fbt", "FBT", `FBT (${node.fbtType})`, node.fbtType);
    if (node.plcType && !splitters.some(s => s.id === "legacy_plc")) midHtml += buildSplitterBox("legacy_plc", "PLC", `PLC (${node.plcType})`, node.plcType);
    
    if(splitters.length === 0 && !node.fbtType && !node.plcType) midHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає сплітерів. Змініть властивості FOB.</div>`;
    midHtml += `</div>`;

    // Right: OUTGOING
    const outCables = conns.filter(c => c.from === node && c.type === "cable");
    const outPatchcords = conns.filter(c => c.from === node && c.type === "patchcord");
    const outConns = [...outCables, ...outPatchcords];
    outConns.sort((a, b) => {
        if (a.type === "cable" && b.type !== "cable") return -1;
        if (a.type !== "cable" && b.type === "cable") return 1;
        return (a.to ? a.to.name : "").localeCompare(b.to ? b.to.name : "");
    });

    let outHtml = `<div style="flex: 1; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y:auto; overflow-x:hidden;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">📤 Виходи (OUT)</h3>`;
    
    outConns.forEach(c => {
        const cores = c.capacity || 1;
        outHtml += `<div style="background:#21262d; padding:8px; border-radius:4px; border:1px solid #30363d; margin-bottom:8px;">
            <div style="font-weight:bold; color:#3fb950; margin-bottom:6px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                <span>До: ${c.to ? c.to.name : "?"} <span style="color:#8b949e;font-size:10px">(${c.type === "cable" ? "Кабель" : "Патчкорд"})</span></span>
                <div style="display:flex; gap:6px; align-items:center;">
                    ${c.type === "cable" ? `<button title="З'єднати вільні жили транзитом 1-до-1" style="cursor:pointer; background:#2ea043; border:none; color:#fff; border-radius:3px; padding:2px 6px; font-size:10px;" onclick="window.autoTransit('${c.id}', '${node.id}')">Транзит</button>` : ""}
                    ${c.type === "cable" ? `<span style="color:#8b949e; font-size:12px;">Жил: <input type="number" min="1" max="144" value="${cores}" style="width:40px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d;" onchange="window.updateConnCapacity('${c.id}', this.value, '${node.id}', 'FOB');"></span>` : ""}
                </div>
            </div>`;
        if (c.type === "cable") {
            for(let i=0; i<cores; i++) {
                // Determine pre-selected value
                let selVal = "";
                let existing = (node.crossConnects || []).find(xc => xc.toType === "CABLE" && xc.toId === c.id && xc.toCore === i);
                if (existing) selVal = existing.fromType+"|"+existing.fromId+"|"+(existing.fromCore !== undefined ? existing.fromCore : (existing.fromBranch || ""));

                let sOpt = sourceOptions;
                if (selVal) {
                    sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
                } else {
                    sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
                }

                outHtml += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <div style="font-size:11px; width:65px; display:flex; align-items:center;">
                        ${getFiberDotHtml(i)} Жила ${i+1}
                    </div>
                    <select class="fob-cross" data-totype="CABLE" data-toid="${c.id}" data-tocore="${i}" data-targetname="${c.to ? c.to.name : 'Кабель'}" style="flex:1; min-width:0; width:100%; max-width:100%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px;" onchange="window.checkFobPorts(this, '${node.id}')">
                        ${sOpt}
                    </select>
                </div>`;
            }
        } else if (c.type === "patchcord") {
            // Determine pre-selected value
            let selVal = "";
            let existing = (node.crossConnects || []).find(xc => xc.toType === "PATCHCORD" && xc.toId === c.id);
            if (existing) selVal = existing.fromType+"|"+existing.fromId+"|"+(existing.fromCore !== undefined ? existing.fromCore : (existing.fromBranch || ""));

            let sOpt = sourceOptions;
            if (selVal) {
                sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
            } else {
                sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
            }

            outHtml += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <div style="font-size:11px; width:65px; display:flex; align-items:center;">
                    <div style="width:8px;height:8px;border-radius:50%;background:#ffd700;margin-right:6px;box-shadow:0 0 3px #ffd700;"></div> Патчкорд
                </div>
                <select class="fob-cross" data-totype="PATCHCORD" data-toid="${c.id}" data-targetname="${c.to ? c.to.name : 'Юніт'}" style="flex:1; min-width:0; width:100%; max-width:100%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px;" onchange="window.checkFobPorts(this, '${node.id}')">
                    ${sOpt}
                </select>
            </div>`;
        }
        outHtml += `</div>`;
    });
    if(outConns.length===0 && node.type !== "MDU") outHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає підключених виходів</div>`;
    
    // --- LOCAL UPLINK for MDU (FTTB) ---
    if (node.type === "MDU") {
        const localXc = (node.crossConnects || []).find(xc => xc.toType === "LOCAL");
        let selVal = "";
        if (localXc) selVal = localXc.fromType+"|"+localXc.fromId+"|"+(localXc.fromCore !== undefined ? localXc.fromCore : (localXc.fromBranch || ""));
        
        let sOpt = sourceOptions;
        if (selVal) {
            sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
        } else {
            sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
        }
        
        outHtml += `<div style="background:#1a2332; padding:8px; border-radius:4px; border:1px solid #1f6feb; margin-bottom:8px; margin-top:8px;">
            <div style="font-weight:bold; color:#58a6ff; margin-bottom:6px; font-size:12px; display:flex; align-items:center; gap:6px;">
                <span style="font-size:16px;">🏠</span> Локальний uplink (цей будинок)
            </div>
            <div style="font-size:10px; color:#8b949e; margin-bottom:6px;">Оберіть джерело сигналу для FTTB обладнання цього MDU</div>
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="font-size:11px; width:65px; display:flex; align-items:center;">
                    <div style="width:8px;height:8px;border-radius:50%;background:#58a6ff;margin-right:6px;box-shadow:0 0 3px #58a6ff;"></div> Uplink
                </div>
                <select class="fob-cross" data-totype="LOCAL" data-toid="self" data-targetname="Локальний uplink" style="flex:1; min-width:0; width:100%; max-width:100%; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; background:#0d1117; color:#c9d1d9; border:1px solid #1f6feb; font-size:11px;" onchange="window.checkFobPorts(this, '${node.id}')">
                    ${sOpt}
                </select>
            </div>
        </div>`;
        
        if(outConns.length===0) outHtml += `<div style="text-align:center;color:#8b949e;font-size:12px; margin-top:8px;">Немає підключених транзитних виходів</div>`;
    }
    
    outHtml += `</div>`;
    
    let bottomWrapperEnd = `</div>`;

    return `<div style="display: flex; flex-direction: column; flex: 1;">` + inHtml + bottomWrapperStart + midHtml + outHtml + bottomWrapperEnd + `</div>`;
}

function saveCrossConnect(nodeId, skipClose = false, skipGlobalRefresh = false) {
    try {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;

        const selects = document.querySelectorAll(".fob-cross");
        const newCross = [];
        
        selects.forEach(sel => {
            const element = /** @type {HTMLSelectElement} */ (sel);
            if (element.value !== "") {
                const [fromType, fromId, fromCoreOrBranch] = element.value.split("|");
                const toType = element.dataset.totype;
                const toId = element.dataset.toid;
                
                let xc = {
                    id: "xc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                    fromType,
                    fromId,
                    toType,
                    toId
                };
                
                // Assign specific branches/cores based on type
                if (fromType === "CABLE") xc.fromCore = parseInt(fromCoreOrBranch);
                if (fromType === "SPLITTER" && isNaN(parseInt(fromCoreOrBranch))) xc.fromBranch = fromCoreOrBranch; // "X" or "Y"
                else if (fromType === "SPLITTER") xc.fromCore = parseInt(fromCoreOrBranch); // 1..N PLC logic
                
                if (toType === "CABLE") xc.toCore = parseInt(element.dataset.tocore);
                
                newCross.push(xc);
            }
        });

        node.crossConnects = newCross;
        
        if (!skipGlobalRefresh) {
            // Trigger UI updates
            if (typeof window.saveState === "function") window.saveState();
            if (typeof window.refreshNetworkUI === "function") {
                try { 
                    window.refreshNetworkUI(); 
                } catch (e) { 
                    console.error("UI refresh error:", e); 
                }
            }
        }
        
        if (!skipClose) {
            closeCrossConnectModal();
            if (typeof window.showSelectedProps === "function") window.showSelectedProps();
        }
    } catch (err) {
        console.error("Error saving cross connect", err);
        alert("Помилка збереження: " + err.message);
    }
}
window.saveCrossConnect = saveCrossConnect;

window.updateConnColor = function(connId, newColor, nodeId, nodeType) {
    const c = conns.find(x => x.id === connId);
    if (!c) return;
    c.color = newColor;
    c.customColor = newColor;
    if (c.polyline) c.polyline.setStyle({ color: newColor });
    
    const picker = document.getElementById(`picker-color-${connId}`);
    if (picker) {
        picker.dataset.customcolor = newColor;
    }
    if (typeof window.checkOltPorts === "function") window.checkOltPorts(null);

    window.refreshNetworkUI();
    window.saveState();
}

window.updateConnCapacity = function(connId, newCap, nodeId, nodeType) {
    const c = conns.find(x => x.id === connId);
    if (!c) return;
    
    let cap = parseInt(newCap);
    if (isNaN(cap) || cap < 1) cap = 1;
    if (cap > 144) cap = 144;
    c.capacity = cap;
    
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    if (nodeType === "OLT") {
        savePatchPanel(nodeId, true, true);
        document.getElementById("cc-modal-body").innerHTML = renderOLTPatchUI(node);
        if (typeof window.checkOltPorts === "function") window.checkOltPorts(null);
    } else {
        saveCrossConnect(nodeId, true, true);
        document.getElementById("cc-modal-body").innerHTML = renderFOBCrossUI(node);
        if (typeof window.checkFobPorts === "function") window.checkFobPorts(null);
    }
};

window.checkOltPorts = function(selectElement) {
    /** @type {NodeListOf<HTMLSelectElement>} */
    const allSelects = document.querySelectorAll(".patch-select");
    const selEl = /** @type {HTMLSelectElement} */ (selectElement);
    
    // 1. Clear duplicates if this was a new selection
    if (selEl && selEl.value !== "") {
        let duplicateFound = false;
        allSelects.forEach(sel => {
            if (sel !== selEl && sel.value === selEl.value) {
                sel.value = ""; // Clear the previous selection of this PON port
                duplicateFound = true;
            }
        });
        if (duplicateFound) {
            selEl.style.border = "1px solid #dc3545"; // Flash red
            setTimeout(() => selEl.style.border = "1px solid #30363d", 1000);
        }
    }

    // 2. Re-evaluate all dropdowns to update disabled/busy states dynamically
    const usedVals = new Set();
    allSelects.forEach(sel => {
        if (sel.value !== "") usedVals.add(sel.value);
    });

    allSelects.forEach(sel => {
        const options = sel.querySelectorAll("option");
        options.forEach(opt => {
            if (opt.value === "") return; // Skip -- ВІЛЬНО --
            const pVal = parseInt(opt.value);
            
            if (opt.value === sel.value) {
                // This is the currently selected option in this dropdown
                opt.disabled = false;
                opt.textContent = `PON ${pVal + 1}`;
                opt.style.color = "";
            } else if (usedVals.has(opt.value)) {
                // This PON is used by SOME OTHER dropdown
                opt.disabled = false; // ALLOW reassignment
                opt.textContent = `PON ${pVal + 1} (ЗАЙНЯТО)`;
                opt.style.color = "#ff5555";
            } else {
                // This PON is free
                opt.disabled = false;
                opt.textContent = `PON ${pVal + 1}`;
                opt.style.color = "";
            }
        });
    });

    // 3. Dynamically update cable colors in UI based on current selections
    const PON_COLORS = ["#58a6ff", "#f778ba", "#56d4dd", "#b07efc", "#79c0ff", "#ff9bce", "#3dd6c8", "#d2a8ff"];
    const cablesMap = {};
    allSelects.forEach(sel => {
        const cableId = sel.dataset.cable;
        if (!cablesMap[cableId]) cablesMap[cableId] = { isConnected: false, ports: [] };
        if (sel.value !== "") {
            cablesMap[cableId].isConnected = true;
            cablesMap[cableId].ports.push(parseInt(sel.value));
        }
    });

    Object.keys(cablesMap).forEach(cableId => {
        const info = cablesMap[cableId];
        const dot = document.getElementById(`dot-color-${cableId}`);
        const picker = /** @type {HTMLInputElement} */ (document.getElementById(`picker-color-${cableId}`));
        
        if (dot && picker) {
            let activeColor = "#8b949e";
            if (info.isConnected) {
                const firstPort = info.ports[0]; // first valid port
                const customColor = picker.dataset.customcolor;
                activeColor = customColor || PON_COLORS[firstPort % PON_COLORS.length];
                picker.disabled = false;
                picker.style.cursor = "pointer";
                picker.style.opacity = "1";
                picker.title = "Обрати власний колір магістралі";
            } else {
                picker.disabled = true;
                picker.style.cursor = "not-allowed";
                picker.style.opacity = "0.5";
                picker.title = "Підключіть порт щоб обрати колір";
            }
            dot.style.background = activeColor;
            dot.style.boxShadow = `0 0 4px ${activeColor}`;
            picker.value = activeColor;
        }
    });
};

window.checkFobPorts = function(selectElement, passedNodeId) {
    /** @type {NodeListOf<HTMLSelectElement>} */
    const allSelects = document.querySelectorAll(".fob-cross");
    const selEl = /** @type {HTMLSelectElement} */ (selectElement);

    if (passedNodeId && selEl) {
        // Quietly save cross connects to recalculate optical signals correctly
        if (typeof window.saveCrossConnect === "function") window.saveCrossConnect(passedNodeId, true, true);
        const node = nodes.find(n => n.id === passedNodeId);
        if (node && typeof window.getFobSourceOptions === "function") {
            const newOptsHtml = window.getFobSourceOptions(node);
            allSelects.forEach(sel => {
                const currentVal = sel.value;
                let targetOpts = newOptsHtml;
                if (sel.dataset.totype === "SPLITTER") {
                    const spId = sel.dataset.toid;
                    const regex = new RegExp(`<option value="SPLITTER\\|${spId}\\|[^>]+>.*?</option>`, "g");
                    targetOpts = targetOpts.replace(regex, "");
                }
                sel.innerHTML = targetOpts;
                sel.value = currentVal;
            });
        }
    }
    
    // 1. Clear duplicates if this was a new selection
    if (selEl && selEl.value !== "") {
        let duplicateFound = false;
        allSelects.forEach(sel => {
            if (sel !== selEl && sel.value === selEl.value) {
                sel.value = ""; // Clear previous selection
                duplicateFound = true;
            }
        });
        if (duplicateFound) {
            selEl.style.border = "1px solid #dc3545"; // Flash red
            setTimeout(() => selEl.style.border = "1px solid #30363d", 1000);
        }
    }

    // 2. Re-evaluate all dropdowns to update disabled/busy states dynamically
    const usedVals = new Set();
    allSelects.forEach(sel => {
        if (sel.value !== "") usedVals.add(sel.value);
    });

    allSelects.forEach(sel => {
        const options = sel.querySelectorAll("option");
        options.forEach(opt => {
            if (opt.value === "") return; // Skip -- Не підключено --
            
            // Clean up the text content if it already has (ЗАЙНЯТО) or [Зайнято: ...]
            let baseText = opt.textContent.replace(/ \[(Зайнято|Використовується):.*?\]|\s*\(ЗАЙНЯТО\)/g, "");
            
            if (opt.value === sel.value) {
                // Currently selected here
                opt.disabled = false;
                opt.textContent = baseText;
                opt.style.color = opt.dataset.color || "";
            } else if (usedVals.has(opt.value)) {
                // Used SOMEWHERE ELSE
                let usingSelect = Array.from(allSelects).find(s => s !== sel && s.value === opt.value);
                let usingName = usingSelect ? usingSelect.getAttribute("data-targetname") : "Іншим";
                
                opt.disabled = false; // ALLOW reassignment ("stealing" connection visually, logic applied on save)
                opt.textContent = baseText + ` [Зайнято: ${usingName}]`;
                opt.style.color = "#ff5555";
            } else {
                // Free
                opt.disabled = false;
                opt.textContent = baseText;
                opt.style.color = opt.dataset.color || "";
            }
        });
    });

    // 3. Update Splitter Progress Bars
    if (!window.renderSplitterProgressBar) {
        window.renderSplitterProgressBar = function(used, total) {
            const isFull = used >= total;
            const over = used > total;
            let html = `<div style="display:flex; justify-content:space-between; margin-bottom:4px; margin-top:8px;">
                <span style="font-size:10px; color:#c9d1d9;">Виходи (OUT):</span>
                <span style="font-size:10px; color:${over?'#ff5555':(isFull?'#d29922':'#8b949e')}; font-weight:bold;">${used} / ${total}</span>
            </div>
            <div style="display:flex; height:6px; background:#0d1117; border-radius:3px; overflow:hidden; border:1px solid #30363d;">`;
            
            const blocks = Math.max(total, used);
            for(let i=0; i<blocks; i++) {
                let isUsed = i < used;
                let isOverLimit = i >= total;
                let bg = isOverLimit ? "#ff5555" : (isUsed ? (isFull ? "#d29922" : "#32cd32") : "transparent");
                let br = i < blocks - 1 ? "border-right:1px solid #30363d;" : "";
                html += `<div style="flex:1; background:${bg}; ${br} transition:background 0.3s;"></div>`;
            }
            html += `</div>`;
            if (over) html += `<div style="font-size:9px; color:#ff5555; margin-top:4px;">⚠️ Перевищено ліміт виходів!</div>`;
            return html;
        };
    }

    const spUsedCounts = {};
    allSelects.forEach(sel => {
        if (sel.value && sel.value.startsWith("SPLITTER|")) {
            const spId = sel.value.split("|")[1];
            spUsedCounts[spId] = (spUsedCounts[spId] || 0) + 1;
        }
    });

    document.querySelectorAll(".splitter-progress-bar").forEach(e => {
        const el = /** @type {HTMLElement} */ (e);
        const spId = el.dataset.spid;
        const total = parseInt(el.dataset.total || "2");
        if (spId && window.renderSplitterProgressBar) el.innerHTML = window.renderSplitterProgressBar(spUsedCounts[spId] || 0, total);
    });
};

window.autoTransit = function(outCableId, nodeId) {
    try {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        
        // Auto-map Core 0 to Core 0, Core 1 to Core 1 from the first incoming cable
        const inCables = conns.filter(c => c.to === node && c.type === "cable");
        if (inCables.length === 0) {
            alert("Немає вхідних кабелів для транзиту!");
            return;
        }
        
        // Keep existing config so we don't overwrite splitters
        saveCrossConnect(nodeId, true);
        
        const outCable = conns.find(c => c.id === outCableId);
        if (!outCable) return;
        
        let cross = node.crossConnects || [];
        const inCable = inCables[0]; // Take the main trunk
        
        const inCap = inCable.capacity || 1;
        const outCap = outCable.capacity || 1;
        
        let transferred = 0;
        let inIdx = 0;
        let outIdx = 0;
        
        // Find first free out core, find first free in core, link them.
        while (inIdx < inCap && outIdx < outCap) {
            const inUsed = cross.find(xc => xc.fromType === "CABLE" && xc.fromId === inCable.id && xc.fromCore === inIdx);
            if (inUsed) {
                inIdx++;
                continue;
            }
            
            const outUsed = cross.find(xc => xc.toType === "CABLE" && xc.toId === outCableId && xc.toCore === outIdx);
            if (outUsed) {
                outIdx++;
                continue;
            }
            
            // Both are free, map them
            cross.push({
                id: "xc_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
                fromType: "CABLE",
                fromId: inCable.id,
                fromCore: inIdx,
                toType: "CABLE",
                toId: outCableId,
                toCore: outIdx
            });
            transferred++;
            inIdx++;
            outIdx++;
        }
        
        if (transferred === 0) {
            console.log("Усі жили вже зайняті або вже протранзичені.");
        }
        
        node.crossConnects = cross;
        document.getElementById("cc-modal-body").innerHTML = renderFOBCrossUI(node);
        
        // Make sure to re-evaluate the progress bars after the new HTML is injected!
        setTimeout(() => {
            if (typeof window.checkFobPorts === "function") window.checkFobPorts(null);
        }, 10);
        
    } catch (e) {
        console.error("Auto Transit error:", e);
    }
};

// Register globals for onclick injection
window.openPatchPanel = openPatchPanel;
window.openCrossConnect = openCrossConnect;
