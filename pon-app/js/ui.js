// @ts-check
/// <reference path="./types.d.ts" />
/** @type {typeof import('leaflet')} */
const L = window["L"];
import { FBT_LOSSES, PLC_LOSSES, MECH, ONU_MIN, FIBER_DB_KM } from "./config.js";
import { sigClass } from "./utils.js";
import {
  nodes,
  conns,
  sigIn,
  sigONU,
  hasOLTPath,
  cntONUport,
  sigAtONU,
  connKm,
} from "./network.js";
import { traceOpticalPath, calculateMDUSignal, trueSigAtONU, sigSplitter, getMduSig } from "./signal.js";
import { getSplitterColor } from "./mdu-ui.js";

/**
 * Helper to process and aggregate all network components into a Bill of Materials.
 * @returns {Array<{category: string, name: string, count: number, unit: string, price: number}>}
 */
function buildEconomicData() {
  const items = [];
  const add = (category, name, count, unit, price = 0) => {
    const existing = items.find(i => i.category === category && i.name === name);
    if (existing) {
      existing.count += count;
      if (price > 0 && existing.price === 0) existing.price = price;
    } else {
      items.push({ category, name, count, unit, price });
    }
  };

  function isDefaultName(name, type) {
    if (name === type || new RegExp(`^${type}-\\d+$`).test(name)) return true;
    if (type === "FOB" && (name === "Муфта" || new RegExp(`^Муфта-\\d+$`).test(name))) return true;
    return false;
  }

  // Helper: extract base name for grouping (strips trailing # or simple -ID)
  function getGroupingName(n, defaultType, estModel) {
    if (isDefaultName(n, defaultType)) return estModel;
    // Attempt to strip a trailing " #1" or " - 1", but be careful not to strip "FOB-04-16"
    // Usually, users name it accurately. Let's return the name as is, 
    // or strip purely isolated trailing ID like " (1)" or " #1"
    const cleaned = n.replace(/\s*[#-]\s*\d+$/, "").replace(/\s*\(\d+\)$/, "");
    // Fallback: if they just wrote "ZTE", it returns "ZTE".
    // Append the estModel as a hint so that accessories logic stays clear, or just use custom name
    return `${cleaned} (Кастомний: замінює ${estModel.split(":")[0]})`;
  }

  // 1. Nodes
  nodes.forEach(n => {
    let price = typeof n.price === "number" ? n.price : 0;
    
    if (n.type === "OLT") {
      const portCount = n.ports || 4;
      let estModel = `OLT (на ${portCount} портів)`;
      let finalName = isDefaultName(n.name, "OLT") ? estModel : n.name;
      add("Активне обладнання", finalName, 1, "шт.", price);
      add("Активне обладнання", "Модуль SFP OLT PON C++ (лазерний трансівер)", portCount, "шт.", 0);
      
      // ODF Calculation
      const inOutCables = conns.filter(c => (c.from === n || c.to === n) && c.type === "cable");
      let totalLines = 0;
      inOutCables.forEach(c => totalLines += (c.capacity || 1));
      
      const activeLines = (n.crossConnects && Array.isArray(n.crossConnects)) ? n.crossConnects.length : 0;

      if (totalLines > 0) {
          let odfModel = "";
          if (totalLines <= 24) odfModel = "Оптичний крос (ODF) 19\" 1U на 24 порти";
          else if (totalLines <= 48) odfModel = "Оптичний крос (ODF) 19\" 2U на 48 портів";
          else if (totalLines <= 96) odfModel = "Оптичний крос (ODF) 19\" 4U на 96 портів";
          else odfModel = `Оптичний крос (ODF) 19" високої щільності (на ${totalLines} портів)`;
          
          add("Пасивне обладнання", odfModel, 1, "шт.", 0);
          
          if (activeLines > 0) {
              add("Монтажні матеріали", "Адаптер оптичний SC/UPC (прохідний з'єднувач в ODF)", activeLines, "шт.", 0);
              add("Монтажні матеріали", "Пігтейл оптичний SC/UPC (кінцевик для розварки магістралі в ODF)", activeLines, "шт.", 0);
              add("Монтажні матеріали", "Гільза термоусаджувальна КДЗС (зварювання пігтейлів в оптичному кросі ODF)", activeLines, "шт.", 0);
              add("Монтажні матеріали", "Патчкорд оптичний (шнур для комутації порту OLT з екраном ODF)", activeLines, "шт.", 0);
          }
      }
    } 
    else if (n.type === "FOB") {
      // Estimate FOB size
      const inOutCables = conns.filter(c => (c.from === n || c.to === n) && c.type === "cable");
      const dropPatchcords = conns.filter(c => (c.from === n || c.to === n) && c.type === "patchcord");
      const splitters = /** @type {FOBNode} */ (n).splitters || [];
      const legacyPlc = /** @type {FOBNode} */ (n).plcType;
      const legacyFbt = /** @type {FOBNode} */ (n).fbtType;
      
      let totalSplices = 0;
      inOutCables.forEach(c => totalSplices += (c.capacity || 1));
      
      let splCount = splitters.length;
      if (splCount === 0 && (legacyPlc || legacyFbt)) splCount = (legacyPlc ? 1 : 0) + (legacyFbt ? 1 : 0);

      const cablePorts = inOutCables.length;
      const dropPorts = dropPatchcords.length;

      let typeCategory = "Муфта оптична з'єднувальна (транзитна)";
      let estModel = "FOSC-M / Mini (до 12-24 зварок)";
      let kdazDesc = "Гільза термоусаджувальна КДЗС (захист магістральних зварок в оптичній муфті)";
      let trunkSplices = 0;
      
      if (dropPorts > 0) {
        typeCategory = "Бокс PON розподільчий (FOB)";
        let boxModel = "";
        if (dropPorts <= 4) boxModel = "Crosver FOB-02-04 (або аналог Fora/RCI)";
        else if (dropPorts <= 8) boxModel = "Crosver FOB-03-08 (або аналог)";
        else if (dropPorts <= 12) boxModel = "Crosver FOB-05-12 / FOB-03-12";
        else if (dropPorts <= 16) boxModel = "Crosver FOB-04-16 (або аналог)";
        else boxModel = "Crosver FOB-05-24 (на 24 абоненти)";
        
        estModel = `${typeCategory}: ${boxModel}`;
        kdazDesc = "Гільза термоусаджувальна КДЗС (захист магістральних зварок та сплітерів в абонентському боксі FOB)";
        
        add("Монтажні матеріали", "Адаптер оптичний SC/UPC (встановлюється у розподільчий бокс)", dropPorts, "шт.", 0);
        add("Монтажні матеріали", "Пігтейл оптичний SC/UPC (для виводу порту сплітера на адаптер)", dropPorts, "шт.", 0);
        add("Монтажні матеріали", "Гільза термоусаджувальна КДЗС (зварювання абонентських пігтейлів у боксі FOB)", dropPorts, "шт.", 0);
        
        trunkSplices = totalSplices;
      } else if (splCount > 0) {
        typeCategory = "Крос-муфта оптична (розподільча)";
        let mufModel = "FOSC-S/M (до 24-48 зварок)";
        if (totalSplices > 24) mufModel = "FOSC-400 (до 48-64 зварок)";
        estModel = `${typeCategory}: ${mufModel}`;
        kdazDesc = "Гільза термоусаджувальна КДЗС (захист магістральних зварок та сплітерів в оптичній крос-муфті)";
        trunkSplices = totalSplices;
      } else {
        typeCategory = "Муфта оптична з'єднувальна (транзитна)";
        let mufModel = "FOSC-M / Mini (до 12-24 зварок)";
        if (totalSplices > 24) mufModel = "FOSC-400 (до 48-64 зварок)";
        estModel = `${typeCategory}: ${mufModel}`;
        kdazDesc = "Гільза термоусаджувальна КДЗС (захист транзитних зварок в транзитній оптичній муфті)";
        trunkSplices = totalSplices;
      }

      if (trunkSplices > 0) {
         add("Монтажні матеріали", kdazDesc, trunkSplices, "шт.", 0);
      }

      let finalName = getGroupingName(n.name, "FOB", estModel);
      add("Пасивне обладнання", finalName, 1, "шт.", price);
      
      // 2. Splitters (from FOBs)
      splitters.forEach(sp => {
        const hint = sp.type === "FBT" ? "(несиметричний дільник)" : "(симетричний планарний дільник)";
        add("Сплітери оптичні", `Сплітер ${sp.type} ${sp.ratio} ${hint}`, 1, "шт.", 0);
      });
      if (legacyFbt && !splitters.some(s => s.type === "FBT")) {
        add("Сплітери оптичні", `Сплітер FBT ${legacyFbt} (несиметричний дільник)`, 1, "шт.", 0);
      }
      if (legacyPlc && !splitters.some(s => s.type === "PLC")) {
        add("Сплітери оптичні", `Сплітер PLC ${legacyPlc} (симетричний планарний дільник)`, 1, "шт.", 0);
      }
    }
    else if (n.type === "ONU") {
      let finalName = isDefaultName(n.name, "ONU") ? "Абонентський термінал ONU (перетворювач оптики в Ethernet)" : n.name;
      add("Абонентське обладнання", finalName, 1, "шт.", price);
    }
    else if (n.type === "MDU") {
      let finalName = isDefaultName(n.name, "MDU") ? "Багатоквартирний будинок MDU" : n.name;
      add("Пасивне обладнання", finalName, 1, "шт.", price);
      
      const floors = n.floors || 5;
      const entrances = n.entrances || 1;
      const flatsPerFloor = n.flatsPerFloor || 4;
      const penRate = typeof n.penetrationRate === "number" ? n.penetrationRate : 100;
      
      const totalFlats = floors * entrances * flatsPerFloor;
      const activeSubs = Math.ceil(totalFlats * (penRate / 100));

      const isFTTH = n.architecture !== "FTTB";
      if (isFTTH) {
        add("Пасивне обладнання", "Бокс оптичний головний (MDU Горище/Цоколь)", entrances, "шт.", 0);
        
        const floorBoxes = entrances * floors;
        add("Пасивне обладнання", "Бокс поверховий розподільчий (FTTH MDU)", floorBoxes, "шт.", 0);
        
        let mduSplitters = [];
        if (n.mainBox && n.mainBox.splitters) mduSplitters.push(...n.mainBox.splitters);
        if (n.floorBoxes) n.floorBoxes.forEach(fb => mduSplitters.push(...(fb.splitters || [])));
        
        if (mduSplitters.length > 0) {
           mduSplitters.forEach(sp => add("Сплітери оптичні", `Сплітер ${sp.type} ${sp.ratio}`, 1, "шт.", 0));
        } else {
           add("Сплітери оптичні", `Сплітер PLC 1x8 (Вторинний/Поверховий)`, floorBoxes, "шт.", 0);
        }
        
        const riserMeters = entrances * (floors * 3 + 10);
        add("Кабелі магістральні", "Кабель оптичний Riser (внутрішньобудинковий, для вертикальної розводки під'їздів)", riserMeters, "м", 0);
        
        const dropMeters = activeSubs * 15;
        add("Кабелі абонентські", "Кабель абонентський Inner Drop (розводка від поверхового боксу до квартири)", dropMeters, "м", 0);
        
        const mainSplices = entrances * 4;
        add("Монтажні матеріали", "Гільза термоусаджувальна КДЗС (зварювання магістралі у головному боксі MDU)", mainSplices, "шт.", 0);
        
        const floorSplices = floorBoxes * 2;
        add("Монтажні матеріали", "Гільза термоусаджувальна КДЗС (зварювання відводів у поверхових боксах)", floorSplices, "шт.", 0);
        
        add("Монтажні матеріали", "Конектор швидкої фіксації Fast Connector (окінцювання Inner Drop кабелю у квартирі)", activeSubs * 2, "шт.", 0);
        add("Абонентське обладнання", "Абонентський термінал ONU (перетворювач оптики в Ethernet)", activeSubs, "шт.", 0);
      } else {
        // FTTB: Switch, UTP cable
        add("Активне обладнання", "Комутатор доступу (FTTB Switch)", entrances, "шт.", 0);
        
        const utpMeters = activeSubs * 20;
        add("Кабелі абонентські", "Кабель UTP мідний (FTTB)", utpMeters, "м", 0);
      }
    }
  });

  // 3. Cables & Patchcords
  conns.forEach(c => {
    if (c.type === "cable") {
      const cores = c.capacity || 1;
      const meters = connKm(c) * 1000;
      add("Кабелі магістральні", `Кабель оптичний ${cores}F`, meters, "м", 0);
      add("Монтажні матеріали", "Затискач натяжний магістральний (кріплення кабелю на опорі)", 2, "шт.", 0);
    } else if (c.type === "patchcord") {
      const meters = connKm(c) * 1000;
      add("Кабелі абонентські", "Drop-кабель (армований кабель 'останньої милі' від муфти до абонента)", meters, "м", 0);
      add("Монтажні матеріали", "Конектор швидкої фіксації Fast Connector (окінцювання країв drop-кабелю)", 2, "шт.", 0);
      add("Монтажні матеріали", "Затискач натяжний Н3/AC (кріплення drop-кабелю на опорі/стовпі)", 1, "шт.", 0);
      add("Монтажні матеріали", "Затискач анкерний (кріплення drop-кабелю на фасаді абонента)", 1, "шт.", 0);
    }
  });

  return items;
}


/**
 * Trace the full signal chain from OLT to a specific FOB, returning step-by-step details.
 * @param {FOBNode} targetFob - The FOB to trace signal to
 * @returns {{ oltName: string, oltPort: number, oltPower: number, steps: Array<{label: string, loss: number, signal: number}>, totalLoss: number, finalSignal: number|null, chainText: string } | null}
 */
function traceSignalChain(targetFob) {
  // Find the primary input cable of the FOB
  const inCables = conns.filter(c => c.to === targetFob && c.type === "cable");
  if (inCables.length === 0) return null;

  // We trace through the first active cross-connect path
  // Walk backward from the FOB through the cross-connect chain
  const steps = [];
  let fob = targetFob;
  let totalLoss = 0;

  // Collect chain segments by walking backward
  const segments = [];

  // Find which cable core feeds into the splitter chain of this FOB
  const xcs = fob.crossConnects || [];
  // Find a splitter that has outputs (meaning it's the "last" in chain for subscribers)
  const splitters = fob.splitters || [];
  
  // Strategy: find the first splitter that has subscriber outputs, then trace backward from its input
  let startSplitterId = null;
  let startSplitterType = null;
  
  // Find PLC first (it's typically the subscriber-facing splitter)
  const plcSp = splitters.find(s => s.type === "PLC");
  const fbtSp = splitters.find(s => s.type === "FBT");
  
  if (plcSp) {
    startSplitterId = plcSp.id;
    startSplitterType = plcSp;
  } else if (fbtSp) {
    startSplitterId = fbtSp.id;
    startSplitterType = fbtSp;
  } else if (fob.plcType) {
    startSplitterId = "legacy_plc";
    startSplitterType = { type: "PLC", ratio: fob.plcType };
  } else if (fob.fbtType) {
    startSplitterId = "legacy_fbt";
    startSplitterType = { type: "FBT", ratio: fob.fbtType };
  }
  
  if (!startSplitterId) {
    // No splitter — transit-only FOB, trace cable path
    // Just find what feeds this FOB
    const inCable = inCables[0];
    if (!inCable) return null;
    
    const cableKm = connKm(inCable);
    const cableLoss = cableKm * FIBER_DB_KM;
    totalLoss += cableLoss + MECH;
    
    segments.push({ label: `${inCable.from.name} → кабель ${(cableKm * 1000).toFixed(0)}м`, loss: cableLoss, mechLoss: MECH });
    
    // Try to find OLT
    let srcNode = inCable.from;
    while (srcNode && srcNode.type === "FOB") {
      const prevCable = conns.find(c => c.to === srcNode && c.type === "cable");
      if (!prevCable) break;
      const km = connKm(prevCable);
      const loss = km * FIBER_DB_KM;
      totalLoss += loss + MECH;
      segments.unshift({ label: `${prevCable.from.name} → кабель ${(km * 1000).toFixed(0)}м`, loss: loss, mechLoss: MECH });
      srcNode = prevCable.from;
    }
    
    if (srcNode && srcNode.type === "OLT") {
      const oltPower = srcNode.outputPower || 3;
      const finalSignal = oltPower - totalLoss;
      
      let chainParts = [`${srcNode.name} (+${oltPower}дБ)`];
      segments.forEach(seg => {
        chainParts.push(`${seg.label} (-${seg.loss.toFixed(2)}дБ, мех: -${seg.mechLoss}дБ)`);
      });
      chainParts.push(`→ ${targetFob.name} (транзит)`);
      
      return {
        oltName: srcNode.name, oltPort: -1, oltPower: oltPower,
        steps: [], totalLoss: totalLoss, finalSignal: finalSignal,
        chainText: chainParts.join(" → ")
      };
    }
    return null;
  }
  
  // Trace from the splitter backward using cross-connects
  let traceType = "SPLITTER";
  let traceId = startSplitterId;
  let traceCore = undefined;
  let currentFob = targetFob;
  
  // Add the final splitter step
  if (startSplitterType.type === "FBT") {
    const fbtLoss = FBT_LOSSES[startSplitterType.ratio];
    const worstLoss = fbtLoss ? Math.max(fbtLoss.x, fbtLoss.y) : 0;
    segments.push({ label: `[FBT ${startSplitterType.ratio}]`, loss: worstLoss, mechLoss: MECH });
    totalLoss += worstLoss + MECH;
  } else if (startSplitterType.type === "PLC") {
    const plcLoss = PLC_LOSSES[startSplitterType.ratio] || 0;
    segments.push({ label: `[PLC ${startSplitterType.ratio}]`, loss: plcLoss, mechLoss: MECH });
    totalLoss += plcLoss + MECH;
  }
  
  // Now trace backward through cross-connects
  let safetyCounter = 0;
  while (currentFob && currentFob.type === "FOB" && safetyCounter < 20) {
    safetyCounter++;
    const xcList = currentFob.crossConnects || [];
    const xc = xcList.find(x => {
      if (x.toType !== traceType || String(x.toId) !== String(traceId)) return false;
      if (traceType === "PATCHCORD" || traceCore === undefined) return true;
      return x.toCore === traceCore || x.toBranch === String(traceCore) || String(x.toCore) === String(traceCore);
    });
    if (!xc) break;
    
    if (xc.fromType === "CABLE") {
      const inCable = conns.find(c => c.id === xc.fromId);
      if (!inCable) break;
      
      const cableKm = connKm(inCable);
      const cableLoss = cableKm * FIBER_DB_KM;
      totalLoss += cableLoss + MECH;
      segments.unshift({ label: `кабель ${(cableKm * 1000).toFixed(0)}м (жила ${(xc.fromCore ?? 0) + 1})`, loss: cableLoss, mechLoss: MECH });
      
      if (inCable.from.type === "OLT") {
        const olt = inCable.from;
        const oltXc = (olt.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === inCable.id && x.toCore === xc.fromCore);
        const oltPort = oltXc ? parseInt(String(oltXc.fromId)) : -1;
        const oltPower = olt.outputPower || 3;
        const finalSignal = oltPower - totalLoss;
        
        // Build chain text
        let chainParts = [`${olt.name} Порт ${oltPort + 1} (+${oltPower}дБ)`];
        segments.forEach(seg => {
          chainParts.push(`${seg.label} (-${seg.loss.toFixed(2)}дБ)`);
        });
        
        // Build step-by-step for the table
        const detailedSteps = segments.map((seg, i) => {
          const prevSig = i === 0 ? oltPower : (oltPower - segments.slice(0, i).reduce((a, s) => a + s.loss + s.mechLoss, 0));
          return { label: seg.label, loss: seg.loss + seg.mechLoss, signal: prevSig - seg.loss - seg.mechLoss };
        });
        
        return {
          oltName: olt.name, oltPort: oltPort, oltPower: oltPower,
          steps: detailedSteps, totalLoss: totalLoss, finalSignal: finalSignal,
          chainText: chainParts.join(" → ")
        };
      } else if (inCable.from.type === "FOB") {
        // Check if this upstream FOB has a splitter feeding this cable
        const upFob = inCable.from;
        const upXcs = upFob.crossConnects || [];
        const feedXc = upXcs.find(x => x.toType === "CABLE" && x.toId === inCable.id && x.toCore === xc.fromCore);
        
        if (feedXc && feedXc.fromType === "SPLITTER") {
          // Upstream FOB has a splitter feeding this cable
          const upSplitters = upFob.splitters || [];
          const upSp = upSplitters.find(s => s.id === feedXc.fromId) ||
                       (feedXc.fromId === "legacy_fbt" ? { type: "FBT", ratio: upFob.fbtType } :
                        feedXc.fromId === "legacy_plc" ? { type: "PLC", ratio: upFob.plcType } : null);
          
          if (upSp) {
            if (upSp.type === "FBT") {
              const branch = feedXc.fromBranch || "Y";
              const fbtLoss = FBT_LOSSES[upSp.ratio];
              const loss = branch === "X" ? (fbtLoss?.x || 0) : (fbtLoss?.y || 0);
              segments.unshift({ label: `${upFob.name} [FBT ${upSp.ratio} ${branch}]`, loss: loss, mechLoss: MECH });
              totalLoss += loss + MECH;
            } else if (upSp.type === "PLC") {
              const loss = PLC_LOSSES[upSp.ratio] || 0;
              segments.unshift({ label: `${upFob.name} [PLC ${upSp.ratio}]`, loss: loss, mechLoss: MECH });
              totalLoss += loss + MECH;
            }
            // Continue tracing from this splitter's input
            currentFob = upFob;
            traceType = "SPLITTER";
            traceId = String(feedXc.fromId);
            traceCore = undefined;
            continue;
          }
        }
        
        // Simple transit (cable-to-cable)
        currentFob = upFob;
        traceType = "CABLE";
        traceId = inCable.id;
        traceCore = xc.fromCore;
        continue;
      }
      break;
      
    } else if (xc.fromType === "SPLITTER") {
      const sp = (currentFob.splitters || []).find(s => s.id === xc.fromId) ||
                 (xc.fromId === "legacy_fbt" ? { type: "FBT", ratio: currentFob.fbtType } :
                  xc.fromId === "legacy_plc" ? { type: "PLC", ratio: currentFob.plcType } : null);
      
      if (sp) {
        if (sp.type === "FBT") {
          const branch = xc.fromBranch || "Y";
          const fbtLoss = FBT_LOSSES[sp.ratio];
          const loss = branch === "X" ? (fbtLoss?.x || 0) : (fbtLoss?.y || 0);
          segments.unshift({ label: `[FBT ${sp.ratio} ${branch}]`, loss: loss, mechLoss: MECH });
          totalLoss += loss + MECH;
        } else if (sp.type === "PLC") {
          const loss = PLC_LOSSES[sp.ratio] || 0;
          segments.unshift({ label: `[PLC ${sp.ratio}]`, loss: loss, mechLoss: MECH });
          totalLoss += loss + MECH;
        }
      }
      traceType = "SPLITTER";
      traceId = String(xc.fromId);
      traceCore = undefined;
      continue;
    }
    break;
  }
  
  return null;
}

function buildReportData() {
  const rows = [];
  nodes
    .filter((n) => n.type === "FOB" || n.type === "MDU")
    .forEach((n) => {
      const inConns = conns.filter(x => x.to === n && (x.type === "cable" || x.type === "patchcord"));
      if (inConns.length === 0) {
        rows.push({ name: n.name, type: n.type, status: "NOT_CONNECTED" });
        return;
      }

      const totalDm = inConns.reduce((acc, c) => acc + connKm(c) * 1000, 0); // Total distance of incoming lines
      const cLoss = (totalDm / 1000) * FIBER_DB_KM;
      // @ts-ignore
      const si = typeof sigIn === "function" ? (sigIn(n) || 0) : 0;
      
      let so = null;
      if (n.type === "MDU") {
          const mduSig = /** @type {any} */ (typeof calculateMDUSignal === "function" ? calculateMDUSignal(n) : { worstSignal: null });
          so = mduSig.worstSignal !== null ? mduSig.worstSignal : null;
      } else {
          // FOB
          const drops = conns.filter(x => x.from === n && x.type === "patchcord");
          if (drops.length > 0) {
             const sigs = drops.map(c => typeof trueSigAtONU === "function" ? trueSigAtONU(c.to) : sigONU(n)).filter(s => s !== null && s !== 0);
             if (sigs.length > 0) so = Math.min(...sigs);
          } else {
             so = (n.splitters?.length || n.plcType || n.fbtType) ? sigONU(n) : null;
          }
      }

      let fbts = "—"; let plcs = "—"; let plcBranch = "—";
      if (n.type === "MDU") {
          let sps = [];
          if (n.mainBox && n.mainBox.splitters) sps.push(...n.mainBox.splitters);
          if (n.floorBoxes) n.floorBoxes.forEach(fb => sps.push(...(fb.splitters || [])));
          if (sps.length > 0) {
              const fCount = sps.filter(s => s.type === "FBT").length;
              const pCount = sps.filter(s => s.type === "PLC").length;
              if(fCount) fbts = `FBT (${fCount} шт)`;
              if(pCount) plcs = `PLC (${pCount} шт)`;
          } else if (n.architecture !== "FTTB") {
              plcs = `PLC 1x8 (Авто)`;
          }
      } else {
          const splitters = n.splitters || [];
          fbts = splitters.filter(s => s.type === "FBT").map(s => s.ratio).join(", ") || n.fbtType || "—";
          plcs = splitters.filter(s => s.type === "PLC").map(s => s.ratio).join(", ") || n.plcType || "—";
          plcBranch = n.plcBranch || "—";
      }

      let connectedONU = 0;
      if (n.type === "MDU") {
         const firstFlat = 1;
         const lastFlat = (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 4);
         if (n.flats) {
            connectedONU = n.flats.filter(f => f.flat >= firstFlat && f.flat <= lastFlat && f.crossConnect).length;
         }
      } else {
         connectedONU = conns.filter((x) => x.from === n && x.type === "patchcord").reduce((acc, c) => acc + (c.to.type === "MDU" ? Math.ceil((c.to.floors || 0) * (c.to.entrances || 0) * (c.to.flatsPerFloor || 0) * ((typeof c.to.penetrationRate === 'number' ? c.to.penetrationRate : 100) / 100)) : 1), 0);
      }

      const origins = Array.from(new Set(inConns.map(c => c.from.name || c.from.type))).join(", ");
      const branches = Array.from(new Set(inConns.map(c => c.branch || "—"))).join(", ");

      // Trace signal chain for FOBs
      const chain = n.type === "FOB" ? traceSignalChain(n) : null;
      let chainText = chain ? chain.chainText : null;
      
      if (chainText && n.type === "FOB") {
          const drops = conns.filter(x => x.from === n && x.type === "patchcord");
          if (drops.length > 0) {
              let worstDrop = drops[0];
              // @ts-ignore
              let minSig = typeof trueSigAtONU === "function" ? trueSigAtONU(worstDrop.to) : so;
              for (const d of drops) {
                  // @ts-ignore
                  const s = typeof trueSigAtONU === "function" ? trueSigAtONU(d.to) : so;
                  if (s !== null && (minSig === null || s < minSig)) { 
                      minSig = s; 
                      worstDrop = d; 
                  }
              }
              if (worstDrop && minSig !== null) {
                  const dropM = connKm(worstDrop) * 1000;
                  const dropLoss = (dropM / 1000) * FIBER_DB_KM;
                  chainText += ` → Drop-кабель ${dropM.toFixed(0)}м (-${dropLoss.toFixed(2)}дБ) → ONU (${minSig.toFixed(2)}дБ)`;
              }
          }
      }

      rows.push({
        name: n.name,
        type: n.type,
        from: origins,
        branch: branches,
        dist: totalDm.toFixed(1),
        cableLoss: cLoss.toFixed(3),
        mechLoss: MECH,
        signalIn: si !== null ? si.toFixed(2) : "—",
        fbt: fbts,
        fbtLoss: chain ? chain.steps.filter(s => s.label.includes("FBT")).reduce((a, s) => a + s.loss, 0) : null,
        plc: plcs,
        plcLoss: chain ? chain.steps.filter(s => s.label.includes("PLC")).reduce((a, s) => a + s.loss, 0) : null,
        plcBranch: plcBranch,
        totalLoss: chain ? chain.totalLoss : null,
        signalONU: so !== null ? so.toFixed(2) : "—",
        onuCnt: connectedONU,
        oltSource: chain ? `${chain.oltName}, Порт ${chain.oltPort + 1}` : "—",
        oltPower: chain ? chain.oltPower : null,
        chainText: chainText,
        status:
          so !== null
            ? so >= ONU_MIN
              ? "ok"
              : so >= ONU_MIN - 2
              ? "warn"
              : "err"
            : "info",
      });
    });
  return rows;
}

export function openReport() {
  const btnPng = document.getElementById("btn-export-png");
  if (btnPng) btnPng.style.display = "none";
  
  const rows = buildReportData();
  const oltCount = nodes.filter((n) => n.type === "OLT").length;
  const fobCount = nodes.filter((n) => n.type === "FOB").length;
  let onuCount = 0;
  nodes.forEach((n) => {
    if (n.type === "ONU") onuCount++;
    if (n.type === "MDU") {
        const pen = typeof n.penetrationRate === "number" ? n.penetrationRate : 100;
        onuCount += Math.ceil((n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0) * (pen / 100));
    }
  });
  const totalCableM = conns
    .filter((c) => c.type === "cable")
    .reduce((a, c) => a + connKm(c) * 1000, 0);

  let html = `
    <div class="summary-grid">
      <div class="summary-card"><div class="n">${oltCount}</div><div class="t">OLT</div></div>
      <div class="summary-card"><div class="n">${fobCount}</div><div class="t">FOB</div></div>
      <div class="summary-card"><div class="n">${onuCount}</div><div class="t">Абонентів</div></div>
      <div class="summary-card"><div class="n">${totalCableM.toFixed(0)}</div><div class="t">м кабелю</div></div>
    </div>
    <div class="info-pill" style="margin-bottom:12px">⚙️ Затухання волокна: ${FIBER_DB_KM} дБ/км | Мех. втрати: ${MECH} дБ | Поріг ONU: ${ONU_MIN} дБ</div>

    <div class="report-section">
      <h3>Бюджет оптичних втрат по FOB</h3>
      <div style="overflow-x: auto; padding-bottom: 10px;">
        <table style="min-width: 1400px; margin-bottom: 0;">
          <thead><tr>
          <th>Вузол</th><th>Тип</th><th>Від</th><th>OLT (Порт)</th><th>Потужн., дБ</th>
          <th>Відст., м</th><th>Затух. волокна, дБ</th><th>Мех., дБ</th><th>Сигнал IN, дБ</th>
          <th>FBT</th><th>Втрати FBT, дБ</th><th>PLC</th><th>Втрати PLC, дБ</th>
          <th>Σ Втрат, дБ</th><th>Сигнал ONU, дБ</th>
          <th>ONU</th><th>Статус</th>
        </tr></thead><tbody>`;

  rows.forEach((r) => {
    if (r.status === "NOT_CONNECTED") {
      html += `<tr><td class="td-name">${r.name}</td><td colspan="16" style="color:#f85149">⚠️ Не підключений</td></tr>`;
      return;
    }
    const sClass =
      {
        ok: "td-ok",
        warn: "td-warn",
        err: "td-err",
        info: "",
      }[r.status] || "";
    const sIcon =
      {
        ok: "✓",
        warn: "!",
        err: "✗",
        info: "—",
      }[r.status] || "";
    html += `<tr>
      <td class="td-name">${r.name}</td>
      <td>${r.type}</td>
      <td>${r.from}</td>
      <td style="font-size:11px">${r.oltSource || "—"}</td>
      <td>${r.oltPower !== null ? "+" + r.oltPower : "—"}</td>
      <td>${r.dist}</td>
      <td>${r.cableLoss}</td>
      <td>${r.mechLoss}</td>
      <td><strong>${r.signalIn}</strong></td>
      <td>${r.fbt}</td>
      <td>${r.fbtLoss !== null && r.fbtLoss > 0 ? r.fbtLoss.toFixed(2) : "—"}</td>
      <td>${r.plc}</td>
      <td>${r.plcLoss !== null && r.plcLoss > 0 ? r.plcLoss.toFixed(2) : "—"}</td>
      <td>${r.totalLoss !== null ? r.totalLoss.toFixed(2) : "—"}</td>
      <td class="${sClass}"><strong>${r.signalONU}</strong></td>
      <td>${r.onuCnt}</td>
      <td class="${sClass}"><strong>${sIcon}</strong></td>
    </tr>`;
    // Signal chain expandable sub-row
    if (r.chainText) {
      html += `<tr class="chain-row"><td></td><td colspan="16" style="background:#161b22;padding:6px 10px;font-size:11px;color:#8b949e;border-left:3px solid #30363d;">
        🔗 <span style="color:#58a6ff">Ланцюг:</span> ${r.chainText}
      </td></tr>`;
    }
  });
  html += `</tbody></table></div></div>`;

  const olts = nodes.filter((n) => n.type === "OLT");
  if (olts.length) {
    html += `<div class="report-section"><h3>Завантаження портів OLT</h3><div style="overflow-x: auto; padding-bottom: 10px;"><table style="min-width: 600px; margin-bottom: 0;">
      <thead><tr><th>OLT</th><th>Порт</th><th>Потужність, дБ</th><th>Абонентів</th><th>Статус</th></tr></thead><tbody>`;
    olts.forEach((olt) => {
      for (let i = 0; i < olt.ports; i++) {
        const cnt = cntONUport(olt, i);
        if (cnt > 0) {
          const max = olt.maxOnuPerPort || 64;
          const over = cnt > max;
          html += `<tr><td class="td-name">${olt.name}</td><td>Порт ${i + 1}</td><td>${olt.outputPower}</td>
            <td>${cnt}/${max}</td><td class="${over ? "td-err" : "td-ok"}">${over ? "⚠️ Перевантаження" : "✓ OK"}</td></tr>`;
        }
      }
    });
    html += `</tbody></table></div></div>`;
  }

  const econData = buildEconomicData();
  if (econData.length > 0) {
    html += `<div class="report-section"><h3>💰 Економічна частина (BOM)</h3>`;
    html += `<div class="info-pill" style="margin-bottom:12px">
      💡 Вкажіть ціни в Excel для формування кошторису. Для позицій у <strong>метрах (м)</strong> вказуйте ціну <strong>за 1 метр</strong>. Формула: Сума = Кількість × Ціна за од.
    </div>`;

    html += `<div style="overflow-x: auto; padding-bottom: 10px;">
      <table style="width:100%; min-width:800px; margin-bottom:0;">
      <thead><tr><th>Категорія</th><th>Назва / Номенклатура</th><th>К-ть</th><th>Од.виміру</th><th>Ціна за од. (₴)</th><th>Сума (₴)</th></tr></thead><tbody>`;

    // Group rows by category in the HTML view
    let currentCat = "";
    // Custom sort to put cables first, then boxes, then splitters, then ONUs
    const catOrder = {
      "Активне обладнання": 1,
      "Пасивне обладнання": 2,
      "Сплітери оптичні": 3,
      "Кабелі магістральні": 4,
      "Кабелі абонентські": 5,
      "Абонентське обладнання": 6,
      "Монтажні матеріали": 7
    };
    
    econData.sort((a,b) => (catOrder[a.category]||99) - (catOrder[b.category]||99) || a.name.localeCompare(b.name));

    econData.forEach((row) => {
      const total = row.count * row.price;
      const showCat = row.category !== currentCat;
      if (showCat) currentCat = row.category;
      
      const countLabel = row.unit === "м" ? Math.ceil(row.count) : row.count; // Round meters up

      html += `<tr>
        <td style="color:#8b949e; font-size:11px;">${showCat ? row.category : ""}</td>
        <td class="td-name">${row.name}</td>
        <td><strong>${countLabel}</strong></td>
        <td style="color:#8b949e; font-size:11px;">${row.unit}</td>
        <td>${row.price > 0 ? row.price.toFixed(2) : ""}</td>
        <td>${total > 0 ? total.toFixed(2) : ""}</td>
      </tr>`;
    });

    html += `</tbody></table></div></div>`;
  }

  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("modal-overlay").classList.add("open");
}

export function closeModal(e) {
  if (
    !e ||
    e.target === document.getElementById("modal-overlay") ||
    e.target.closest(".btn-x")
  ) {
    document.getElementById("modal-overlay").classList.remove("open");
  }
}

function getProjectFileName(suffix) {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("project-name-input"));
  let name = input && input.value.trim() !== "" ? input.value.trim() : "Проєкт";
  // Remove invalid filename characters
  name = name.replace(/[<>:"/\\|?*]/g, '_');
  return `${name}_${suffix}`;
}

export function downloadCSV() {
  const rows = buildReportData();
  const hdr =
    "Вузол;Тип;Від;OLT (Порт);Потужн. дБ;Відстань м;Затух. волокна дБ;Мех. дБ;Сигнал IN дБ;FBT;Втрати FBT дБ;PLC;Втрати PLC дБ;Σ Втрат дБ;Сигнал ONU дБ;Абонентів;Статус;Ланцюг сигналу\n";

  function csvEscapeCell(v) {
    const s = String(v ?? "");
    // Quote if needed for CSV structure or to preserve leading/trailing spaces.
    if (/[;"\r\n]/.test(s) || /^\s|\s$/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function excelForceTextCell(s) {
    // Excel tends to parse numeric values as dates (e.g., 1.40 → Jan 40, 1.4 → Jan 4).
    // Using ="value" formula format explicitly forces Excel to treat it as text.
    const escaped = String(s).replace(/"/g, '""');
    return `="${escaped}"`;
  }

  function safeCell(v) {
    let s = String(v ?? "");
    
    // Замінюємо крапку на кому для десяткових чисел (1.2 -> 1,2 або -15.4 -> -15,4).
    // У Excel з українською локаллю це розпізнається як число, а не як текст чи дата, 
    // що дозволяє використовувати формули та сумування по стовпцю.
    if (/^-?\d+\.\d+$/.test(s)) {
      s = s.replace('.', ',');
    }

    // Для дробів типу FBT спліттерів (10/90, 1/2) залишаємо примусовий текст, 
    // щоб Excel не перетворив "10/90" на жовтень 1990 року.
    if (/^\d{1,2}[\/-]\d{1,4}$/.test(s)) return excelForceTextCell(s);
    
    return csvEscapeCell(s);
  }

  const body = rows
    .map((r) =>
      r.status === "NOT_CONNECTED"
        ? `${safeCell(r.name)};${safeCell(r.type)};${safeCell("НЕ ПІДКЛЮЧЕНИЙ")};;;;;;;;;;;;;;;`
        : [
            safeCell(r.name),
            safeCell(r.type),
            safeCell(r.from),
            safeCell(r.oltSource || "—"),
            safeCell(r.oltPower !== null ? "+" + r.oltPower : "—"),
            safeCell(r.dist),
            safeCell(r.cableLoss),
            safeCell(r.mechLoss),
            safeCell(r.signalIn), 
            safeCell(r.fbt),
            safeCell(r.fbtLoss !== null && r.fbtLoss > 0 ? r.fbtLoss.toFixed(2) : "—"),
            safeCell(r.plc),
            safeCell(r.plcLoss !== null && r.plcLoss > 0 ? r.plcLoss.toFixed(2) : "—"),
            safeCell(r.totalLoss !== null ? r.totalLoss.toFixed(2) : "—"),
            safeCell(r.signalONU), 
            safeCell(r.onuCnt),
            safeCell(
              {
                ok: "OK",
                warn: "Межа",
                err: "СЛАБКИЙ",
                info: "—",
              }[r.status] || r.status,
            ),
            safeCell(r.chainText || "—")
          ].join(";"),
    )
    .join("\n");

  const econData = buildEconomicData();
  const catOrder = {
    "Активне обладнання": 1,
    "Пасивне обладнання": 2,
    "Сплітери оптичні": 3,
    "Кабелі магістральні": 4,
    "Кабелі абонентські": 5,
    "Абонентське обладнання": 6,
    "Монтажні матеріали": 7
  };
  econData.sort((a,b) => (catOrder[a.category]||99) - (catOrder[b.category]||99) || a.name.localeCompare(b.name));

  let economicSection = "\n\n💰 Економічна частина (BOM для кошторису)\n";
  economicSection += "Категорія;Номенклатура;Кількість;Од. виміру;Ціна за од. (₴);Сума (₴)\n";

  // Обчислюємо точний номер рядка Excel (1-based) для першого елементу BOM
  const preCsvLines = hdr + (body ? body : "") + economicSection;
  let excelRow = preCsvLines.split('\n').length;

  econData.forEach((row) => {
    const countLabel = row.unit === "м" ? Math.ceil(row.count) : row.count;
    const formulaCell = `=C${excelRow}*E${excelRow}`;
    economicSection += `${safeCell(row.category)};${safeCell(row.name)};${safeCell(countLabel)};${safeCell(row.unit)};${row.price > 0 ? safeCell(row.price.toFixed(2)) : ""};${formulaCell}\n`;
    excelRow++;
  });

  economicSection += "\n💡 Вкажіть ціни в Excel для формування кошторису.\n";

  const blob = new Blob(["\uFEFF" + hdr + body + economicSection], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = getProjectFileName("report.csv");
  a.click();
}

export function downloadTXT() {
  const rows = buildReportData();

  const header = [
    "Вузол",
    "Тип",
    "Від",
    "OLT (Порт)",
    "Потужн. дБ",
    "Відстань м",
    "Затух. волокна дБ",
    "Мех. дБ",
    "Сигнал IN дБ",
    "FBT",
    "Втрати FBT дБ",
    "PLC",
    "Втрати PLC дБ",
    "Σ Втрат дБ",
    "Сигнал ONU дБ",
    "Абонентів",
    "Статус",
  ];

  const table = [header];
  rows.forEach((r) => {
    if (r.status === "NOT_CONNECTED") {
      table.push([
        r.name,
        r.type,
        "НЕ ПІДКЛЮЧЕНИЙ",
        "", "", "", "", "", "", "", "", "", "", "", "", "", "",
      ]);
    } else {
      table.push([
        r.name,
        r.type,
        r.from,
        r.oltSource || "—",
        r.oltPower !== null ? "+" + r.oltPower : "—",
        r.dist,
        r.cableLoss,
        r.mechLoss,
        r.signalIn,
        r.fbt,
        r.fbtLoss !== null && r.fbtLoss > 0 ? r.fbtLoss.toFixed(2) : "—",
        r.plc,
        r.plcLoss !== null && r.plcLoss > 0 ? r.plcLoss.toFixed(2) : "—",
        r.totalLoss !== null ? r.totalLoss.toFixed(2) : "—",
        r.signalONU,
        String(r.onuCnt),
        {
          ok: "OK",
          warn: "Межа",
          err: "СЛАБКИЙ",
          info: "—",
        }[r.status] || r.status,
      ]);
    }
  });

  // Обчислити ширину кожного стовпчика (моноширинний стиль)
  const colWidths = header.map((_, col) =>
    Math.max(...table.map((row) => String(row[col] ?? "").length)),
  );

  let t = "PON ЗВІТ — Бюджет оптичних втрат по FOB\n\n";
  t += table
    .map((row, rowIdx) =>
      row
        .map((cell, colIdx) => {
          const s = String(cell ?? "");
          // трохи ширше для заголовків
          const w =
            rowIdx === 0 ? Math.max(colWidths[colIdx], s.length) : colWidths[colIdx];
          return s.padEnd(w, " ");
        })
        .join("  "),
    )
    .join("\n");

  const econData = buildEconomicData();
  const catOrder = {
    "Активне обладнання": 1,
    "Пасивне обладнання": 2,
    "Сплітери оптичні": 3,
    "Кабелі магістральні": 4,
    "Кабелі абонентські": 5,
    "Абонентське обладнання": 6,
    "Монтажні матеріали": 7
  };
  econData.sort((a,b) => (catOrder[a.category]||99) - (catOrder[b.category]||99) || a.name.localeCompare(b.name));

  const econHeader = ["Категорія", "Номенклатура", "Кількість", "Од.виміру", "Ціна за од. (₴)", "Сума (₴)"];
  const econTable = [econHeader];

  econData.forEach((row) => {
    const total = row.count * row.price;
    const countLabel = row.unit === "м" ? Math.ceil(row.count) : row.count;
    econTable.push([row.category, row.name, String(countLabel), row.unit, row.price > 0 ? row.price.toFixed(2) : "", total > 0 ? total.toFixed(2) : ""]);
  });

  if (econTable.length > 1) {
    const econColWidths = econHeader.map((_, col) =>
      Math.max(...econTable.map((row) => String(row[col] ?? "").length)),
    );
    t += "\n\n💰 Економічна частина (для кошторису)\n\n";
    t += econTable
      .map((row) =>
        row
          .map((cell, colIdx) => String(cell ?? "").padEnd(econColWidths[colIdx], " "))
          .join("  "),
      )
      .join("\n");
    t += "\n\n💡 Вкажіть ціни в Excel для формування кошторису.\n";
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([t]));
  a.download = getProjectFileName("report.txt");
  a.click();
}

export function showSuggestions() {
  const issues = [];

  nodes
    .filter((n) => n.type === "FOB")
    .forEach((fob) => {
      const inCables = conns.filter(c => c.to === fob && c.type === "cable");
      if (inCables.length === 0) {
        issues.push({
          icon: "❌",
          type: "err",
          msg: `${fob.name}: не підключений (немає вхідного кабелю)`,
          nodeId: fob.id,
        });
      }
    });

  nodes
    .filter((n) => n.type === "ONU" || n.type === "MDU")
    .forEach((onu) => {
      const hasConn = conns.some((c) => c.to === onu && (c.type === "patchcord" || (onu.type === "MDU" && c.type === "cable")));
      if (!hasConn)
        issues.push({
          icon: "❌",
          type: "err",
          msg: `${onu.name}: не підключений`,
          nodeId: onu.id,
        });
    });

  nodes
    .filter((n) => n.type === "FOB")
    .forEach((/** @type {FOBNode} */ fob) => {
      const inCables = conns.filter(c => c.to === fob && c.type === "cable");
      const hasSplitters = (fob.splitters && fob.splitters.length > 0) || fob.fbtType || fob.plcType;
      if (inCables.length > 0 && hasSplitters) {
        const sig = sigONU(fob);
        if (sig === null) return;
        if (sig < ONU_MIN - 3) {
          issues.push({
            icon: "❌",
            type: "err",
            msg: `${fob.name}: критично слабкий сигнал ONU (${sig.toFixed(1)} дБ)`,
            nodeId: fob.id,
          });
        } else if (sig < ONU_MIN) {
          issues.push({
            icon: "⚠️",
            type: "warn",
            msg: `${fob.name}: сигнал на межі порогу (${sig.toFixed(1)} дБ)`,
            nodeId: fob.id,
          });
        }
      }
    });

  nodes
    .filter((n) => n.type === "OLT")
    .forEach((olt) => {
      for (let i = 0; i < olt.ports; i++) {
        const c = cntONUport(olt, i);
        const max = olt.maxOnuPerPort || 64;
        if (c > max)
          issues.push({
            icon: "⚠️",
            type: "warn",
            msg: `${olt.name} Порт ${i + 1}: перевантаження! ${c}/${max} ONU`,
            nodeId: olt.id,
          });
      }
    });

  conns
    .filter((c) => c.type === "cable")
    .forEach((c) => {
      const km = connKm(c);
      if (km > 5)
        issues.push({
          icon: "⚠️",
          type: "warn",
          msg: `Довгий кабель: ${c.from.name}→${c.to.name} (${(km * 1000).toFixed(0)} м)`,
          nodeId: c.from.id,
        });
    });

  nodes
    .filter((n) => n.type === "FOB")
    .forEach((fob) => {
      const visited = new Set();
      let cur = fob;
      while (cur && cur.type === "FOB") {
        if (visited.has(cur.id)) {
          issues.push({
            icon: "❌",
            type: "err",
            msg: `Петля виявлена! Ланцюг через ${fob.name}`,
            nodeId: fob.id,
          });
          break;
        }
        visited.add(cur.id);
        const inCables = conns.filter(c => c.to === cur && c.type === "cable");
        const fromFobCables = inCables.filter(c => c.from && c.from.type === "FOB");
        if (fromFobCables.length === 0) break;
        cur = /** @type {FOBNode} */ (fromFobCables[0].from);
      }
    });

  let html = `<div class="report-section">`;
  if (issues.length === 0) {
    html += `<div style="padding:20px;text-align:center;color:#3fb950">✅ Серйозних проблем не виявлено</div>`;
  } else {
    html += `<ul style="list-style:none;padding:0;margin:0">`;
    issues.forEach((i) => {
      const cls = i.type === "err" ? "td-err" : i.type === "warn" ? "td-warn" : "";
      let btn = "";
      if (i.nodeId) {
        btn = `<button class="action-btn btn-blue" style="padding:2px 8px; font-size:11px; margin-left:auto; width:max-content; flex-shrink:0; white-space:nowrap;" onclick="focusNode('${i.nodeId}')"><i class="fa-solid fa-magnifying-glass"></i> Показати</button>`;
      }
      html += `<li class="${cls}" style="margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap: 10px;">
        <span>${i.icon} ${i.msg}</span>
        ${btn}
      </li>`;
    });
    html += `</ul>`;
  }
  html += `</div>`;

  document.getElementById("modal-body").innerHTML = html;
  const h2 = document
    .getElementById("modal-overlay")
    .querySelector("h2");
  if (h2) h2.textContent = "🔍 Перевірка мережі";
  document.getElementById("modal-overlay")?.classList.add("open");
}

export function focusNode(id) {
  const n = nodes.find((x) => x.id === id);
  if (!n) return;
  closeModal();
  const mapNode = n;
  const center = L.latLng(mapNode.lat, mapNode.lng);
  const map = mapNode.marker?._map;
  if (!map) return;

  // Use setView directly to avoid any offset/“fly away” drift.
  const zoom = Math.max(map.getZoom() || 0, 18);
  map.setView(center, zoom, { animate: false });

  // Visual focus feedback (без зміни позиції іконки)
  setTimeout(() => {
    mapNode.marker.openPopup();
    if (mapNode.marker._icon) {
      const icon = mapNode.marker._icon;
      icon.style.transition = "box-shadow 0.5s";
      icon.style.boxShadow = "0 0 20px #58a6ff";
      setTimeout(() => {
        icon.style.boxShadow = "";
      }, 1000);
    }
  }, 50);
}

export async function showTopology() {
  if (typeof window.focusNode === 'undefined') {
      window.focusNode = focusNode;
  }
  const modalBody = document.getElementById("modal-body");
  const h2 = document.getElementById("modal-overlay")?.querySelector("h2");
  if (h2) h2.textContent = "🗺️ Картограма Мережі (Mermaid)";
  
  // Basic container
  modalBody.innerHTML = `
    <div class="report-section" style="display: flex; flex-direction: column; flex: 1; margin: 0; padding: 0;">
      <div style="margin-bottom: 10px; display: flex; justify-content: flex-end; flex-shrink: 0;">
        <span style="font-size:12px; color:#8b949e;">💡 Використовуйте мишу для прокручування та масштабування графіка.</span>
      </div>
      <div id="mermaid-container" style="height: 70vh; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; position: relative;">
        <!-- SVG will be injected here -->
      </div>
    </div>
  `;

  document.getElementById("modal-overlay")?.classList.add("open");

  const btnPng = document.getElementById("btn-export-png");
  if (btnPng) btnPng.style.display = "";

  const olts = nodes.filter((n) => n.type === "OLT");
  if (olts.length === 0) {
    document.getElementById("mermaid-container").innerHTML = `<div style="text-align:center;color:#6e7681;padding:20px;margin-top:20px;">Немає OLT у мережі</div>`;
    return;
  }

  // Build Mermaid Syntax
  let m = `graph TD\n`;
  m += `  classDef default fill:#161b22,stroke:#30363d,stroke-width:1px,color:#c9d1d9;\n`;
  m += `  classDef olt fill:#0d1117,stroke:#58a6ff,stroke-width:2px,color:#c9d1d9,rx:20,ry:20;\n`;
  m += `  classDef fob fill:#161b22,stroke:#30363d,stroke-width:1px,color:#c9d1d9,rx:20,ry:20;\n`;
  m += `  classDef subs fill:#161b22,stroke:#3fb950,stroke-width:1px,color:#c9d1d9,rx:20,ry:20;\n`;
  
  let nodeIdx = 0;
  function safeId(str) { return "N" + str.replace(/[^a-zA-Z0-9]/g, "") + "_" + (nodeIdx++); }
  
  function getSpIcon(type, ratio) {
      if(type === "FBT") return "🟦";
      if(ratio === "1x2") return "🟪";
      if(ratio === "1x4") return "🟩";
      if(ratio === "1x8") return "🟧";
      if(ratio === "1x16") return "🟥";
      if(ratio === "1x32") return "🟫";
      return "🟪";
  }

  /**
   * @param {FOBNode} fob
   * @param {PONConnection} cable
   * @param {string} parentId
   * @param {string} incomingCoreNodeId - The exact Node ID inside the parent FOB that feeds this cable
   * @param {string} incomingBranchLabel - Label for the branch (e.g. X, Y)
   */
  function renderMermaidFob(fob, cable, parentId, incomingCoreNodeId = undefined, incomingBranchLabel = "") {
    const fId = safeId(fob.id);
    
    // Fallback info for the subgraph title
    const sig = hasOLTPath(fob) ? sigIn(fob) : null;
    const sigStr = sig !== null ? `⚡ ${sig.toFixed(1)} дБ` : "No Sig";

    const fobIcon = fob.subtype === "MUFTA" ? "🛢️" : "📦";
    m += `  subgraph ${fId} ["${fobIcon} ${fob.name} (${sigStr})"]\n`;
    m += `    direction TB\n`;
    
    // Plot Splitters as internal nodes
    const splitters = fob.splitters || [];
    const spNodes = {}; // map splitter id to mermaid node id
    
    if (splitters.length === 0) {
       // If no splitters, show a Transit node
       spNodes["transit"] = `${fId}_transit`;
       m += `    ${spNodes["transit"]}(["Транзит"]):::fob\n`;
       m += `    click ${spNodes["transit"]} "javascript:window.focusNode('${fob.id}')" "Двічі клікніть для переходу на карту"\n`;
    } else {
       splitters.forEach(sp => {
           const spNid = `${fId}_sp_${safeId(sp.id)}`;
           spNodes[sp.id] = spNid;
           m += `    ${spNid}(["${getSpIcon(sp.type, sp.ratio)} ${sp.type} ${sp.ratio}"]):::fob\n`;
           m += `    click ${spNid} "javascript:window.focusNode('${fob.id}')" "Двічі клікніть для переходу на карту"\n`;
       });
       
       // Draw internal cross-connects between splitters
       const xc = fob.crossConnects || [];
       xc.forEach(x => {
           if (x.fromType === "SPLITTER" && x.toType === "SPLITTER") {
               const fromNid = spNodes[x.fromId];
               const toNid = spNodes[x.toId];
               if (fromNid && toNid) {
                   const edgeLbl = x.fromBranch ? x.fromBranch : `${(x.fromCore||0)+1}`;
                   m += `    ${fromNid} -- "${edgeLbl}" --> ${toNid}\n`;
               }
           }
       });

       // Draw unconnected reserves for splitters
       splitters.forEach(sp => {
           const spNid = spNodes[sp.id];
           if (sp.type === "FBT") {
               ["X", "Y"].forEach(branch => {
                   const isConnected = xc.some(x => x.fromType === "SPLITTER" && x.fromId === sp.id && x.fromBranch === branch);
                   if (!isConnected) {
                       const resId = `${spNid}_res_${branch}`;
                       m += `    ${resId}("Резерв"):::reserve\n`;
                       m += `    ${spNid} -. "${branch}" .-> ${resId}\n`;
                       m += `    style ${resId} fill:#161b22,stroke:#30363d,color:#8b949e,stroke-dasharray: 4 4\n`;
                   }
               });
           } else if (sp.type === "PLC") {
               const portsStr = sp.ratio.split("x")[1];
               const numPorts = parseInt(portsStr);
               let freeCount = 0;
               if (!isNaN(numPorts)) {
                   for (let c = 0; c < numPorts; c++) {
                       const isConnected = xc.some(x => x.fromType === "SPLITTER" && x.fromId === sp.id && x.fromCore === c);
                       if (!isConnected) freeCount++;
                   }
                   if (freeCount > 0) {
                       const resId = `${spNid}_res`;
                       m += `    ${resId}("${freeCount} вільних"):::reserve\n`;
                       m += `    ${spNid} -.-> ${resId}\n`;
                       m += `    style ${resId} fill:#161b22,stroke:#30363d,color:#8b949e,stroke-width:1px\n`;
                   }
               }
           }
       });
       
       // Add Transit node if there are CABLE->CABLE transit splices
       const hasTransit = xc.some(x => x.fromType === "CABLE" && x.toType === "CABLE");
       if (hasTransit) {
           spNodes["transit"] = `${fId}_transit`;
           m += `    ${spNodes["transit"]}(["Транзит"]):::fob\n`;
           m += `    click ${spNodes["transit"]} "javascript:window.focusNode('${fob.id}')" "Двічі клікніть для переходу на карту"\n`;
       }
    }

    const groupCoresToHtml = (coreObjects, prefixStr = "") => {
        if (coreObjects.length === 0) return "";
        let html = "";
        if (prefixStr) html += `<div style='text-align:center; font-size:11px; margin-bottom:4px; font-weight:600;'>${prefixStr}</div>`;
        const CHUNK_SIZE = 4;
        for (let i = 0; i < coreObjects.length; i += CHUNK_SIZE) {
            const chunk = coreObjects.slice(i, i + CHUNK_SIZE);
            const rowHtml = chunk.map(c => {
                 const FIBER_COLORS = [
                     "#58a6ff", "#ff9632", "#3fb950", "#b07b46", "#8b949e", "#ffffff",
                     "#f85149", "#000000", "#e3b341", "#bc8cff", "#ff80b5", "#56d364"
                 ];
                 const dotColor = FIBER_COLORS[c.coreIdx % 12];
                 let bdr = dotColor === "#000000" ? "border: 1px solid #777;" : "border: 1px solid rgba(255,255,255,0.2);";
                 if (dotColor === "#000000") bdr += " box-shadow: 0 0 2px #fff;";
                 let sigHtml = "";
                 if (c.sig !== null && c.sig !== undefined) {
                      const sColor = c.sig >= -25 ? "#3fb950" : c.sig >= -28 ? "#d29922" : "#f85149";
                      sigHtml = `<span style='color:${sColor} !important; font-size:9px; margin-left:3px;'>⚡${c.sig.toFixed(1)}</span>`;
                 }
                 return `<span style='display:inline-block; background:rgba(13,17,23,0.8); border:1px solid #30363d; border-radius:4px; padding:2px 5px; margin:2px; white-space:nowrap; font-size:10px; color:#c9d1d9;'><span style='display:inline-block; width:8px; height:8px; border-radius:50%; background:${dotColor} !important; ${bdr} margin-right:4px; vertical-align:middle;'></span><span style='vertical-align:middle;'>${c.coreIdx+1}</span>${sigHtml}</span>`;
            }).join("");
            html += `<div style="text-align:center;">${rowHtml}</div>`;
        }
        return `|"<div style='min-width:60px; padding:2px;'>${html}</div>"|`;
    };

    // Determine the entry point "Node" for the incoming cable.
    let entryTargets = []; 
    const xcIn = fob.crossConnects || [];
    if (cable) {
        const incomingXcs = xcIn.filter(x => x.fromType === "CABLE" && x.fromId === cable.id);
        incomingXcs.forEach(x => {
            if (x.toType === "SPLITTER" && spNodes[x.toId]) {
                entryTargets.push({ id: spNodes[x.toId], coreIndex: x.fromCore });
            } else if (x.toType === "CABLE" && spNodes["transit"]) {
                entryTargets.push({ id: spNodes["transit"], coreIndex: x.fromCore });
            }
        });
    }

    let entryGroups = {};
    entryTargets.forEach(t => {
        if (!entryGroups[t.id]) entryGroups[t.id] = [];
        entryGroups[t.id].push(t.coreIndex);
    });

    let entryNodeIds = Object.keys(entryGroups);
    if (entryNodeIds.length === 0) {
        if (splitters.length > 0) entryNodeIds.push(spNodes[splitters[0].id]);
        else if (spNodes["transit"]) entryNodeIds.push(spNodes["transit"]);
        else entryNodeIds.push(fId);
    }

    let routingInNodeId = null;
    if (cable && entryNodeIds.length > 1 && !entryNodeIds.includes(fId)) {
        routingInNodeId = `${fId}_in_${safeId(String(cable.id))}`;
        m += `    ${routingInNodeId}(("Вхід")):::fob\n`;
        m += `    click ${routingInNodeId} "javascript:window.focusNode('${fob.id}')" "Двічі клікніть для переходу на карту"\n`;
        for (let targetId of entryNodeIds) {
             let coreObjects = [];
             if (entryGroups[targetId]) {
                  entryGroups[targetId].forEach(coreIdx => {
                      const cLoss = connKm(cable) * FIBER_DB_KM;
                      let inSig = null;
                      if (cable.from.type === "OLT") {
                          const oltXc = (cable.from.crossConnects || []).find(cx => cx.toType === "CABLE" && cx.toId === cable.id && cx.toCore === coreIdx);
                          if (oltXc) inSig = cable.from.outputPower - cLoss;
                      } else if (cable.from.type === "FOB") {
                          const upstream = traceOpticalPath(cable.from, "CABLE", cable.id, coreIdx);
                          if (upstream !== null) inSig = upstream - cLoss;
                      }
                      coreObjects.push({ coreIdx: coreIdx, sig: inSig });
                  });
             }
             let lblStr = groupCoresToHtml(coreObjects);
             m += `    ${routingInNodeId} -.-> ${lblStr} ${targetId}\n`;
        }
    }

    // Determine internal routing "Node" for outgoing cables before closing subgraph
    const downCables = conns.filter(c => c.from === fob && c.type === "cable");
    let outCableNodes = {}; 
    let outCableLabels = {}; 
    
    downCables.forEach(dc => {
        const dcXcs = (fob.crossConnects || []).filter(x => x.toType === "CABLE" && x.toId === dc.id);
        
        let sourceTargets = [];
        dcXcs.forEach(xc => {
            const outSig = traceOpticalPath(fob, "CABLE", dc.id, xc.toCore);
            let prefix = "";
            if (xc.fromType === "SPLITTER" && spNodes[xc.fromId]) {
                 if (xc.fromBranch) prefix = `<b style='color:#e3b341;'>${xc.fromBranch}</b>`;
                 sourceTargets.push({ id: spNodes[xc.fromId], prefix: prefix, coreIdx: xc.toCore, sig: outSig });
            } else if (xc.fromType === "CABLE" && spNodes["transit"]) {
                 sourceTargets.push({ id: spNodes["transit"], prefix: "", coreIdx: xc.toCore, sig: outSig });
            }
        });

        let sourceGroups = {};
        sourceTargets.forEach(t => {
            if (!sourceGroups[t.id]) sourceGroups[t.id] = { prefix: "", cores: [] };
            if (t.prefix && !sourceGroups[t.id].prefix) sourceGroups[t.id].prefix = t.prefix;
            sourceGroups[t.id].cores.push({ coreIdx: t.coreIdx, sig: t.sig });
        });

        const sourceIds = Object.keys(sourceGroups);
        let outNodeId = fId;
        
        if (sourceIds.length === 1) {
            outNodeId = sourceIds[0];
            outCableLabels[dc.id] = sourceGroups[outNodeId].prefix.replace(/<[^>]+>/g, '');
        } else if (sourceIds.length > 1) {
            outNodeId = `${fId}_out_${safeId(String(dc.id))}`;
            m += `    ${outNodeId}(("Вихід")):::fob\n`;
            m += `    click ${outNodeId} "javascript:window.focusNode('${fob.id}')" "Двічі клікніть для переходу на карту"\n`;
            for (let srcId of sourceIds) {
                let sGroup = sourceGroups[srcId];
                let lblStr = groupCoresToHtml(sGroup.cores, sGroup.prefix);
                m += `    ${srcId} -.-> ${lblStr} ${outNodeId}\n`;
            }
            outCableLabels[dc.id] = "";
        } else if (spNodes["transit"]) {
            outNodeId = spNodes["transit"];
        } else if (splitters.length > 0) {
            outNodeId = spNodes[splitters[splitters.length-1].id];
        }
        outCableNodes[dc.id] = outNodeId;
    });

    m += `  end\n`;

    // Edge from parent
    if (parentId) {
        let edgeText = "";
        if (cable && cable.capacity) {
            const cLoss = connKm(cable) * FIBER_DB_KM;
            let activeCoresHtml = "";
            const FIBER_COLORS = [
                "#58a6ff", "#ff9632", "#3fb950", "#b07b46", "#8b949e", "#ffffff",
                "#f85149", "#000000", "#e3b341", "#bc8cff", "#ff80b5", "#56d364"
            ];
            
            for (let i = 0; i < cable.capacity; i++) {
               let s = null;
               let portStr = "";
               if (cable.from.type === "OLT") {
                   const oltXc = (cable.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === cable.id && x.toCore === i);
                   if (oltXc) {
                       s = cable.from.outputPower - cLoss;
                       portStr = `<span style="color:#8b949e; font-size:9px; margin-right:2px;">(P${parseInt(String(oltXc.fromId))+1})</span>`;
                   }
               } else if (cable.from.type === "FOB") {
                   const upstream = traceOpticalPath(cable.from, "CABLE", cable.id, i);
                   if (upstream !== null) s = upstream - cLoss;
               }
               if (s !== null) {
                   const sColor = s >= -25 ? "#3fb950" : s >= -28 ? "#d29922" : "#f85149";
                   const dotColor = FIBER_COLORS[i % 12];
                   let bdr = dotColor === "#000000" ? "border: 1px solid #777;" : "border: 1px solid rgba(255,255,255,0.2);";
                   if (dotColor === "#000000") bdr += " box-shadow: 0 0 2px #fff;";
                   
                   activeCoresHtml += `<span class='mm-edge-label-box'><span class='mm-fiber-dot' style='background:${dotColor} !important; ${bdr}'></span><span class='mm-fiber-text'>${i+1}</span>${portStr}<span class='mm-fiber-sig' style='color:${sColor} !important;'>⚡${s.toFixed(1)}</span></span>`;
               }
            }
            const dist = (connKm(cable) * 1000).toFixed(0);
            const loss = cLoss.toFixed(2);
            let coresDiv = activeCoresHtml ? `<br/><div style='display:flex; flex-wrap:wrap; justify-content:center; max-width:160px; margin-top:4px;'>${activeCoresHtml}</div>` : "";
            let branchLbl = incomingBranchLabel ? `<b style='color:#e3b341;'>${incomingBranchLabel}</b><br/>` : "";
            edgeText = `|"<div style='text-align:center; font-size:11px;'>${branchLbl}<b style='color:#58a6ff;'>${cable.capacity}F</b> (${dist}м / -${loss}дБ)${coresDiv}</div>"|`;
        }
        
        // Draw incoming cable to the entry nodes
        const actualParent = incomingCoreNodeId || parentId;
        if (routingInNodeId) {
            m += `  ${actualParent} --> ${edgeText} ${routingInNodeId}\n`;
        } else {
            entryNodeIds.forEach(en => {
                m += `  ${actualParent} --> ${edgeText} ${en}\n`;
            });
        }
    }

    // Now call for downstream cables, passing the calculated out nodes
    downCables.forEach(dc => {
      let outNodeId = outCableNodes[dc.id];
      let outBranchLabel = outCableLabels[dc.id] || "";
      const targetNode = dc.to;
      if (targetNode) {
          if (targetNode.type === "FOB") renderMermaidFob(/** @type {FOBNode} */ (targetNode), dc, fId, outNodeId, outBranchLabel);
          else if (targetNode.type === "MDU") renderMermaidMDU(/** @type {MDUNode} */ (targetNode), dc, fId, outNodeId, outBranchLabel);
      }
    });

    // Downstream patchcords (ONUs / MDUs)
    const patchcords = conns.filter(c => c.from === fob && c.type === "patchcord");
    if (patchcords.length > 0) {
        // Group patchcords by their source node (splitter or transit) inside this FOB
        const groups = {};
        
        patchcords.forEach(pc => {
            const pcXc = (fob.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === pc.id);
            let srcNodeId = fId;
            if (pcXc) {
                if (pcXc.fromType === "SPLITTER" && spNodes[pcXc.fromId]) srcNodeId = spNodes[pcXc.fromId];
                else if (pcXc.fromType === "CABLE" && spNodes["transit"]) srcNodeId = spNodes["transit"];
            } else if (splitters.length > 0) srcNodeId = spNodes[splitters[splitters.length-1].id];
            
            if (!groups[srcNodeId]) groups[srcNodeId] = [];
            groups[srcNodeId].push(pc.to);
        });

        // Loop through grouped destinations and generate blocks
        Object.keys(groups).forEach((srcNodeId, index) => {
            const onus = groups[srcNodeId].filter(Boolean);
            if (onus.length === 0) return;

            const gId = safeId(fob.id + "_subs_" + index);
            let lines = [];
            
            let onuLinks = onus.filter(o => o.type === "ONU").map(o => `<a href="#focus" data-focus-id="${o.id}" class="mm-subs-link">${o.name}</a>`);
            let mduLinks = onus.filter(o => o.type === "MDU").map(o => `<a href="#focus" data-focus-id="${o.id}" class="mm-subs-link-mdu">${o.name}</a>`);
            
            if (onuLinks.length > 0) {
                const chunks = [];
                for (let i = 0; i < onuLinks.length; i += 4) {
                     chunks.push(onuLinks.slice(i, i+4).join(", "));
                }
                lines.push(`🏠 <b>ONU (${onuLinks.length}):</b><br/>` + chunks.join("<br/>"));
            }
            
            if (mduLinks.length > 0) {
                const chunks = [];
                for (let i = 0; i < mduLinks.length; i += 4) {
                     chunks.push(mduLinks.slice(i, i+4).join(", "));
                }
                lines.push(`🏢 <b>MDU (${mduLinks.length}):</b><br/>` + chunks.join("<br/>"));
            }
            
            // To compute correct signal for this block, trace one ONU
            const sampleOnu = onus[0];
            const onuSig = hasOLTPath(fob) ? sigAtONU(sampleOnu) : null;
            const sColor = onuSig !== null ? (onuSig >= -25 ? "#3fb950" : onuSig >= -28 ? "#d29922" : "#f85149") : "#8b949e";
            const oSigStr = onuSig !== null ? `⚡ ${onuSig.toFixed(1)} дБ` : "No Sig";
            
            m += `  ${gId}(["${lines.join("<br/>")}<br/><b style='color:${sColor};'>${oSigStr}</b>"]):::subs\n`;
            m += `  ${srcNodeId} -..-> ${gId}\n`;
        });
    }
}

function getSpIcon(type, ratio) {
  // Using solid hexagon symbol to match FontAwesome
  return "⬢";
}

  function renderMermaidMDU(mdu, cable, parentId, incomingCoreNodeId = undefined, incomingBranchLabel = "") {
    const fId = safeId(mdu.id);
    
    // Correctly fetch entry signal for FTTH / FTTB
    const sig = calculateMDUSignal(mdu);
    let sigStr = sig !== null ? `⚡ ${sig.toFixed(1)} дБ` : "No Sig";
    if (mdu.architecture === "FTTB") {
        const inCables = conns.filter(c => c.to === mdu && c.type === "cable");
        if (inCables.length > 0) {
            const inC = inCables[0];
            let s = null;
            if (inC.from.type === "OLT") {
                s = inC.from.outputPower;
            } else if (inC.from.type === "FOB") {
                s = traceOpticalPath(/** @type {FOBNode} */ (inC.from), "CABLE", inC.id, 0);
            }
            if (s !== null) sigStr = `⚡ ${(s - connKm(inC) * FIBER_DB_KM).toFixed(1)} дБ`;
        }
    }

    let actOnu = 0;
    if (mdu.architecture === "FTTB") {
        const pen = typeof mdu.penetrationRate === "number" ? mdu.penetrationRate : 100;
        actOnu = Math.ceil(((mdu.floors || 0) * (mdu.entrances || 0) * (mdu.flatsPerFloor || 0)) * (pen / 100));
    } else {
        const flats = mdu.flats || [];
        actOnu = flats.length; // Active physical drops linked in crossConnect
    }

    m += `  subgraph ${fId} ["🏢 ${mdu.name} (${mdu.architecture || 'FTTH'} | ${sigStr})"]\n`;
    m += `    direction TB\n`;

      if (mdu.architecture === "FTTB") {
          const swNid = `${fId}_switch`;
          m += `    ${swNid}(["Активний Свіч (${actOnu} Абон)"]):::subs\n`;
          m += `    click ${swNid} "javascript:window.focusNode('${mdu.id}')"\n`;
          
          if (parentId) {
               const cLoss = connKm(cable) * FIBER_DB_KM;
               m += `    ${incomingCoreNodeId || parentId} --> |"<div style='font-size:10px;text-align:center;'>${cable.capacity}F<br/>-${cLoss.toFixed(2)}дБ</div>"| ${swNid}\n`;
          }
          m += `  end\n`;
          return;
      }

      // FTTH Internal Rendering
      const amBox = mdu.mainBox || { splitters: [], crossConnects: [] };
      const fBoxes = mdu.floorBoxes || [];
      const spNodes = {};
      
      // Generate Splitter Labels for Colors
      const spLabels = {};
      const allMduSplitters = [...amBox.splitters];
      fBoxes.forEach(fb => allMduSplitters.push(...fb.splitters));
      
      const spCurrent = {};
      allMduSplitters.forEach(sp => {
          const key = `${sp.type}_${sp.ratio}`;
          if (!spCurrent[key]) spCurrent[key] = 1;
          else spCurrent[key]++;
          
          if (allMduSplitters.filter(s => s.type === sp.type && s.ratio === sp.ratio).length > 1) {
              spLabels[sp.id] = `${sp.type} ${sp.ratio} #${spCurrent[key]}`;
          } else {
              spLabels[sp.id] = `${sp.type} ${sp.ratio}`;
          }
      });
      
      // --- NEW LOGIC: Pre-calculate flat connections ---
      const flatConnections = {}; // spId -> array of { flat: N, sig: X }
      const dFlats = mdu.flats || [];
      dFlats.forEach(f => {
         if (f.crossConnect && f.crossConnect.toType === "UNIT" && f.crossConnect.fromType === "SPLITTER") {
             const spId = f.crossConnect.fromId;
             if (!flatConnections[spId]) flatConnections[spId] = [];
             
             let port = f.crossConnect.fromCore !== undefined ? f.crossConnect.fromCore : (f.crossConnect.fromBranch || "1");
             let s = typeof getMduSig === "function" ? getMduSig(mdu, "spOut", spId + "|" + port) : null;
             flatConnections[spId].push({ flat: f.flat, sig: s });
         }
      });
      
      function getFlatsHtmlForSplitter(spId) {
          const flats = flatConnections[spId];
          if (!flats || flats.length === 0) return "";
          flats.sort((a,b) => a.flat - b.flat);
          const flatStrings = flats.map(f => `<b>${f.flat}</b>${f.sig !== null ? `(<span style='color:#3fb950'>⚡${f.sig.toFixed(1)}</span>)` : ''}`);
          const chunks = [];
          for (let i = 0; i < flatStrings.length; i += 3) {
              chunks.push(flatStrings.slice(i, i + 3).join(', '));
          }
          return `<br/><hr style='margin:4px 0; border:none; border-top:1px solid rgba(255,255,255,0.2);'/>🏠 Кв: <span style='font-size:9px'>${chunks.join('<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;')}</span>`;
      }

      // Main Box Splitters
    amBox.splitters.forEach(sp => {
        const spNid = `${fId}_m_${safeId(sp.id)}`;
        spNodes[sp.id] = spNid;
        
        let s = sigSplitter(mdu, sp.id); // Get input signal if possible
        let sigText = s !== null ? `<br/><b style='color:#3fb950;font-size:10px'>⚡ ${s.toFixed(1)} дБ</b>` : "";
        let spLabel = spLabels && spLabels[sp.id] ? spLabels[sp.id] : `${sp.type} ${sp.ratio}`;
        let hexColor = typeof getSplitterColor === "function" ? getSplitterColor(sp.type, sp.ratio, spLabel) : "#58a6ff";
        
        let flatsHtml = getFlatsHtmlForSplitter(sp.id);
        
        m += `    ${spNid}(["⬢ Горище: ${spLabel}${sigText}${flatsHtml}"]):::fob\n`;
        m += `    style ${spNid} stroke:${hexColor},color:${hexColor},stroke-width:2px;\n`;
    });
      
      // Main Box XC
      amBox.crossConnects.forEach(x => {
          if (x.fromType === "SPLITTER" && x.toType === "SPLITTER" && spNodes[x.fromId] && spNodes[x.toId]) {
              m += `    ${spNodes[x.fromId]} -- "${x.fromBranch||x.fromCore||''}" --> ${spNodes[x.toId]}\n`;
          }
      });

      // --- GROUP FLOORS BY ENTRANCE ---
      const entrancesMap = {};
      fBoxes.forEach(fb => {
          if (!entrancesMap[fb.entrance]) entrancesMap[fb.entrance] = [];
          entrancesMap[fb.entrance].push(fb);
      });

      // Entrances Box Splitters
      Object.keys(entrancesMap).forEach(entNumStr => {
          const entNum = parseInt(entNumStr);
          m += `    subgraph ${fId}_ent_${entNum} ["🚪 Під'їзд ${entNum}"]\n`;
          m += `      direction TB\n`;
          
          entrancesMap[entNumStr].forEach(fb => {
              fb.splitters.forEach(sp => {
                  const spNid = `${fId}_f_${safeId(sp.id)}`;
                  spNodes[sp.id] = spNid;
                  
                  let s = sigSplitter(mdu, sp.id); // Get input signal
                  let sigText = s !== null ? `<br/><b style='color:#3fb950;font-size:10px'>⚡ ${s.toFixed(1)} дБ</b>` : "";
                  let spLabel = spLabels && spLabels[sp.id] ? spLabels[sp.id] : `${sp.type} ${sp.ratio}`;
                  let hexColor = typeof getSplitterColor === "function" ? getSplitterColor(sp.type, sp.ratio, spLabel) : "#58a6ff";
                  
                  let flatsHtml = getFlatsHtmlForSplitter(sp.id);
                  
                  m += `      ${spNid}(["⯁ Пов. ${fb.floor}: ${spLabel}${sigText}${flatsHtml}"]):::fob\n`;
                  m += `      style ${spNid} stroke:${hexColor},color:${hexColor},stroke-width:2px;\n`;
              });
          });
          m += `    end\n`;
          
          entrancesMap[entNumStr].forEach(fb => {
              fb.crossConnects.forEach(x => {
                   if (x.toType === "SPLITTER" && spNodes[x.toId] && spNodes[x.fromId]) {
                       m += `    ${spNodes[x.fromId]} -. "${x.fromBranch||x.fromCore||''}" .-> ${spNodes[x.toId]}\n`;
                   }
              });
          });
      });

      // Entry cables
      let entryTargets = []; 
      if (cable) {
          const incomingXcs = amBox.crossConnects.filter(x => x.fromType === "CABLE" && String(x.fromId) === String(cable.id));
          incomingXcs.forEach(x => {
              if (x.toType === "SPLITTER" && spNodes[x.toId]) {
                  entryTargets.push({ id: spNodes[x.toId], coreIndex: x.fromCore });
              }
          });
          
          fBoxes.forEach(fb => {
             const fbXcs = fb.crossConnects.filter(x => x.fromType === "CABLE" && String(x.fromId) === String(cable.id));
             fbXcs.forEach(x => {
                 if (x.toType === "SPLITTER" && spNodes[x.toId]) {
                      entryTargets.push({ id: spNodes[x.toId], coreIndex: x.fromCore });
                 }
             });
          });
      }

      if (parentId) {
          const cLoss = connKm(cable) * FIBER_DB_KM;
          let routingInNodeId = `${fId}_in_${safeId(String(cable.id))}`;
          m += `    ${routingInNodeId}(("Вхід кабелю")):::fob\n`;
          m += `    ${incomingCoreNodeId || parentId} --> |"<div style='font-size:10px;text-align:center;'>${cable.capacity}F<br/>-${cLoss.toFixed(2)}дБ</div>"| ${routingInNodeId}\n`;
          
          entryTargets.forEach(t => {
              m += `    ${routingInNodeId} -. "Жила ${t.coreIndex+1}" .-> ${t.id}\n`;
          });
          
          if(entryTargets.length === 0 && Object.keys(spNodes).length > 0) {
              m += `    ${routingInNodeId} -.-> ${Object.values(spNodes)[0]}\n`;
          }
      }
      
      m += `  end\n`;
  }

  // Iterate OLTs
  olts.forEach(olt => {
      const oltId = safeId(olt.id);
      m += `  ${oltId}(["🗄️ ${olt.name}<br/><b>Output: ${olt.outputPower} дБ</b><br/><small>${olt.ports} PON порт(ів)</small>"]):::olt\n`;
      m += `  click ${oltId} "javascript:window.focusNode('${olt.id}')" "Показати на карті"\n`;
      
      const connectedCableIds = new Set();
      (olt.crossConnects || []).forEach(xc => {
          if (xc.toType === "CABLE") connectedCableIds.add(String(xc.toId));
      });
      conns.filter(c => c.from === olt && c.type === "cable").forEach(c => connectedCableIds.add(String(c.id)));
      
      connectedCableIds.forEach(cableId => {
          const cable = conns.find(c => String(c.id) === cableId);
          const targetNode = cable ? cable.to : null;
          if (cable && targetNode) {
              if (targetNode.type === "FOB") renderMermaidFob(/** @type {FOBNode} */ (targetNode), cable, oltId, undefined);
              else if (targetNode.type === "MDU") renderMermaidMDU(/** @type {MDUNode} */ (targetNode), cable, oltId, undefined);
          }
      });
  });

  try {
      // @ts-ignore
      if (typeof mermaid === "undefined") {
          document.getElementById("mermaid-container").innerHTML = `<div style="padding:20px; color:#ff5555;">Помилка: Бібліотека Mermaid не завантажена. Перевірте підключення до Інтернету.</div>`;
          return;
      }
      
      // @ts-ignore
      mermaid.initialize({ 
        startOnLoad: false, 
        theme: 'base', 
        securityLevel: 'loose',
        themeVariables: {
          primaryColor: '#161b22',
          primaryTextColor: '#c9d1d9',
          primaryBorderColor: '#30363d',
          lineColor: '#58a6ff',
          secondaryColor: '#21262d',
          tertiaryColor: '#0d1117',
          nodeBorder: '#58a6ff',
          clusterBkg: '#0d1117',
          clusterBorder: '#30363d',
          fontSize: '12px',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        },
        flowchart: {
          htmlLabels: true,
          curve: 'basis'
        }
      });
      
      // Render
      const container = document.getElementById("mermaid-container");
      // @ts-ignore
      window._lastMermaidMarkup = m;
      const { svg } = await mermaid.render('mermaid-svg-chart', m);
      container.innerHTML = svg;
      
      const svgElement = container.querySelector('svg');
      
      // Delegated click listener for HTML nodes stripped by DOMPurify
      container.addEventListener("click", (e) => {
          const target = /** @type {HTMLElement} */ (e.target).closest("a[data-focus-id]");
          if (target) {
              e.preventDefault();
              e.stopPropagation();
              const id = target.getAttribute("data-focus-id");
              if (id && typeof window.focusNode === "function") {
                  window.focusNode(id);
              }
          }
      });
      
      if (svgElement) {
          svgElement.setAttribute("height", "100%");
          svgElement.setAttribute("width", "100%");
          svgElement.style.width = "100%";
          svgElement.style.height = "100%";
          svgElement.style.maxWidth = "none"; // Override mermaid default max-width
          svgElement.style.maxHeight = "none";
          // Important: remove the hardcoded viewBox if panning takes over, or let svgPanZoom handle it.
          
          // Add pan/zoom
          // @ts-ignore
          if (typeof svgPanZoom !== "undefined") {
            // @ts-ignore
            svgPanZoom(svgElement, {
                zoomEnabled: true,
                controlIconsEnabled: true,
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 10
            });
          }
      }
      
  } catch (err) {
      console.error("Mermaid Render Error:", err, "\nCode:\n", m);
      document.getElementById("mermaid-container").innerHTML = `<div style="padding:20px; color:#ff5555;">Помилка рендерингу топології.<br><small>${err.message}</small></div>`;
  }
}

// Helper: calculate total loss for current FOB splitter setup
// For FBT+PLC combo: returns X branch + PLC loss + 2x MECH
// For PLC-only: returns PLC loss + MECH
// Legacy getTotalLoss removed, Fob Stats now handles splitters.

// Helper: get loss for selected splitter type in scenario
// "keep" = keep original, "PLC 1x8" = PLC only, "FBT 10/90" = FBT only (X branch)
/**
 * @param {string} selectedSplitter
 * @param {number} originalLoss
 * @returns {number}
 */
function getScenarioLoss(selectedSplitter, originalLoss) {
  if (selectedSplitter === "keep") {
    return originalLoss;
  }
  if (selectedSplitter.startsWith("PLC ")) {
    const plcType = selectedSplitter.replace("PLC ", "");
    return PLC_LOSSES[plcType] + MECH;
  }
  if (selectedSplitter.startsWith("FBT ")) {
    const fbtType = selectedSplitter.replace("FBT ", "");
    if (FBT_LOSSES[fbtType]) {
      // Use X branch (tap) + MECH for FBT-only scenario
      return FBT_LOSSES[fbtType].x + MECH;
    }
  }
  return 0;
}

// Helper no longer needed globally, will be inlined.

export function showScenarioCompare() {
  const current = [];
  
  nodes.filter(n => n.type === "FOB").forEach((/** @type {FOBNode} */ fob) => {
    const splitters = fob.splitters || [];
    let spList = [...splitters];
    if (fob.fbtType && !spList.some(s => s.id === "legacy_fbt")) {
        spList.push({ id: "legacy_fbt", type: "FBT", ratio: fob.fbtType });
    }
    if (fob.plcType && !spList.some(s => s.id === "legacy_plc")) {
        spList.push({ id: "legacy_plc", type: "PLC", ratio: fob.plcType });
    }
    
    if (spList.length === 0) return;
    
    let oltName = "?";
    let oltPort = null;
    let climb = fob;
    const visited = new Set();
    while (climb && climb.inputConn && !visited.has(climb.id)) {
       visited.add(climb.id);
       if (climb.inputConn.from.type === "OLT") {
          oltName = climb.inputConn.from.name || "OLT";
          const xc = (climb.inputConn.from.crossConnects || []).find(x => x.toType === "CABLE" && x.toId === climb.inputConn.id);
          if (xc) oltPort = parseInt(String(xc.fromId)) + 1;
          break;
       }
       climb = /** @type {FOBNode} */ (climb.inputConn.from);
    }

    spList.forEach((sp, idx) => {
       const sigInSp = hasOLTPath(fob) ? sigIn(fob) : null;
       
       let origLoss = 0;
       if (sp.type === "PLC") origLoss = (PLC_LOSSES[sp.ratio] || 0) + MECH;
       if (sp.type === "FBT") origLoss = FBT_LOSSES[sp.ratio] ? FBT_LOSSES[sp.ratio].x + MECH : 0;
       
       const sigOutSp = sigInSp !== null ? sigInSp - origLoss : null;
       
       let label = `${sp.type} ${sp.ratio}`;
       if (spList.filter(s => s.type === sp.type && s.ratio === sp.ratio).length > 1) {
           label += ` #${idx+1}`;
       }

       current.push({
         fobId: fob.id,
         spId: sp.id,
         name: fob.name,
         splitter: label,
         spType: sp.type,
         sigIn: sigInSp,
         sigOut: sigOutSp,
         origLoss: origLoss,
         oltName: oltName,
         oltPort: oltPort,
       });
    });
  });

  // Available splitter options for dropdown
  const splitterOptions = [
    { value: "keep", label: "Залишити як є" },
    { value: "PLC 1x2", label: "PLC 1×2" },
    { value: "PLC 1x4", label: "PLC 1×4" },
    { value: "PLC 1x8", label: "PLC 1×8" },
    { value: "PLC 1x16", label: "PLC 1×16" },
    { value: "PLC 1x32", label: "PLC 1×32" },
    { value: "PLC 1x64", label: "PLC 1×64" },
    { value: "FBT 5/95", label: "FBT 5/95" },
    { value: "FBT 10/90", label: "FBT 10/90" },
    { value: "FBT 20/80", label: "FBT 20/80" },
    { value: "FBT 30/70", label: "FBT 30/70" },
    { value: "FBT 50/50", label: "FBT 50/50" },
  ];

  // Function to recalculate scenario row
  function recalcRow(fobId, spId, selectedSplitter) {
    const item = current.find((c) => c.fobId === fobId && c.spId === spId);
    if (!item) return null;

    const lossNew = getScenarioLoss(selectedSplitter, item.origLoss);
    
    const newSigIn = item.sigIn; 
    const newSigOut = item.sigIn !== null ? item.sigIn - lossNew : null;
    const visualDelta = newSigOut !== null && item.sigOut !== null ? newSigOut - item.sigOut : 0;
    
    const newSplitter = selectedSplitter === "keep" ? item.splitter : selectedSplitter;

    return {
      ...item,
      newSplitter,
      newSigIn,
      newSigOut,
      delta: visualDelta,
      lossNew,
    };
  }

  // Function to update table row
  function updateRow(rowIndex, result) {
    let row = document.querySelector(`tr[data-fob-id="${result.fobId}"][data-sp-id="${result.spId}"]`);
    if (!row) {
      const allRows = document.querySelectorAll(`#scenario-table tbody tr:not(.scenario-group-header)`);
      row = allRows[rowIndex];
    }
    if (!row) return;

    const cIn = result.sigIn !== null
      ? sigClass(result.sigIn) === "ok" ? "sig-ok"
      : sigClass(result.sigIn) === "warn" ? "sig-warn"
      : "sig-err" : "";
    const cOut = result.sigOut !== null
      ? sigClass(result.sigOut) === "ok" ? "sig-ok"
      : sigClass(result.sigOut) === "warn" ? "sig-warn"
      : "sig-err" : "";
      
    const nIn = result.newSigIn !== null
      ? sigClass(result.newSigIn) === "ok" ? "sig-ok"
      : sigClass(result.newSigIn) === "warn" ? "sig-warn"
      : "sig-err" : "";
    const nOut = result.newSigOut !== null
      ? sigClass(result.newSigOut) === "ok" ? "sig-ok"
      : sigClass(result.newSigOut) === "warn" ? "sig-warn"
      : "sig-err" : "";
      
    const dStr = result.delta > 0 ? `+${result.delta.toFixed(1)}` : result.delta.toFixed(1);
    const dCls = result.delta < 0 ? "sig-err" : result.delta > 0 ? "sig-ok" : "";

    const cells = row.querySelectorAll("td");
    if (cells.length >= 8) {
      cells[2].className = cIn;
      cells[2].textContent = result.sigIn !== null ? result.sigIn.toFixed(1) : "—";
      cells[3].className = cOut;
      cells[3].textContent = result.sigOut !== null ? result.sigOut.toFixed(1) : "—";
      cells[5].className = nIn;
      cells[5].textContent = result.newSigIn !== null ? result.newSigIn.toFixed(1) : "—";
      cells[6].className = nOut;
      cells[6].textContent = result.newSigOut !== null ? result.newSigOut.toFixed(1) : "—";
      cells[7].className = dCls;
      cells[7].textContent = `${dStr} дБ`;
    }
  }

  // Group FOBs by OLT port (preserve original index for recalcRow)
  const grouped = {};
  current.forEach((item, originalIdx) => {
    item._originalIdx = originalIdx; // Store original index for recalcRow
    const key = item.oltPort !== null 
      ? `${item.oltName} - Порт ${item.oltPort}` 
      : "Не підключено";
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(item);
  });

  // Sort groups by OLT name and port number
  const sortedGroups = Object.keys(grouped).sort((a, b) => {
    if (a === "Не підключено") return 1;
    if (b === "Не підключено") return -1;
    return a.localeCompare(b);
  });

  let html = `<div class="report-section" style="max-height: 80vh; overflow-y: auto;">
    <p style="margin-bottom:12px;color:#8b949e;font-size:12px">Оберіть сплітер для кожного FOB, щоб побачити вплив на сигнал. Зміни застосовуються автоматично.</p>
    <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;justify-content:flex-end">
      <button id="scenario-reset-btn" class="modal-btn">
        ↺ Скинути всі
      </button>
    </div>
    <table id="scenario-table"><thead><tr>
      <th>FOB</th><th>Зараз</th><th>Вхід сплітера</th><th>Вихід (гілка)</th>
      <th>Сценарний варіант</th><th>Новий Вхід</th><th>Новий Вихід</th><th>Δ Сигналу</th>
    </tr></thead><tbody>`;

  let globalRowIdx = 0;
  sortedGroups.forEach((groupKey) => {
    const groupItems = grouped[groupKey];
    
    // Add group header row
    html += `<tr class="scenario-group-header" style="background:rgba(88,166,255,0.1);border-top:2px solid #58a6ff;">
      <td colspan="8" style="padding:8px 12px;font-weight:600;color:#58a6ff;font-size:12px;">
        🔌 ${groupKey} (${groupItems.length} сплітерів)
      </td>
    </tr>`;

    groupItems.forEach((item) => {
    const defaultSplitter = "keep"; // Default: keep current splitter
    const result = recalcRow(item.fobId, item.spId, defaultSplitter);

    const cIn = item.sigIn !== null
      ? sigClass(item.sigIn) === "ok" ? "sig-ok"
      : sigClass(item.sigIn) === "warn" ? "sig-warn"
      : "sig-err" : "";
    const cOut = item.sigOut !== null
      ? sigClass(item.sigOut) === "ok" ? "sig-ok"
      : sigClass(item.sigOut) === "warn" ? "sig-warn"
      : "sig-err" : "";
      
    const nIn = result.newSigIn !== null
      ? sigClass(result.newSigIn) === "ok" ? "sig-ok"
      : sigClass(result.newSigIn) === "warn" ? "sig-warn"
      : "sig-err" : "";
    const nOut = result.newSigOut !== null
      ? sigClass(result.newSigOut) === "ok" ? "sig-ok"
      : sigClass(result.newSigOut) === "warn" ? "sig-warn"
      : "sig-err" : "";
      
    const dStr = result.delta > 0 ? `+${result.delta.toFixed(1)}` : result.delta.toFixed(1);
    const dCls = result.delta < 0 ? "sig-err" : result.delta > 0 ? "sig-ok" : "";

      const optionsHtml = splitterOptions.map(opt => 
        `<option value="${opt.value}" ${opt.value === defaultSplitter ? "selected" : ""}>${opt.label}</option>`
      ).join("");

      html += `<tr data-fob-id="${item.fobId}" data-sp-id="${item.spId}">
        <td class="td-name">${item.name}</td>
        <td>${item.splitter}</td>
        <td class="${cIn}">${item.sigIn !== null ? item.sigIn.toFixed(1) : "—"}</td>
        <td class="${cOut}">${item.sigOut !== null ? item.sigOut.toFixed(1) : "—"}</td>
        <td><select class="scenario-splitter-select" data-row="${item._originalIdx}" data-fob-id="${item.fobId}" data-sp-id="${item.spId}" style="min-width:120px;padding:4px 6px;font-size:11px">
          ${optionsHtml}
        </select></td>
        <td class="${nIn}">${result.newSigIn !== null ? result.newSigIn.toFixed(1) : "—"}</td>
        <td class="${nOut}">${result.newSigOut !== null ? result.newSigOut.toFixed(1) : "—"}</td>
        <td class="${dCls}">${dStr} дБ</td>
      </tr>`;
      
      globalRowIdx++;
    });
  });
  html += `</tbody></table></div>`;

  if (current.length === 0) {
    html = `<div style="text-align:center;color:#6e7681;padding:30px">Немає FOB зі сплітерами для порівняння</div>`;
  }

  document.getElementById("modal-body").innerHTML = html;
  
  // Function to reset all selections to "keep"
  function resetAllSelections() {
    current.forEach((item) => {
      const select = document.querySelector(`.scenario-splitter-select[data-fob-id="${item.fobId}"][data-sp-id="${item.spId}"]`);
      if (select) {
        /** @type {HTMLSelectElement} */ (select).value = "keep";
        const result = recalcRow(item.fobId, item.spId, "keep");
        if (result) {
          const row = document.querySelector(`tr[data-fob-id="${item.fobId}"][data-sp-id="${item.spId}"]`);
          if (row) {
            const allRows = Array.from(document.querySelectorAll("#scenario-table tbody tr:not(.scenario-group-header)"));
            const domRowIdx = allRows.indexOf(row);
            if (domRowIdx >= 0) {
              updateRow(domRowIdx, result);
            }
          }
        }
      }
    });
  }

  // Attach event listeners to dropdowns - changes apply automatically
  document.querySelectorAll(".scenario-splitter-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      const tgt = /** @type {HTMLSelectElement} */ (e.target);
      const rowIdx = parseInt(tgt.dataset.row || "0");
      const fobId = tgt.dataset.fobId || current[rowIdx]?.fobId;
      const spId = tgt.dataset.spId || current[rowIdx]?.spId;
      const selected = tgt.value;
      const result = recalcRow(fobId, spId, selected);
      if (result) {
        const row = document.querySelector(`tr[data-fob-id="${fobId}"][data-sp-id="${spId}"]`);
        if (row) {
          const allRows = Array.from(document.querySelectorAll("#scenario-table tbody tr:not(.scenario-group-header)"));
          const domRowIdx = allRows.indexOf(row);
          if (domRowIdx >= 0) {
            updateRow(domRowIdx, result);
          }
        }
      }
    });
  });

  // Attach event listener to reset button
  document.getElementById("scenario-reset-btn")?.addEventListener("click", resetAllSelections);

  const h2 = document
    .getElementById("modal-overlay")
    .querySelector("h2");
  if (h2) h2.textContent = "🔄 Порівняння сценаріїв";
  document.getElementById("modal-overlay").classList.add("open");
}

export function openHelp() {
  // Open onboarding modal with Tab 3 (Затухання) active
  switchOnboardingTab(2);
  const overlay = document.getElementById("onboarding-overlay");
  const checkbox = document.getElementById("onboarding-dont-show");
  const cb = /** @type {HTMLInputElement | null} */ (checkbox);
  if (cb) cb.checked = localStorage.getItem("pon_onboarding_dismissed") === "true";
  if (overlay) overlay.style.display = "flex";
}

export function closeHelp() {
  // Legacy: close onboarding overlay (help modal no longer exists separately)
  const overlay = document.getElementById("onboarding-overlay");
  if (overlay) overlay.style.display = "none";
}

export function switchOnboardingTab(index) {
  const overlay = document.getElementById("onboarding-overlay");
  if (!overlay) return;
  const tabs = overlay.querySelectorAll(".onboarding-tabs .tab-btn");
  const contents = overlay.querySelectorAll(".onboarding-tab-content");
  tabs.forEach((t, i) => {
    t.classList.toggle("active", i === index);
  });
  contents.forEach((c, i) => {
    c.classList.toggle("active", i === index);
  });
}

/**
 * Update the validation badge counter on the sidebar button.
 * Counts network issues without opening the modal.
 */
export function updateValidationBadge() {
  let count = 0;

  // Disconnected FOBs
  nodes
    .filter((n) => n.type === "FOB")
    .forEach((fob) => {
      const inCables = conns.filter(c => c.to === fob && c.type === "cable");
      if (inCables.length === 0) count++;
    });

  // Disconnected ONUs & MDUs
  nodes
    .filter((n) => n.type === "ONU" || n.type === "MDU")
    .forEach((onu) => {
      const hasConn = conns.some((c) => c.to === onu && (c.type === "patchcord" || (onu.type === "MDU" && c.type === "cable")));
      if (!hasConn) count++;
    });

  // Weak signals
  nodes
    .filter((n) => n.type === "FOB")
    .forEach((/** @type {FOBNode} */ fob) => {
      const inCables = conns.filter(c => c.to === fob && c.type === "cable");
      const hasSplitters = (fob.splitters && fob.splitters.length > 0) || fob.fbtType || fob.plcType;
      if (inCables.length > 0 && hasSplitters) {
        const sig = sigONU(fob);
        if (sig !== null && sig < ONU_MIN) count++;
      }
    });

  // Port overloads
  nodes
    .filter((n) => n.type === "OLT")
    .forEach((olt) => {
      for (let i = 0; i < olt.ports; i++) {
        const c = cntONUport(olt, i);
        const max = olt.maxOnuPerPort || 64;
        if (c > max) count++;
      }
    });

  // Long cables
  count += conns.filter((c) => c.type === "cable" && connKm(c) > 5).length;

  // Loops (FOB chains)
  nodes
    .filter((n) => n.type === "FOB")
    .forEach((fob) => {
      const visited = new Set();
      let cur = fob;
      while (cur && cur.type === "FOB") {
        if (visited.has(cur.id)) {
          count++;
          break;
        }
        visited.add(cur.id);
        const inCables = conns.filter(c => c.to === cur && c.type === "cable");
        const fromFobCables = inCables.filter(c => c.from && c.from.type === "FOB");
        if (fromFobCables.length === 0) break;
        cur = /** @type {FOBNode} */ (fromFobCables[0].from);
      }
    });

  const badge = document.getElementById("badge-validation");
  if (badge) {
    badge.textContent = count > 0 ? String(count) : "";
    badge.className = count > 0 ? "badge badge-red" : "badge badge-green";
  }
}

export async function exportTopologyPng() {
  if (!window._lastMermaidMarkup) {
    alert("Графік топології ще формується або порожній.");
    return;
  }

  const btn = document.getElementById("btn-export-png");
  if (btn) {
    btn.innerHTML = "⏳...";
    btn.style.pointerEvents = "none";
  }

  try {
    // Generate a perfectly fresh, un-zoomed, pristine SVG from the saved markup
    // @ts-ignore
    const { svg } = await mermaid.render('mermaid-svg-export-' + Date.now(), window._lastMermaidMarkup);
    
    // Convert to a temporary DOM node to extract the exact Native dimensions
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = svg;
    const svgClone = /** @type {SVGSVGElement} */ (tempDiv.querySelector("svg"));
    
    let w = 800, h = 600;
    const vb = svgClone.getAttribute("viewBox");
    if (vb) {
      const parts = vb.split(/[\s,]+/);
      w = parseFloat(parts[2]) || 800;
      h = parseFloat(parts[3]) || 600;
      
      const pad = 60;
      const vx = parseFloat(parts[0]) || 0;
      const vy = parseFloat(parts[1]) || 0;
      w += pad * 2;
      h += pad * 2;
      svgClone.setAttribute("viewBox", `${vx - pad} ${vy - pad} ${w} ${h}`);
    }

    svgClone.setAttribute("width", String(w));
    svgClone.setAttribute("height", String(h));

    // Force default styles
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      svg { background-color: #0d1117; }
      * { font-family: system-ui, -apple-system, sans-serif !important; }
    `;
    svgClone.insertBefore(styleEl, svgClone.firstChild);

    // Render Natively
    const svgData = new XMLSerializer().serializeToString(svgClone);
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgData);

    const img = new Image();
    img.onload = () => {
      let renderScale = 3;
      const totalPixels = w * h;
      if (totalPixels > 10000000) renderScale = 1; 
      else if (totalPixels > 4000000) renderScale = 1.5;
      else if (totalPixels > 2000000) renderScale = 2;

      const canvas = document.createElement("canvas");
      canvas.width = w * renderScale;
      canvas.height = h * renderScale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      const a = document.createElement("a");
      a.download = getProjectFileName(`topology_${Date.now()}.png`);
      a.href = canvas.toDataURL("image/png");
      a.click();
      
      if (btn) { btn.innerHTML = "⬇ PNG"; btn.style.pointerEvents = "auto"; }
    };

    img.onerror = () => {
      if (typeof html2canvas === "undefined") {
        alert("Помилка генерації карти: браузер відхилив прямий рендеринг.");
        if (btn) { btn.innerHTML = "⬇ PNG"; btn.style.pointerEvents = "auto"; }
        return;
      }
      
      // Fallback
      const tempCon = document.createElement("div");
      tempCon.style.position = "absolute";
      tempCon.style.left = "0px";
      tempCon.style.top = "0px";
      tempCon.style.zIndex = "-9999";
      tempCon.style.pointerEvents = "none";
      tempCon.style.width = w + "px";
      tempCon.style.height = h + "px";
      tempCon.style.background = "#0d1117";
      
      svgClone.style.display = "block";
      tempCon.appendChild(svgClone);
      document.body.appendChild(tempCon);
      
      let renderScale = 3;
      if (w * h > 10000000) renderScale = 1; 
      else if (w * h > 4000000) renderScale = 1.5;
      else if (w * h > 2000000) renderScale = 2;

      // @ts-ignore
      html2canvas(tempCon, {
          backgroundColor: "#0d1117",
          scale: renderScale,
          useCORS: true,
          logging: false,
          width: w,
          height: h,
          windowWidth: w,
          windowHeight: h,
          x: 0,
          y: 0,
          scrollX: 0,
          scrollY: 0
      }).then(canvas => {
          document.body.removeChild(tempCon);
          const a = document.createElement("a");
          a.download = getProjectFileName(`topology_${Date.now()}.png`);
          a.href = canvas.toDataURL("image/png");
          a.click();
          if (btn) { btn.innerHTML = "⬇ PNG"; btn.style.pointerEvents = "auto"; }
      }).catch(err => {
          if (document.body.contains(tempCon)) document.body.removeChild(tempCon);
          alert("Помилка генерації PNG: " + err);
          if (btn) { btn.innerHTML = "⬇ PNG"; btn.style.pointerEvents = "auto"; }
      });
    };

    img.src = src;

  } catch (err) {
    alert("Помилка рендеру: " + err);
    if (btn) { btn.innerHTML = "⬇ PNG"; btn.style.pointerEvents = "auto"; }
  }
}
