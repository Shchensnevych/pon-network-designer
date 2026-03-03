import { nodes, conns } from "./state.js";
import { FIBER_DB_KM } from "./config.js";
import { traceOpticalPath, sigSplitter, getMduSig, connKm } from "./signal.js";

// ═══════════════════════════════════════════════
//  FIBER STANDARDS
// ═══════════════════════════════════════════════
const FIBER_COLORS = [
    "#0d6efd", "#fd7e14", "#198754", "#8b4513", "#6c757d", "#ffffff",
    "#dc3545", "#000000", "#ffc107", "#6f42c1", "#d63384", "#0dcaf0"
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
    const border = c === "#000000" ? "border: 1px solid #c9d1d9;" : "border: 1px solid rgba(0,0,0,0.2);";
    return `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${c}; ${border} margin-right:6px;" title="${FIBER_NAMES[index % 12]}"></span>`;
}

function getIncomingCorePath(targetMdu, cableId, coreIndex) {
    let currentFob = targetMdu;
    let currentCableId = cableId;
    let currentCore = coreIndex;

    while (currentFob) {
        const inCable = conns.find(c => c.id === currentCableId);
        if (!inCable) break;
        
        if (inCable.from.type === "OLT") {
            const olt = inCable.from;
            const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === currentCableId && x.toCore === currentCore);
            if (oltXc) return `OLT ${olt.name} - PON ${parseInt(String(oltXc.fromId)) + 1}`;
            return `OLT ${olt.name} (без кросу)`;
        }
        
        const prevFob = inCable.from;
        if (prevFob.type !== "FOB") break;
        
        const xc = (prevFob.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === currentCableId && x.toCore === currentCore);
        
        if (xc) {
            if (xc.fromType === "SPLITTER") {
                let spName = xc.fromId;
                const sp = (prevFob.splitters || []).find(s => s.id === xc.fromId);
                if (sp) spName = `${sp.type} ${sp.ratio}`;
                else if (xc.fromId === "legacy_fbt") spName = `FBT ${prevFob.fbtType}`;
                else if (xc.fromId === "legacy_plc") spName = `PLC ${prevFob.plcType}`;
                
                const branchLbl = xc.fromBranch ? `(X${xc.fromBranch})` : `(Out ${parseInt(String(xc.fromCore||0))+1})`;
                return `${prevFob.name} 👉 ${spName} ${branchLbl}`;
            } else if (xc.fromType === "CABLE") {
                currentFob = prevFob;
                currentCableId = xc.fromId;
                currentCore = xc.fromCore;
            } else {
                return `${prevFob.name}`;
            }
        } else {
            return `${prevFob.name} (без кросу)`;
        }
    }
    return "";
}

