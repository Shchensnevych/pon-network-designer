import { nodes, conns } from "./state.js";
import { FIBER_DB_KM } from "./config.js";
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
            outHtml += `<div style="background:#21262d; padding:10px; border-radius:4px; border:1px solid #30363d;">
                <div style="font-weight:bold; margin-bottom:8px; display:flex; justify-content:space-between;">
                    <span>Вузол: ${c.to.name}</span>
                    <span style="color:#8b949e; font-size:12px;">Жил: <input type="number" min="1" max="144" value="${numCores}" style="width:40px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d;" onchange="window.updateConnCapacity('${c.id}', this.value, '${node.id}', 'OLT');"></span>
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

function savePatchPanel(nodeId, skipClose = false) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const selects = document.querySelectorAll(".patch-select");
    const newCross = [];
    
    selects.forEach(sel => {
        /** @type {HTMLSelectElement} */
        const element = (sel);
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
    
    // Save state globally so Undo works
    if (typeof window.saveState === "function") window.saveState();
    if (typeof window.refreshNetworkUI === "function") window.refreshNetworkUI();
    
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
    if (!node || node.type !== "FOB") return;

    const modal = createModalContainer();
    document.getElementById("cc-modal-title").innerText = `🪛 Сварка (Касета): ${node.name}`;
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

    while (currentFob && currentFob.type === "FOB") {
        const inCable = conns.find(c => c.id === currentCableId);
        if (!inCable) break;
        
        if (inCable.from.type === "OLT") {
            const olt = inCable.from;
            const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === currentCableId && x.toCore === currentCore);
            if (oltXc) return `від OLT PON ${parseInt(oltXc.fromId) + 1}`;
            return `від OLT (немає кросу)`;
        }
        
        const prevFob = inCable.from;
        if (prevFob.type !== "FOB") break;
        
        const xc = (prevFob.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === currentCableId && x.toCore === currentCore);
        if (xc && xc.fromType === "CABLE") {
            currentFob = prevFob;
            currentCableId = xc.fromId;
            currentCore = xc.fromCore;
        } else {
            break;
        }
    }
    return "";
}

function renderFOBCrossUI(node) {
    const inCables = conns.filter(c => c.to === node && c.type === "cable");
    const outConns = conns.filter(c => c.from === node && (c.type === "cable" || c.type === "patchcord"));
    
    // We will build options for routing sources:
    // 1. Cables IN -> Cores
    // 2. Splitters -> Output Branches (X, Y or 1..N)
    
    // Gather all possible incoming sources for dropdowns
    // Start with a default empty option
    let sourceOptions = `<option value="">--- Не підключено ---</option>`;
    
    // Cables in
    inCables.forEach(c => {
        const cores = c.capacity || 1;
        for(let i=0; i<cores; i++) {
            let sigStr = "";
            let s = null;
            if (c.from.type === "OLT") {
                const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
                if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
            } else if (c.from.type === "FOB") {
                const upstream = traceOpticalPath(c.from, "CABLE", c.id, i);
                if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
            }
            if (s !== null) sigStr = ` ⚡${s.toFixed(1)}дБ`;

            const pathStr = getIncomingCorePath(node, c.id, i);
            const pathLabel = pathStr ? ` [${pathStr}]` : ``;
            sourceOptions += `<option value="CABLE|${c.id}|${i}">🟦 Вхід: ${c.from.name} - Жила ${i+1}${sigStr}${pathLabel}</option>`;
        }
    });

    // Group splitters by type & ratio to enumerate them
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
        if (sp.type === "FBT") {
            const sx = sigSplitter(node, sp.id, "X");
            const sy = sigSplitter(node, sp.id, "Y");
            const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
            const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
            sourceOptions += `<option value="SPLITTER|${sp.id}|X">🔀 Від: ${label} (Гілка X)${sxStr}</option>`;
            sourceOptions += `<option value="SPLITTER|${sp.id}|Y">🔀 Від: ${label} (Гілка Y)${syStr}</option>`;
        } else if (sp.type === "PLC") {
            const s = sigSplitter(node, sp.id);
            const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
            const plcOuts = parseInt(sp.ratio.split("x")[1]) || 2;
            for(let i=1; i<=plcOuts; i++) {
                sourceOptions += `<option value="SPLITTER|${sp.id}|${i}">📊 Від: ${label} (Вихід ${i})${sStr}</option>`;
            }
        }
    });

    // Include legacy splitters for now: FBT and PLC if they exist.
    if (node.fbtType && !splitters.some(s => s.id === "legacy_fbt")) {
        const sx = sigFBT(node, "X");
        const sy = sigFBT(node, "Y");
        const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
        const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
        sourceOptions += `<option value="SPLITTER|legacy_fbt|X">🔀 Від: FBT ${node.fbtType} (Гілка X)${sxStr}</option>`;
        sourceOptions += `<option value="SPLITTER|legacy_fbt|Y">🔀 Від: FBT ${node.fbtType} (Гілка Y)${syStr}</option>`;
    }
    if (node.plcType && !splitters.some(s => s.id === "legacy_plc")) {
        const s = sigPLC(node);
        const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
        const plcOuts = parseInt(node.plcType.split("x")[1]) || 2;
        for(let i=1; i<=plcOuts; i++) {
            sourceOptions += `<option value="SPLITTER|legacy_plc|${i}">📊 Від: PLC ${node.plcType} (Вихід ${i})${sStr}</option>`;
        }
    }

    // --- HTML Structure ---
    
    // Left: INCOMING
    let inHtml = `<div style="flex: 0.7; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y:auto; overflow-x:hidden;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">📥 Входи (IN)</h3>`;
    inCables.forEach(c => {
        const cores = c.capacity || 1;
        inHtml += `<div style="background:#21262d; padding:8px; border-radius:4px; border:1px solid #30363d; margin-bottom:8px;">
            <div style="font-weight:bold; color:#58a6ff; margin-bottom:6px; font-size:12px;">Від: ${c.from.name}</div>`;
        for(let i=0; i<cores; i++) {
            let coreSigHtml = "";
            let s = null;
            if (c.from.type === "OLT") {
                const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
                if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
            } else if (c.from.type === "FOB") {
                const upstream = traceOpticalPath(c.from, "CABLE", c.id, i);
                if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
            }
            if (s !== null) {
                const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
            }

            inHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:12px;">
                <div style="display:flex; align-items:center;">${getFiberDotHtml(i)} Жила ${i+1}</div>
                ${coreSigHtml}
            </div>`;
        }
        inHtml += `</div>`;
    });
    if(inCables.length===0) inHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає вхідних кабелів</div>`;
    inHtml += `</div>`;

    // Middle: DEVICES (Splitters)
    let midHtml = `<div style="flex: 1.4; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y:auto; overflow-x:hidden;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">📦 Сплітери</h3>`;
        
    const buildSplitterBox = (id, type, name) => {
        const existing = (node.crossConnects || []).find(xc => xc.toType === "SPLITTER" && xc.toId === id);
        const selVal = existing ? existing.fromType+"|"+existing.fromId+"|"+(existing.fromCore !== undefined ? existing.fromCore : (existing.fromBranch || "")) : "";
        
        let safeSourceOptions = sourceOptions;
        // Prevent self-loop in the option list!
        if (id !== "legacy_fbt" && id !== "legacy_plc") {
            const regex = new RegExp(`<option value="SPLITTER\\|${id}\\|[^>]+>.*?<\\\/option>`, "g");
            safeSourceOptions = safeSourceOptions.replace(regex, "");
        }
        if (id === "legacy_fbt") safeSourceOptions = safeSourceOptions.replace(/<option value="SPLITTER\|legacy_fbt[^>]+>.*?<\/option>/g, "");
        if (id === "legacy_plc") safeSourceOptions = safeSourceOptions.replace(/<option value="SPLITTER\|legacy_plc[^>]+>.*?<\/option>/g, "");
        
        let sOpt = safeSourceOptions;
        if (selVal) {
            sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
        } else {
            sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
        }
        
        return `<div style="background:#21262d; padding:10px; border-radius:4px; border:1px solid #30363d; margin-bottom:10px;">
            <div style="font-weight:bold; color:#58a6ff; margin-bottom:6px;">${name}</div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:12px;">Вхід (IN):</span>
                <select class="fob-cross" data-totype="SPLITTER" data-toid="${id}" data-targetname="${name}" style="flex:1; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px;" onchange="window.checkFobPorts(this)">
                    ${sOpt}
                </select>
            </div>
        </div>`;
    };

    splitters.forEach(sp => {
        midHtml += buildSplitterBox(sp.id, sp.type, spLabels[sp.id]);
    });

    if (node.fbtType && !splitters.some(s => s.id === "legacy_fbt")) midHtml += buildSplitterBox("legacy_fbt", "FBT", `FBT (${node.fbtType})`);
    if (node.plcType && !splitters.some(s => s.id === "legacy_plc")) midHtml += buildSplitterBox("legacy_plc", "PLC", `PLC (${node.plcType})`);
    
    if(splitters.length === 0 && !node.fbtType && !node.plcType) midHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає сплітерів. Змініть властивості FOB.</div>`;
    midHtml += `</div>`;

    // Right: OUTGOING
    let outHtml = `<div style="flex: 1.9; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y:auto; overflow-x:hidden;">
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
                    <select class="fob-cross" data-totype="CABLE" data-toid="${c.id}" data-tocore="${i}" data-targetname="${c.to ? c.to.name : 'Кабель'}" style="flex:1; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px;" onchange="window.checkFobPorts(this)">
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
                <select class="fob-cross" data-totype="PATCHCORD" data-toid="${c.id}" data-targetname="${c.to ? c.to.name : 'Юніт'}" style="flex:1; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px;" onchange="window.checkFobPorts(this)">
                    ${sOpt}
                </select>
            </div>`;
        }
        outHtml += `</div>`;
    });
    if(outConns.length===0) outHtml += `<div style="text-align:center;color:#8b949e;font-size:12px">Немає підключених виходів</div>`;
    outHtml += `</div>`;

    return inHtml + midHtml + outHtml;
}

function saveCrossConnect(nodeId, skipClose = false) {
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
        
        // Trigger UI updates
        if (typeof window.saveState === "function") window.saveState();
        if (typeof window.refreshNetworkUI === "function") {
            try { 
                window.refreshNetworkUI(); 
            } catch (e) { 
                console.error("UI refresh error:", e); 
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
        savePatchPanel(nodeId, true);
        document.getElementById("cc-modal-body").innerHTML = renderOLTPatchUI(node);
        if (typeof window.checkOltPorts === "function") window.checkOltPorts(null);
    } else {
        saveCrossConnect(nodeId, true);
        document.getElementById("cc-modal-body").innerHTML = renderFOBCrossUI(node);
        if (typeof window.checkFobPorts === "function") window.checkFobPorts(null);
    }
};

window.checkOltPorts = function(selectElement) {
    const allSelects = document.querySelectorAll(".patch-select");
    
    // 1. Clear duplicates if this was a new selection
    if (selectElement && selectElement.value !== "") {
        let duplicateFound = false;
        allSelects.forEach(sel => {
            if (sel !== selectElement && sel.value === selectElement.value) {
                sel.value = ""; // Clear the previous selection of this PON port
                duplicateFound = true;
            }
        });
        if (duplicateFound) {
            selectElement.style.border = "1px solid #dc3545"; // Flash red
            setTimeout(() => selectElement.style.border = "1px solid #30363d", 1000);
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
};

window.checkFobPorts = function(selectElement) {
    const allSelects = document.querySelectorAll(".fob-cross");
    
    // 1. Clear duplicates if this was a new selection
    if (selectElement && selectElement.value !== "") {
        let duplicateFound = false;
        allSelects.forEach(sel => {
            if (sel !== selectElement && sel.value === selectElement.value) {
                sel.value = ""; // Clear previous selection
                duplicateFound = true;
            }
        });
        if (duplicateFound) {
            selectElement.style.border = "1px solid #dc3545"; // Flash red
            setTimeout(() => selectElement.style.border = "1px solid #30363d", 1000);
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
                opt.style.color = "";
            } else if (usedVals.has(opt.value)) {
                // Used SOMEWHERE ELSE
                let usingSelect = Array.from(allSelects).find(s => s !== sel && s.value === opt.value);
                let usingName = usingSelect ? usingSelect.getAttribute("data-targetname") : "Іншим";
                
                opt.disabled = false; // ALLOW reassignment
                opt.textContent = baseText + ` [Зайнято: ${usingName}]`;
                opt.style.color = "#ff5555";
            } else {
                // Free
                opt.disabled = false;
                opt.textContent = baseText;
                opt.style.color = "";
            }
        });
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
    } catch (e) {
        console.error("Auto Transit error:", e);
    }
};

// Register globals for onclick injection
window.openPatchPanel = openPatchPanel;
window.openCrossConnect = openCrossConnect;
