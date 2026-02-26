import { nodes, conns } from "./state.js";
import { FIBER_DB_KM } from "./config.js";
import { traceOpticalPath, sigSplitter, connKm } from "./signal.js";

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
            if (oltXc) return `OLT ${olt.name} - PON ${parseInt(oltXc.fromId) + 1}`;
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
                
                const branchLbl = xc.fromBranch ? `(X${xc.fromBranch})` : `(Out ${parseInt(xc.fromCore||0)+1})`;
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
                let coreSigHtml = "";
                let s = null;
                if (c.from.type === "OLT") {
                    const oltXc = (c.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === c.id && x.toCore === i);
                    if (oltXc) s = c.from.outputPower - (connKm(c) * FIBER_DB_KM);
                } else if (c.from.type === "FOB") {
                    const upstream = traceOpticalPath(c.from, "CABLE", c.id, i);
                    if (upstream !== null) s = upstream - (connKm(c) * FIBER_DB_KM);
                }
                
                let sigStr = "";
                if (s !== null) {
                    const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                    coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
                    sigStr = ` ⚡${s.toFixed(1)}дБ`;
                }

                const pathStr = getIncomingCorePath(node, c.id, i);
                const pathLabel = pathStr ? ` [${pathStr}]` : ``;
                
                sourceOptions += `<option value="CABLE|${c.id}|${i}">🟦 Вхід: ${c.from.name} - Жила ${i+1}${sigStr}${pathLabel}</option>`;
                
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
            // Patchcords don't use core math recursively yet but we'll list them
            let sigStr = "";
            let coreSigHtml = "";
            if (c.from.type === "FOB") {
                const upstream = traceOpticalPath(c.from, "PATCHCORD", c.id);
                if (upstream !== null) {
                    let s = upstream - (connKm(c) * FIBER_DB_KM);
                    const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                    coreSigHtml = `<span style="color:${sColor}; font-weight:bold;">⚡ ${s.toFixed(1)} дБ</span>`;
                    sigStr = ` ⚡${s.toFixed(1)}дБ`;
                }
            }
            sourceOptions += `<option value="PATCHCORD|${c.id}|0">🟨 Вхід: ${typeLabel} ${c.from.name}${sigStr}</option>`;
            
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
    
    // Make attic splitters available as sources
    node.mainBox.splitters.forEach(sp => {
        if (sp.type === "PLC") {
            const ratio = parseInt(sp.ratio.split('x')[1]) || 2;
            for(let i=1; i<=ratio; i++) sourceOptions += `<option value="SPLITTER|${sp.id}|${i}">Горище: PLC ${sp.ratio} (Вихід ${i})</option>`;
        } else if (sp.type === "FBT") {
            sourceOptions += `<option value="SPLITTER|${sp.id}|X">Горище: FBT ${sp.ratio} (Гілка X)</option>`;
            sourceOptions += `<option value="SPLITTER|${sp.id}|Y">Горище: FBT ${sp.ratio} (Гілка Y)</option>`;
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

        atticHtml += `<div style="background:#21262d; padding:10px; border-radius:4px; border:1px solid #30363d; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <b style="color:#d29922; font-size:12px;">Головний: ${sp.type} ${sp.ratio}</b>
                <span onclick="window.removeMDUSplitter('${node.id}', 'main', '${sp.id}')" style="color:#f85149; cursor:pointer; font-size:12px;" title="Видалити">✖</span>
            </div>
            <div style="font-size:11px; margin-bottom:4px; color:#8b949e">Вхід (IN):</div>
            <select class="mdu-cross-main" data-id="${sp.id}" style="width:100%; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;">
                ${sOpt}
            </select>
        </div>`;
    });
    atticHtml += `</div>`;

    // Right: Floors (Secondary Boxes)
    let floorHtml = `<div style="flex: 1.5; border: 1px solid #30363d; border-radius: 6px; padding: 10px; background: #161b22; overflow-y: auto;">
        <h3 style="margin-top:0; margin-bottom:10px; color: #8b949e; text-align:center; font-size:14px;">🚪 Поверхи (Вторинні дільники)</h3>`;

    // Pre-build Flat Source Options
    let flatSourceOptions = sourceOptions;
    
    node.mainBox.splitters.forEach(sp => {
        if(sp.type === "FBT") {
            const sx = sigSplitter(node, sp.id, "X");
            const sy = sigSplitter(node, sp.id, "Y");
            const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
            const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
            flatSourceOptions += `<option value="SPLITTER|${sp.id}|X">🔀 Головний ${sp.type} ${sp.ratio} (X)${sxStr}</option>`;
            flatSourceOptions += `<option value="SPLITTER|${sp.id}|Y">🔀 Головний ${sp.type} ${sp.ratio} (Y)${syStr}</option>`;
        } else {
            const s = sigSplitter(node, sp.id);
            const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
            const outs = parseInt(sp.ratio.split("x")[1]) || 2;
            for(let i=1; i<=outs; i++) {
                flatSourceOptions += `<option value="SPLITTER|${sp.id}|${i}">📊 Головний ${sp.type} ${sp.ratio} (Вих. ${i})${sStr}</option>`;
            }
        }
    });

    node.floorBoxes.forEach(fb => {
        fb.splitters.forEach(sp => {
            if(sp.type === "FBT") {
                 const sx = sigSplitter(node, sp.id, "X");
                 const sy = sigSplitter(node, sp.id, "Y");
                 const sxStr = sx !== null ? ` ⚡${sx.toFixed(1)}дБ` : "";
                 const syStr = sy !== null ? ` ⚡${sy.toFixed(1)}дБ` : "";
                 flatSourceOptions += `<option value="SPLITTER|${sp.id}|X">🔀 Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${sp.type} ${sp.ratio} (X)${sxStr}</option>`;
                 flatSourceOptions += `<option value="SPLITTER|${sp.id}|Y">🔀 Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${sp.type} ${sp.ratio} (Y)${syStr}</option>`;
            } else {
                const s = sigSplitter(node, sp.id);
                const sStr = s !== null ? ` ⚡${s.toFixed(1)}дБ` : "";
                const outs = parseInt(sp.ratio.split("x")[1]) || 2;
                for(let i=1; i<=outs; i++) {
                    flatSourceOptions += `<option value="SPLITTER|${sp.id}|${i}">📊 Поверх ${fb.floor} (Під'їзд ${fb.entrance}): ${sp.type} ${sp.ratio} (Вих. ${i})${sStr}</option>`;
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

    Object.keys(floorsMap).forEach(entStr => {
        const entrance = parseInt(entStr);
        floorHtml += `<div style="background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:8px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1px solid #30363d; padding-bottom:4px;">
                <div style="font-weight:bold; color:#f0f6fc; font-size:13px;">Під'їзд ${entrance}</div>
                <div style="display:flex; gap:4px;">
                    <select id="mdu-addsp-f-${entrance}" style="background:#161b22; color:#c9d1d9; border:1px solid #30363d; font-size:11px; padding:2px;">`;
        for(let f=node.floors; f>=1; f--) floorHtml += `<option value="${f}">Пов. ${f}</option>`;
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
            floorHtml += `<div style="margin-bottom:8px; padding:4px; border-left: 2px solid #58a6ff; margin-left:4px;">
                <div style="font-weight:bold; color:#58a6ff; font-size:12px; margin-bottom:6px;">Поверх ${floorNum}</div>`;
                
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

                    floorHtml += `<div style="background:#21262d; padding:8px; border-radius:4px; border:1px solid #30363d; margin-bottom:6px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span style="font-size:11px; font-weight:bold">${sp.type} ${sp.ratio}</span>
                            <span onclick="window.removeMDUSplitter('${node.id}', 'floor', '${sp.id}', ${floorNum}, ${entrance})" style="color:#f85149; cursor:pointer; font-size:12px;" title="Видалити">✖</span>
                        </div>
                        <select class="mdu-cross-floor" data-floor="${floorNum}" data-entrance="${entrance}" data-id="${sp.id}" style="width:100%; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; font-size:10px; padding:2px;">
                            ${sOpt}
                        </select>
                    </div>`;
                });
            });
            
            // Generate Flats for this exact Entrance and Floor
            const firstFlat = (entrance - 1) * (node.floors * node.flatsPerFloor) + (floorNum - 1) * node.flatsPerFloor + 1;
            const flatsOnFloor = node.flatsPerFloor;
            
            floorHtml += `<div style="margin-top:6px; border-top:1px dashed #30363d; padding-top:6px;">
                <div style="font-size:11px; color:#c9d1d9; margin-bottom:4px;">Квартири:</div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:4px;">`;
                
            for(let flatNum = firstFlat; flatNum < firstFlat + flatsOnFloor; flatNum++) {
                const flatConn = (node.flats || []).find(f => f.flat === flatNum);
                const selVal = (flatConn && flatConn.crossConnect) ? `${flatConn.crossConnect.fromType}|${flatConn.crossConnect.fromId}|${flatConn.crossConnect.fromCore !== undefined ? flatConn.crossConnect.fromCore : (flatConn.crossConnect.fromBranch || "")}` : "";
                
                let sOpt = flatSourceOptions;
                if (selVal) {
                    sOpt = sOpt.replace(`value="${selVal}"`, `value="${selVal}" selected`);
                } else {
                    sOpt = sOpt.replace(`<option value="">`, `<option value="" selected>`);
                }
                
                floorHtml += `<div style="background:#0d1117; padding:4px; border:1px solid #30363d; border-radius:3px; font-size:10px; display:flex; flex-direction:column; gap:2px;">
                    <span style="color:#d29922;">Кв. ${flatNum}</span>
                    <select class="mdu-cross-flat" data-flat="${flatNum}" style="width:100%; background:#161b22; color:#c9d1d9; border:1px solid #30363d; font-size:9px; padding:1px;">
                        ${sOpt}
                    </select>
                </div>`;
            }
            
            floorHtml += `</div></div></div>`; // End Floor Block
        });
        floorHtml += `</div>`; // End Entrance Block
    });
    
    floorHtml += `</div>`;

    let bottomWrapperEnd = `</div>`;

    const body = document.getElementById("mdu-modal-body");
    body.innerHTML = `<div style="display:flex; flex-direction:column; gap:15px; height: 100%; overflow:hidden;">
        ${inHtml}
        ${bottomWrapperStart}
            ${atticHtml}
            ${floorHtml}
        ${bottomWrapperEnd}
    </div>`;
}