export function getSplitterColor(type, ratio, label) {
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
        if (ratio === "1x16") return "#0dcaf0"; // Cyan (replaced red)
        if (ratio === "1x32") return "#6f42c1"; // Violet (replaced dark red)
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
            if (val === 30) return "#20c997"; // Teal (replaced red)
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

// Modal HTML generation
function createMDUModalContainer() {
  let modal = document.getElementById("mdu-topology-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "mdu-topology-modal";
    modal.style.cssText = `
      display: none; position: fixed; z-index: 10000; left: 0; top: 0; width: 100%; height: 100%;
      background-color: rgba(0,0,0,0.85);
    `;
    modal.innerHTML = `
      <div style="background-color: #0d1117; margin: 2% auto; padding: 20px; border: 1px solid #30363d; border-radius: 8px; width: 85%; max-width: 1200px; color: #c9d1d9; font-family: sans-serif; height: 85vh; display: flex; flex-direction: column;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #30363d; padding-bottom: 10px; margin-bottom: 10px;">
          <h2 id="mdu-modal-title" style="margin: 0; color: #58a6ff;">Внутрішня топологія багатоквартирного будинку (FTTH)</h2>
          <span id="mdu-modal-close" style="color: #8b949e; float: right; font-size: 28px; font-weight: bold; cursor: pointer;">&times;</span>
        </div>
        <div id="mdu-modal-body" style="flex: 1; overflow-y: hidden; display: flex; flex-direction: column; gap: 15px;">
            <!-- UI populated dynamically -->
        </div>
        <div style="border-top: 1px solid #30363d; padding-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
            <button id="mdu-modal-cancel" class="btn" style="background:#21262d; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; cursor: pointer; color:#c9d1d9;">Скасувати</button>
            <button id="mdu-modal-save" class="btn" style="background:#238636; border: 1px solid rgba(240,246,252,0.1); padding: 8px 16px; border-radius: 6px; cursor: pointer; color:#fff; font-weight:bold;">Зберегти та Закрити</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("mdu-modal-close").onclick = closeMDUModal;
    document.getElementById("mdu-modal-cancel").onclick = closeMDUModal;
    
    // Clicking outside closes the modal
    modal.onclick = (e) => {
        if (e.target === modal) closeMDUModal();
    };
  }
  return modal;
}

function closeMDUModal() {
  const modal = document.getElementById("mdu-topology-modal");
  if (modal) modal.style.display = "none";
}

let currentMDUId = null;

// ═══════════════════════════════════════════════
//  MAIN RENDERER
// ═══════════════════════════════════════════════

export function openMDUInternalTopology(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node || node.type !== "MDU") return;
  
  currentMDUId = nodeId;
  
  // Ensure architecture properties exist
  if (!node.mainBox) node.mainBox = { splitters: [], crossConnects: [] };
  if (!node.floorBoxes) node.floorBoxes = [];
  
  const modal = createMDUModalContainer();
  document.getElementById("mdu-modal-title").innerText = `Внутрішня топологія: ${node.name} (FTTH)`;
  
  renderMDUUI(node);
  
  document.getElementById("mdu-modal-save").onclick = () => {
      saveMDUState(node);
      closeMDUModal();
      if (typeof window.saveState === "function") window.saveState();
      if (typeof window.updateStats === "function") window.updateStats();
  };
  
  modal.style.display = "block";
}

function renderMDUUI(node) {
    const inConns = conns.filter(c => c.to === node && (c.type === "cable" || c.type === "patchcord"));
    
    // Left: Incoming Cores
    let sourceOptions = `<option value="">--- Не підключено ---</option>`;
    
    // Top: INCOMING (Full Width, Compact Grid)
    let inHtml = `<div style="border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; margin-bottom: 15px; max-height: 180px; overflow-y: auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; font-size:14px; text-align:center;">📥 Входи (IN)</h3>`;
    
    inConns.forEach(c => {
        const cores = c.capacity || 1;
        const typeLabel = c.type === "cable" ? "Кабель" : "Патчкорд";
        inHtml += `<div style="background:#21262d; border-radius:4px; border:1px solid #30363d; margin-bottom:8px; overflow:hidden;">
            <div style="font-weight:bold; color:#58a6ff; font-size:12px; text-align:center; padding: 4px; background: #30363d;">Від: ${c.from.name} (${typeLabel})</div>
            <div style="display: grid; grid-template-columns: repeat(8, 1fr); gap: 1px; background: #30363d; border-top: 1px solid #30363d;">`;
            
            if (c.type === "cable") {
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
                    if(s !== null) sigStr = ` ⚡${s.toFixed(1)}дБ`;

                    const pathStr = getIncomingCorePath(node, c.id, i);
                    const pathLabel = pathStr ? ` [${pathStr}]` : ``;
                    
                    sourceOptions += `<option value="CABLE|${c.id}|${i}" style="color:#58a6ff" data-color="#58a6ff">◼ Вхід: ${c.from.name} - Жила ${i+1}${sigStr}${pathLabel}</option>`;
                    
                    let coreSigHtml = "";
                    if (s !== null) {
                        const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                        coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
                    }

                    inHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:#0d1117; padding:4px 8px; font-size:11px;">
                        <div style="display:flex; align-items:center;">${getFiberDotHtml(i)} Жила ${i+1}</div>
                        ${coreSigHtml}
                    </div>`;
                }
            
            const remainder = cores % 8;
            if (remainder !== 0) {
                const emptyCells = 8 - remainder;
                for (let i = 0; i < emptyCells; i++) {
                    inHtml += `<div style="background:#0d1117; padding:4px 8px;"></div>`;
                }
            }
        } else if (c.type === "patchcord") {
            let sigStr = "";
            let coreSigHtml = "";
            if (c.from.type === "FOB") {
                const upstream = traceOpticalPath(c.from, "PATCHCORD", c.id, 0);
                if (upstream !== null) {
                    let s = upstream - (connKm(c) * FIBER_DB_KM);
                    const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                    coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
                    sigStr = ` ⚡${s.toFixed(1)}дБ`;
                }
            }
            sourceOptions += `<option value="PATCHCORD|${c.id}|0" style="color:#e3b341" data-color="#e3b341">● Вхід: Патчкорд від ${c.from.name}${sigStr}</option>`;
            
            inHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:#0d1117; padding:4px 8px; font-size:11px; grid-column: 1 / -1;">
                <div style="display:flex; align-items:center;">
                    <div style="width:8px;height:8px;border-radius:50%;background:#ffd700;margin-right:6px;box-shadow:0 0 3px #ffd700;"></div> Патчкорд
                </div>
                ${coreSigHtml}
            </div>`;
        }
        inHtml += `</div></div>`;
    });
    if (inConns.length === 0) inHtml += `<div style="font-size:12px; color:#8b949e; text-align:center;">Немає вхідних ліній</div>`;
    inHtml += `</div>`;
    
    // Split Wrapper for Middle & Bottom
    let bottomWrapperStart = `<div style="display: flex; gap: 15px; flex: 1; overflow: hidden; min-height: 0;">`;

    // Center: Attic (Main Box)
    let atticHtml = `<div style="flex: 1.5; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y: auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">🏢 Горище (Головні дільники)</h3>`;
        
    atticHtml += `<div style="margin-bottom:10px; display:flex; gap:5px;">
        <select id="mdu-attic-sp-type" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:12px; padding:4px;">
            <option value="PLC 1x2">PLC 1x2</option>
            <option value="PLC 1x4">PLC 1x4</option>
            <option value="PLC 1x8">PLC 1x8</option>
            <option value="PLC 1x16">PLC 1x16</option>
            <option value="PLC 1x32">PLC 1x32</option>
            <option value="FBT 10/90">FBT 10/90</option>
            <option value="FBT 50/50">FBT 50/50</option>
        </select>
        <button onclick="window.addMDUSplitter('${node.id}', 'main')" style="background:#2ea043; border:none; color:white; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;">+ Додати</button>
    </div>`;
    
    // Group splitters to enumerate them
    const allSplitters = [...node.mainBox.splitters];
    node.floorBoxes.forEach(fb => allSplitters.push(...fb.splitters));
    
    const spCounts = {};
    const spLabels = {};
    allSplitters.forEach(sp => {
        const key = `${sp.type}_${sp.ratio}`;
        spCounts[key] = (spCounts[key] || 0) + 1;
    });

    const spCurrent = {};
    allSplitters.forEach(sp => {
        const key = `${sp.type}_${sp.ratio}`;
        if (spCounts[key] > 1) {
            spCurrent[key] = (spCurrent[key] || 0) + 1;
            spLabels[sp.id] = `${sp.type} ${sp.ratio} #${spCurrent[key]}`;
        } else {
            spLabels[sp.id] = `${sp.type} ${sp.ratio}`;
        }
    });

    // Make attic splitters available as sources
    node.mainBox.splitters.forEach(sp => {
        const label = spLabels[sp.id];
        const color = getSplitterColor(sp.type, sp.ratio, label);
        const icon = getSplitterIcon(sp.type, sp.ratio, "main");
        
        if (sp.type === "PLC") {
            const ratio = parseInt(sp.ratio.split('x')[1]) || 2;
            for(let i=1; i<=ratio; i++) {
                const s = getMduSig(node, "spOut", sp.id + "|" + i);
                const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
                const basetext = `${icon} Горище: ${label} (Вихід ${i})`;
                sourceOptions += `<option value="SPLITTER|${sp.id}|${i}" style="color:${color}" data-color="${color}" data-basetext="${basetext}">${basetext}${sStr}</option>`;
            }
        } else if (sp.type === "FBT") {
            const sx = getMduSig(node, "spOut", sp.id + "|X");
            const sy = getMduSig(node, "spOut", sp.id + "|Y");
            const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
            const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
            const baseX = `${icon} Горище: ${label} (X)`;
            const baseY = `${icon} Горище: ${label} (Y)`;
            sourceOptions += `<option value="SPLITTER|${sp.id}|X" style="color:${color}" data-color="${color}" data-basetext="${baseX}">${baseX}${sxStr}</option>`;
            sourceOptions += `<option value="SPLITTER|${sp.id}|Y" style="color:${color}" data-color="${color}" data-basetext="${baseY}">${baseY}${syStr}</option>`;
        }
    });

    node.mainBox.splitters.forEach(sp => {
        const xc = node.mainBox.crossConnects.find(x => x.toType === "SPLITTER" && x.toId === sp.id);
        const selVal = xc ? `${xc.fromType}|${xc.fromId}|${xc.fromCore !== undefined ? xc.fromCore : (xc.fromBranch || "")}` : "";
        
        let sOpt = sourceOptions;
        if (selVal) {
            sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
        } else {
            sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
        }
        
        // Prevent self-looping
        sOpt = sOpt.replace(new RegExp(`<option value="SPLITTER\\|${sp.id}\\|[^>]+>.*?<\\\/option>`, "g"), "");

        const spLbl = spLabels[sp.id];
        const spColor = getSplitterColor(sp.type, sp.ratio, spLbl);
        let s = getMduSig(node, "spIn", sp.id);
        const sigText = s !== null ? s.toFixed(1) : "";
        
        atticHtml += `<div style="background:#21262d; padding:10px; border-radius:4px; border:1px solid #30363d; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <b style="color:${spColor}; font-size:12px;">${getSplitterIcon(sp.type, sp.ratio, 'main')} ${spLbl}<span id="sp-sig-${sp.id}" style="font-size:10px; color:#3fb950; font-weight:normal;">${sigText ? " ⚡ " + sigText + " дБ" : ""}</span></b>
                <span onclick="window.removeMDUSplitter('${node.id}', 'main', '${sp.id}')" style="color:#f85149; cursor:pointer; font-size:12px;" title="Видалити">✖</span>
            </div>
            <div style="font-size:11px; margin-bottom:4px; color:#c9d1d9">Вхід (IN):</div>
            <select class="mdu-cross-select mdu-cross-main" data-id="${sp.id}" data-targetname="Головний ${spLbl}" style="width:100%; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;" onchange="window.checkMDUPorts(this, '${node.id}')">
                ${sOpt}
            </select>
            <div class="splitter-progress-bar" data-spid="${sp.id}" data-total="${sp.type === 'PLC' ? (parseInt((sp.ratio || '1x2').split('x')[1]) || 2) : 2}"></div>
        </div>`;
    });
    atticHtml += `</div>`;

    // Right: Floors (Secondary Boxes)
    let floorHtml = `<div style="flex: 1.5; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y: auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">🚪 Поверхи (Вторинні дільники)</h3>`;

    // Pre-build Flat Source Options
    let flatSourceOptions = sourceOptions;


    node.floorBoxes.forEach(fb => {
        fb.splitters.forEach(sp => {
            const label = spLabels[sp.id];
            const color = getSplitterColor(sp.type, sp.ratio, label);
            const icon = getSplitterIcon(sp.type, sp.ratio, "floor");
            
            if(sp.type === "FBT") {
                 const sx = getMduSig(node, "spOut", sp.id + "|X");
                 const sy = getMduSig(node, "spOut", sp.id + "|Y");
                 const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
                 const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
                 const baseX = `${icon} Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${label} (X)`;
                 const baseY = `${icon} Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${label} (Y)`;
                 flatSourceOptions += `<option value="SPLITTER|${sp.id}|X" style="color:${color}" data-color="${color}" data-basetext="${baseX}">${baseX}${sxStr}</option>`;
                 flatSourceOptions += `<option value="SPLITTER|${sp.id}|Y" style="color:${color}" data-color="${color}" data-basetext="${baseY}">${baseY}${syStr}</option>`;
            } else {
                const outs = parseInt(sp.ratio.split("x")[1]) || 2;
                for(let i=1; i<=outs; i++) {
                    const s = getMduSig(node, "spOut", sp.id + "|" + i);
                    const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
                    const basetext = `${icon} Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${label} (Вихід ${i})`;
                    flatSourceOptions += `<option value="SPLITTER|${sp.id}|${i}" style="color:${color}" data-color="${color}" data-basetext="${basetext}">${basetext}${sStr}</option>`;
                }
            }
        });
    });

    const floorsMap = {}; // Group by Entrance, then Floor
    for (let e = 1; e <= node.entrances; e++) {
        floorsMap[e] = {};
        for (let f = node.floors; f >= 1; f--) {
            floorsMap[e][f] = [];
        }
    }
    
    // Assign splitters to their designated floor/entrance buckets
    node.floorBoxes.forEach(fb => {
        if (!floorsMap[fb.entrance]) floorsMap[fb.entrance] = {};
        if (!floorsMap[fb.entrance][fb.floor]) floorsMap[fb.entrance][fb.floor] = [];
        floorsMap[fb.entrance][fb.floor].push(fb);
    });

    let activeTabAttr = document.getElementById("mdu-topology-modal")?.getAttribute("data-activetab");
    let activeEntrance = activeTabAttr ? parseInt(activeTabAttr) : 1;
    if (activeEntrance > node.entrances) activeEntrance = 1;

    let tabsHtml = `<div class="mdu-tabs-container" style="display:flex; border-bottom:1px solid #30363d; margin-bottom:0px; overflow-x:auto;">`;
    Object.keys(floorsMap).forEach(entStr => {
        const entrance = parseInt(entStr);
        const firstFlat = (entrance - 1) * (node.floors * node.flatsPerFloor) + 1;
        const lastFlat = firstFlat + (node.floors * node.flatsPerFloor) - 1;
        let connectedCount = 0;
        if (node.flats) {
            connectedCount = node.flats.filter(f => f.flat >= firstFlat && f.flat <= lastFlat && f.crossConnect).length;
        }
        const totalFlats = node.floors * node.flatsPerFloor;
        const isActive = entrance === activeEntrance;
        const bg = isActive ? "#21262d" : "#0d1117";
        const border = isActive ? "1px solid #30363d" : "1px solid transparent";
        const borderBot = isActive ? "1px solid #21262d" : "1px solid #30363d";
        const color = isActive ? "#58a6ff" : "#8b949e";
        
        tabsHtml += `<div id="mdu-tab-btn-${entrance}" class="mdu-tab-btn" onclick="window.switchMDUTab(${entrance})" style="padding:8px 16px; cursor:pointer; background:${bg}; border-top:${border}; border-left:${border}; border-right:${border}; border-bottom:${borderBot}; border-radius:6px 6px 0 0; color:${color}; font-size:13px; font-weight:bold; white-space:nowrap; margin-bottom:-1px; z-index:${isActive?2:1}; position:relative; transition: background 0.2s;">Під'їзд ${entrance} (<span id="mdu-tab-count-${entrance}">${connectedCount}</span>/${totalFlats})</div>`;
    });
    tabsHtml += `<div style="flex:1; border-bottom:1px solid #30363d;"></div></div>`;
    
    floorHtml += tabsHtml;
    floorHtml += `<div style="background:#21262d; border:1px solid #30363d; border-top:none; border-radius:0 0 4px 4px; padding:12px; margin-bottom:10px; min-height: 200px;">`;

    Object.keys(floorsMap).forEach(entStr => {
        const entrance = parseInt(entStr);
        const isHidden = entrance !== activeEntrance ? "display:none;" : "display:block;";
        floorHtml += `<div id="mdu-entrance-block-${entrance}" class="mdu-entrance-content" style="${isHidden}">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px dashed #30363d; padding-bottom:6px;">
                <div style="font-weight:bold; color:#8b949e; font-size:11px; text-transform:uppercase;">Карта підключень під'їзду</div>
                <div style="display:flex; gap:4px;">
                    <select id="mdu-addsp-f-${entrance}" style="background:#161b22; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;">`;
        for(let f=node.floors; f>=1; f--) floorHtml += `<option value="${f}">Поверх ${f}</option>`;
        floorHtml += `      </select>
                    <select id="mdu-addsp-t-${entrance}" style="background:#161b22; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;">
                        <option value="PLC 1x4">PLC 1x4</option>
                        <option value="PLC 1x8">PLC 1x8</option>
                        <option value="PLC 1x16">PLC 1x16</option>
                    </select>
                    <button onclick="window.addMDUSplitter('${node.id}', 'floor', ${entrance})" style="background:#2ea043; border:none; color:white; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:10px;">+ Додати</button>
                </div>
            </div>`;
        
        const fMap = floorsMap[entStr];
        Object.keys(fMap).sort((a,b)=>parseInt(b)-parseInt(a)).forEach(floorStr => {
            const floorNum = parseInt(floorStr);
            floorHtml += `<div style="background:#11151d; margin-bottom:12px; padding:10px; border:1px solid #30363d; border-radius:4px; border-left: 3px solid #58a6ff;">
                <div style="font-weight:bold; color:#58a6ff; font-size:13px; margin-bottom:8px; border-bottom:1px solid #30363d; padding-bottom:4px;">Поверх ${floorNum}</div>`;
                
            fMap[floorStr].forEach(fb => {
                fb.splitters.forEach(sp => {
                    const xc = fb.crossConnects.find(x => x.toType === "SPLITTER" && x.toId === sp.id);
                    const selVal = xc ? `${xc.fromType}|${xc.fromId}|${xc.fromCore !== undefined ? xc.fromCore : (xc.fromBranch || "")}` : "";
                    
                    let sOpt = sourceOptions;
                    if (selVal) {
                        sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
                    } else {
                        sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
                    }
                    
                    sOpt = sOpt.replace(new RegExp(`<option value="SPLITTER\\|${sp.id}\\|[^>]+>.*?<\\\/option>`, "g"), "");

                    const spLbl = spLabels[sp.id];
                    const spColor = getSplitterColor(sp.type, sp.ratio, spLbl);
                    let s = getMduSig(node, "spIn", sp.id);
                    const sigText = s !== null ? s.toFixed(1) : "";

                    floorHtml += `<div style="background:#21262d; padding:8px; border-radius:4px; border:1px solid #30363d; margin-bottom:6px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="font-size:11px; font-weight:bold; color:${spColor}">${getSplitterIcon(sp.type, sp.ratio, 'floor')} ${spLbl}<span id="sp-sig-${sp.id}" style="font-size:10px; color:#3fb950; font-weight:normal;">${sigText ? " ⚡ " + sigText + " дБ" : ""}</span></span>
                            <span onclick="window.removeMDUSplitter('${node.id}', 'floor', '${sp.id}', ${floorNum}, ${entrance})" style="color:#f85149; cursor:pointer; font-size:12px;" title="Видалити">✖</span>
                        </div>
                        <select class="mdu-cross-select mdu-cross-floor" data-floor="${floorNum}" data-entrance="${entrance}" data-id="${sp.id}" data-targetname="Поверх ${floorNum} Під'їзд ${entrance} ${spLbl}" style="width:100%; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:10px; padding:2px;" onchange="window.checkMDUPorts(this, '${node.id}')">
                            ${sOpt}
                        </select>
                        <div class="splitter-progress-bar" data-spid="${sp.id}" data-total="${sp.type === 'PLC' ? (parseInt((sp.ratio || '1x2').split('x')[1]) || 2) : 2}"></div>
                    </div>`;
                });
            });
            
            // Generate Flats for this exact Entrance and Floor
            const firstFlat = (entrance - 1) * (node.floors * node.flatsPerFloor) + (floorNum - 1) * node.flatsPerFloor + 1;
            const flatsOnFloor = node.flatsPerFloor;
            
            floorHtml += `<div style="margin-top:8px; padding-top:6px;">
                <div style="font-size:11px; color:#8b949e; margin-bottom:6px; text-transform:uppercase; font-weight:bold;">Квартири:</div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px;">`;
                
            for(let flatNum = firstFlat; flatNum < firstFlat + flatsOnFloor; flatNum++) {
                const flatConn = (node.flats || []).find(f => f.flat === flatNum);
                const selVal = (flatConn && flatConn.crossConnect) ? `${flatConn.crossConnect.fromType}|${flatConn.crossConnect.fromId}|${flatConn.crossConnect.fromCore !== undefined ? flatConn.crossConnect.fromCore : (flatConn.crossConnect.fromBranch || "")}` : "";
                
                let flatSigText = "";
                if (flatConn && flatConn.crossConnect && flatConn.crossConnect.fromType === "SPLITTER") {
                    let port = flatConn.crossConnect.fromCore !== undefined ? flatConn.crossConnect.fromCore : (flatConn.crossConnect.fromBranch || "1");
                    let s = getMduSig(node, "spOut", flatConn.crossConnect.fromId + "|" + port);
                    if (s !== null) {
                        flatSigText = s.toFixed(1);
                    }
                }
                
                let sOpt = flatSourceOptions;
                if (selVal) {
                    sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
                } else {
                    sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
                }
                
                floorHtml += `<div style="background:#0d1117; padding:4px; border:1px solid #30363d; border-radius:3px; font-size:10px; display:flex; flex-direction:column; gap:2px;">
                    <span style="color:#d29922; font-weight:bold;">Кв. ${flatNum} <span id="flat-sig-${flatNum}" style="color:#3fb950; font-weight:normal;">${flatSigText ? "⚡ " + flatSigText + " дБ" : ""}</span></span>
                    <select class="mdu-cross-select mdu-cross-flat" data-flat="${flatNum}" data-targetname="Кв. ${flatNum}" style="width:100%; background:#161b22; color:#c9d1d9; border:1px solid #30363d; font-size:9px; padding:1px;" onchange="window.checkMDUPorts(this, '${node.id}')">
                        ${sOpt}
                    </select>
                </div>`;
            }
            
            floorHtml += `</div></div></div>`; // End Floor Block
        });
        floorHtml += `</div>`; // End Entrance Block
    });
    
    floorHtml += `</div>`; // Close min-height wrapper
    floorHtml += `</div>`; // Close overall Right container

    let bottomWrapperEnd = `</div>`;

    const body = document.getElementById("mdu-modal-body");
    body.innerHTML = `<div style="display:flex; flex-direction:column; gap:15px; height: 100%; overflow:hidden;">
        ${inHtml}
        ${bottomWrapperStart}
            ${atticHtml}
            ${floorHtml}
        ${bottomWrapperEnd}
    </div>`;

    // Apply validation styling right away
    setTimeout(() => {
        if (typeof window.checkMDUPorts === "function") window.checkMDUPorts(null, node.id);
    }, 10);
}

function saveMDUState(node) {
    // Collect from Attic
    const mainSelects = document.querySelectorAll(".mdu-cross-main");
    node.mainBox.crossConnects = [];
    mainSelects.forEach(sel => {
        const element = /** @type {HTMLSelectElement} */ (sel);
        if(element.value) {
            const parts = element.value.split("|"); // e.g. CABLE|1234|0
            node.mainBox.crossConnects.push({
                id: "xc_m_" + Date.now() + Math.random().toString(36).substr(2, 4),
                fromType: parts[0] === "CABLE" ? "CABLE" : "SPLITTER",
                fromId: parts[1],
                fromCore: parts[0]==="CABLE" ? parseInt(parts[2]) : undefined,
                fromBranch: parts[0]==="SPLITTER" ? parts[2] : undefined,
                toType: "SPLITTER",
                toId: element.dataset.id
            });
        }
    });

    // Collect from Floors
    const floorSelects = document.querySelectorAll(".mdu-cross-floor");
    node.floorBoxes.forEach(fb => fb.crossConnects = []);
    floorSelects.forEach(sel => {
        const element = /** @type {HTMLSelectElement} */ (sel);
        if(element.value) {
            const floorNum = parseInt(element.dataset.floor);
            const fb = node.floorBoxes.find(b => b.floor === floorNum);
            if(fb) {
                const parts = element.value.split("|");
                fb.crossConnects.push({
                    id: "xc_f_" + Date.now() + Math.random().toString(36).substr(2, 4),
                    fromType: parts[0] === "CABLE" ? "CABLE" : "SPLITTER",
                    fromId: parts[1],
                    fromCore: parts[0]==="CABLE" ? parseInt(parts[2]) : undefined,
                    fromBranch: parts[0]==="SPLITTER" ? parts[2] : undefined,
                    toType: "SPLITTER",
                    toId: element.dataset.id
                });
            }
        }
    });

    // Collect from Flats
    const flatSelects = document.querySelectorAll(".mdu-cross-flat");
    node.flats = [];
    flatSelects.forEach(sel => {
        const element = /** @type {HTMLSelectElement} */ (sel);
        if(element.value) {
            const flatNum = parseInt(element.dataset.flat);
            const parts = element.value.split("|");
            node.flats.push({
                flat: flatNum,
                crossConnect: {
                    id: "xc_a_" + Date.now() + Math.random().toString(36).substr(2, 4),
                    fromType: parts[0] === "CABLE" ? "CABLE" : "SPLITTER",
                    fromId: parts[1],
                    fromCore: parts[0]==="CABLE" ? parseInt(parts[2]) : undefined,
                    fromBranch: parts[0]==="SPLITTER" ? parts[2] : undefined,
                    toType: "UNIT",
                    toId: `flat_${flatNum}`
                }
            });
        }
    });
}