function saveMDUState(node) {
    // Collect from Attic
    const mainSelects = document.querySelectorAll(".mdu-cross-main");
    node.mainBox.crossConnects = [];
    mainSelects.forEach(sel => {
        /** @type {HTMLSelectElement} */
        const element = (sel);
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
        /** @type {HTMLSelectElement} */
        const element = (sel);
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
        /** @type {HTMLSelectElement} */
        const element = (sel);
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
    window.addMDUSplitter = (nodeId, location, entranceOverride = null) => {
        const node = nodes.find(n => n.id === nodeId);
        if(!node || node.type !== "MDU") return;
        
        saveMDUState(node); // Retain unsaved dropdown states before redraw
        
        if (location === "main") {
            const el = (document.getElementById("mdu-attic-sp-type"));
            const val = el ? el.value : "PLC 1x4";
            const [type, ratio] = val.split(" ");
            node.mainBox.splitters.push({
                id: "sp_" + Date.now() + Math.random().toString(36).substr(2, 4),
                type: type,
                ratio: ratio
            });
        } else if (location === "floor") {
            const entranceNum = entranceOverride !== null ? entranceOverride : 1;
            const elType = (document.getElementById(`mdu-addsp-t-${entranceNum}`));
            const elFloor = (document.getElementById(`mdu-addsp-f-${entranceNum}`));
            
            const val = elType ? elType.value : "PLC 1x4";
            const floorNum = elFloor ? parseInt(elFloor.value) : 1;
            const [type, ratio] = val.split(" ");
            
            let fb = node.floorBoxes.find(b => b.floor === floorNum && b.entrance === entranceNum);
            if (!fb) {
                fb = { floor: floorNum, entrance: entranceNum, splitters: [], crossConnects: [] };
                node.floorBoxes.push(fb);
            }
            
            fb.splitters.push({
                id: "sp_" + Date.now() + Math.random().toString(36).substr(2, 4),
                type: type,
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