// Ensure the UI commands are exposed to the window
export function initMDUWindowCommands() {
    window.switchMDUTab = (entrance) => {
        document.querySelectorAll('.mdu-entrance-content').forEach(e => {
            const el = /** @type {HTMLElement} */ (e);
            el.style.display = 'none';
        });
        const block = /** @type {HTMLElement} */ (document.getElementById(`mdu-entrance-block-${entrance}`));
        if(block) block.style.display = 'block';
        
        document.querySelectorAll('.mdu-tab-btn').forEach(e => {
            const btn = /** @type {HTMLElement} */ (e);
            btn.style.background = '#0d1117';
            btn.style.border = '1px solid transparent';
            btn.style.borderBottom = '1px solid #30363d';
            btn.style.color = '#8b949e';
            btn.style.zIndex = '1';
        });
        const activeBtn = /** @type {HTMLElement} */ (document.getElementById(`mdu-tab-btn-${entrance}`));
        if(activeBtn) {
            activeBtn.style.background = '#21262d';
            activeBtn.style.border = '1px solid #30363d';
            activeBtn.style.borderBottom = '1px solid #21262d';
            activeBtn.style.color = '#58a6ff';
            activeBtn.style.zIndex = '2';
        }
        
        const modal = document.getElementById("mdu-topology-modal");
        if(modal) modal.setAttribute("data-activetab", entrance.toString());
    };

    window.addMDUSplitter = (nodeId, location, entranceOverride = null) => {
        const node = nodes.find(n => n.id === nodeId);
        if(!node || node.type !== "MDU") return;
        
        saveMDUState(node); // Retain unsaved dropdown states before redraw
        
        if (location === "main") {
            const el = /** @type {HTMLSelectElement} */ (document.getElementById("mdu-attic-sp-type"));
            const val = el ? el.value : "PLC 1x4";
            const [typeStr, ratio] = val.split(" ");
            node.mainBox.splitters.push({
                id: "sp_" + Date.now() + Math.random().toString(36).substr(2, 4),
                type: /** @type {"FBT"|"PLC"} */ (typeStr),
                ratio: ratio
            });
        } else if (location === "floor") {
            const entranceNum = entranceOverride !== null ? entranceOverride : 1;
            const elType = /** @type {HTMLSelectElement} */ (document.getElementById(`mdu-addsp-t-${entranceNum}`));
            const elFloor = /** @type {HTMLSelectElement} */ (document.getElementById(`mdu-addsp-f-${entranceNum}`));
            
            const val = elType ? elType.value : "PLC 1x4";
            const floorNum = elFloor ? parseInt(elFloor.value) : 1;
            const [typeStr, ratio] = val.split(" ");
            
            let fb = node.floorBoxes.find(b => b.floor === floorNum && b.entrance === entranceNum);
            if (!fb) {
                fb = { floor: floorNum, entrance: entranceNum, splitters: [], crossConnects: [] };
                node.floorBoxes.push(fb);
            }
            
            fb.splitters.push({
                id: "sp_" + Date.now() + Math.random().toString(36).substr(2, 4),
                type: /** @type {"FBT"|"PLC"} */ (typeStr),
                ratio: ratio
            });
        }
        renderMDUUI(node);
    };

    window.removeMDUSplitter = (nodeId, location, spId, floorNum = null, entranceNum = null) => {
        const node = nodes.find(n => n.id === nodeId);
        if(!node || node.type !== "MDU") return;
        
        if (!confirm("Ви впевнені, що хочете видалити цей дільник?")) return;
        
        saveMDUState(node);
        
        if (location === "main") {
            node.mainBox.splitters = node.mainBox.splitters.filter(s => s.id !== spId);
            node.mainBox.crossConnects = node.mainBox.crossConnects.filter(x => x.toId !== spId && x.fromId !== spId);
            
            // Cascaded delete for floors that used this main splitter
            node.floorBoxes.forEach(fb => {
                fb.crossConnects = fb.crossConnects.filter(x => x.fromId !== spId);
            });
            
        } else if (location === "floor" && floorNum !== null && entranceNum !== null) {
            const fb = node.floorBoxes.find(b => b.floor === floorNum && b.entrance === entranceNum);
            if (fb) {
                fb.splitters = fb.splitters.filter(s => s.id !== spId);
                fb.crossConnects = fb.crossConnects.filter(x => x.toId !== spId && x.fromId !== spId);
            }
        }
        renderMDUUI(node);
    };
}

window.checkMDUPorts = function(selectElement, nodeId = null) {
    /** @type {NodeListOf<HTMLSelectElement>} */
    const allSelects = document.querySelectorAll(".mdu-cross-select");
    const selEl = /** @type {HTMLSelectElement} */ (selectElement);
    
    // 1. Clear duplicates if this was a new selection (Stealing logic)
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

    // Prepare node and save new connection state before recalculating signals
    const node = nodeId ? nodes.find(n => n.id === nodeId) : null;
    if (node && node.type === "MDU") {
        saveMDUState(node);
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
            
            let baseText = opt.getAttribute("data-basetext") || opt.textContent.replace(/ \[(Зайнято|Використовується):.*?\]|\s*\(ЗАЙНЯТО\)/g, "");
            let sigStr = "";
            
            if (opt.value && opt.value.startsWith("SPLITTER|")) {
                const parts = opt.value.split("|");
                const s = node ? getMduSig(node, "spOut", parts[1] + "|" + parts[2]) : null;
                if (s !== null) {
                    sigStr = ` ⚡${s.toFixed(1)}дБ`;
                }
            }
            
            const fullText = baseText + sigStr;
            
            if (opt.value === sel.value) {
                // Currently selected here
                opt.disabled = false;
                opt.textContent = fullText;
                opt.style.color = opt.dataset.color || "";
            } else if (usedVals.has(opt.value)) {
                // Used SOMEWHERE ELSE
                let usingSelect = Array.from(allSelects).find(s => s !== sel && s.value === opt.value);
                let usingName = usingSelect ? usingSelect.getAttribute("data-targetname") : "Іншим";
                
                opt.disabled = false; // ALLOW reassignment ("stealing")
                opt.textContent = fullText + ` [Зайнято: ${usingName}]`;
                opt.style.color = "#ff5555";
            } else {
                // Free
                opt.disabled = false;
                opt.textContent = fullText;
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
        if (spId && window.renderSplitterProgressBar) {
            el.innerHTML = window.renderSplitterProgressBar(spUsedCounts[spId] || 0, total);
        }
    });

    if (node && node.type === "MDU") {
        const allSpIds = [...(node.mainBox.splitters||[]).map(s=>s.id)];
        (node.floorBoxes||[]).forEach(fb => fb.splitters.forEach(s=>allSpIds.push(s.id)));
        allSpIds.forEach(spId => {
            let s = getMduSig(node, "spIn", spId);
            const el = document.getElementById(`sp-sig-${spId}`);
            if (el) el.innerHTML = s !== null ? ` ⚡ ${s.toFixed(1)} дБ` : "";
        });
        (node.flats||[]).forEach(f => {
            let s = null;
            if (f.crossConnect && f.crossConnect.fromType === "SPLITTER") {
                let port = f.crossConnect.fromCore !== undefined ? f.crossConnect.fromCore : (f.crossConnect.fromBranch || "1");
                s = getMduSig(node, "spOut", f.crossConnect.fromId + "|" + port);
            }
            const el = document.getElementById(`flat-sig-${f.flat}`);
            if (el) el.innerHTML = s !== null ? `⚡ ${s.toFixed(1)} дБ` : "";
        });
        
        // Update entrance tabs connecting counts dynamically
        for (let e = 1; e <= node.entrances; e++) {
            const firstFlat = (e - 1) * (node.floors * node.flatsPerFloor) + 1;
            const lastFlat = firstFlat + (node.floors * node.flatsPerFloor) - 1;
            let connectedCount = 0;
            if (node.flats) {
                connectedCount = node.flats.filter(f => f.flat >= firstFlat && f.flat <= lastFlat && f.crossConnect).length;
            }
            const el = document.getElementById(`mdu-tab-count-${e}`);
            if (el) el.textContent = connectedCount.toString();
        }
    }
};
