// @ts-check
import { FBT_LOSSES, PLC_LOSSES, MECH, ONU_MIN, FIBER_DB_KM } from "./config.js";
import { sigClass } from "./utils.js";
import {
  nodes,
  conns,
  sigIn,
  sigONU,
  hasOLTPath,
  cntONUport,
  connKm,
  fitNetwork,
} from "./network.js";

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

  // Helper: extract base name
  function getBaseName(n, type) {
    if (n === type || new RegExp(`^${type}-\\d+$`).test(n)) return `${type} (модель не вказана)`;
    const match = n.match(/^([a-zA-Zа-яА-ЯіІїЇєЄ0-9_]+-\d+-\d+)/);
    return match ? match[1] : n;
  }

  // 1. Nodes
  nodes.forEach(n => {
    let price = typeof n.price === "number" ? n.price : 0;
    
    if (n.type === "OLT") {
      const portCount = n.ports || 4;
      let estModel = `OLT (на ${portCount} портів)`;
      if (price === 0) {
        add("Активне обладнання", estModel, 1, "шт.", price);
      } else {
        add("Активне обладнання", getBaseName(n.name, "OLT"), 1, "шт.", price);
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
      // Rough estimation: each cable entering means we splice at least 1 core, or maybe transit.
      // Easiest is to sum up all cores from all connected cables just to get a max capacity
      inOutCables.forEach(c => totalSplices += (c.capacity || 1));
      
      let splCount = splitters.length;
      if (splCount === 0 && (legacyPlc || legacyFbt)) splCount = (legacyPlc ? 1 : 0) + (legacyFbt ? 1 : 0);

      const cablePorts = inOutCables.length;
      const dropPorts = dropPatchcords.length;
      
      let estModel = "Муфта оптична";
      if (dropPorts > 0) {
        estModel = `Бокс PON (на ${Math.max(4, Math.ceil(dropPorts/4)*4)} абон., до ${cablePorts} вводів)`;
      } else {
        estModel = `Муфта (до ${cablePorts} вводів, ${Math.max(12, Math.ceil(totalSplices/12)*12)} зварок)`;
      }

      if (price === 0) {
        add("Пасивне обладнання", estModel, 1, "шт.", price);
      } else {
        add("Пасивне обладнання", getBaseName(n.name, "Крос/Муфта"), 1, "шт.", price);
      }
      
      // 2. Splitters (from FOBs)
      splitters.forEach(sp => add("Сплітери оптичні", `Сплітер ${sp.type} ${sp.ratio}`, 1, "шт.", 0));
      if (legacyFbt && !splitters.some(s => s.type === "FBT")) {
        add("Сплітери оптичні", `Сплітер FBT ${legacyFbt}`, 1, "шт.", 0);
      }
      if (legacyPlc && !splitters.some(s => s.type === "PLC")) {
        add("Сплітери оптичні", `Сплітер PLC ${legacyPlc}`, 1, "шт.", 0);
      }
    }
    else if (n.type === "ONU") {
      add("Абонентське обладнання", getBaseName(n.name, "ONU"), 1, "шт.", price);
    }
    else if (n.type === "MDU") {
      add("Абонентське обладнання", getBaseName(n.name, "MDU"), 1, "шт.", price);
    }
  });

  // 3. Cables & Patchcords
  conns.forEach(c => {
    if (c.type === "cable") {
      const cores = c.capacity || 1;
      const meters = connKm(c) * 1000;
      add("Кабелі магістральні", `Кабель оптичний ${cores}F`, meters, "м", 0);
    } else if (c.type === "patchcord") {
      // For cross-connect auto-transit or actual UI patches
      // We can count them by pieces or by length if desired. Usually drop cable is calculated.
      const meters = connKm(c) * 1000;
      // Many PONs count drop cables in meters, or as a fixed 100m drop cable "piece". Both work. We'll use meters for accuracy.
      add("Кабелі абонентські", "Drop-кабель (патчкорд)", meters, "м", 0);
      add("Монтажні матеріали", "Конектор швидкої фіксації / Патчкорд", 1, "шт.", 0);
    }
  });

  return items;
}


function buildReportData() {
  const rows = [];
  nodes
    .filter((n) => n.type === "FOB")
    .forEach((/** @type {FOBNode} */ fob) => {
      const inCables = conns.filter(x => x.to === fob && x.type === "cable");
      if (inCables.length === 0) {
        rows.push({ name: fob.name, status: "NOT_CONNECTED" });
        return;
      }
      const c = inCables[0]; // Primary incoming cable
      const dm = connKm(c) * 1000;
      const cLoss = (dm / 1000) * FIBER_DB_KM;
      const si = sigIn(fob) || 0;
      const so = fob.splitters?.length || fob.plcType || fob.fbtType ? sigONU(fob) : null;

      const splitters = fob.splitters || [];
      const fbts = splitters.filter(s => s.type === "FBT").map(s => s.ratio).join(", ") || fob.fbtType || "—";
      const plcs = splitters.filter(s => s.type === "PLC").map(s => s.ratio).join(", ") || fob.plcType || "—";

      rows.push({
        name: fob.name,
        from: c.from.name || c.from.type,
        branch: c.branch || "—",
        dist: dm.toFixed(1),
        cableLoss: cLoss.toFixed(3),
        mechLoss: MECH,
        signalIn: si.toFixed(2),
        fbt: fbts,
        xLoss: "—",
        yLoss: "—",
        plc: plcs,
        plcBranch: fob.plcBranch || "—",
        plcLoss: "—",
        signalONU: so !== null ? so.toFixed(2) : "—",
        onuCnt: conns.filter((x) => x.from === fob && x.type === "patchcord").reduce((acc, c) => acc + (c.to.type === "MDU" ? (c.to.floors || 0) * (c.to.entrances || 0) * (c.to.flatsPerFloor || 0) : 1), 0),
        status:
          so !== null
            ? so >= ONU_MIN
              ? "ok"
              : so >= ONU_MIN - 3
              ? "warn"
              : "err"
            : "info",
      });
    });
  return rows;
}

export function openReport() {
  const rows = buildReportData();
  const oltCount = nodes.filter((n) => n.type === "OLT").length;
  const fobCount = nodes.filter((n) => n.type === "FOB").length;
  let onuCount = 0;
  nodes.forEach((n) => {
    if (n.type === "ONU") onuCount++;
    if (n.type === "MDU") onuCount += (n.floors || 0) * (n.entrances || 0) * (n.flatsPerFloor || 0);
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
      <table>
        <thead><tr>
          <th>FOB</th><th>Від</th><th>Гілка</th><th>Відст., м</th>
          <th>Затух. волокна, дБ</th><th>Мех., дБ</th><th>Сигнал IN, дБ</th>
          <th>FBT</th><th>PLC</th><th>Гілка PLC</th><th>Сигнал ONU, дБ</th>
          <th>ONU</th><th>Статус</th>
        </tr></thead><tbody>`;

  rows.forEach((r) => {
    if (r.status === "NOT_CONNECTED") {
      html += `<tr><td class="td-name">${r.name}</td><td colspan="11" style="color:#f85149">⚠️ Не підключений</td></tr>`;
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
      <td>${r.from}</td><td>${r.branch}</td><td>${r.dist}</td>
      <td>${r.cableLoss}</td><td>${r.mechLoss}</td>
      <td><strong>${r.signalIn}</strong></td>
      <td>${r.fbt}</td><td>${r.plc}</td><td>${r.plcBranch}</td>
      <td class="${sClass}"><strong>${r.signalONU}</strong></td>
      <td>${r.onuCnt}</td>
      <td class="${sClass}"><strong>${sIcon}</strong></td>
    </tr>`;
  });
  html += `</tbody></table></div>`;

  const olts = nodes.filter((n) => n.type === "OLT");
  if (olts.length) {
    html += `<div class="report-section"><h3>Завантаження портів OLT</h3><table>
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
    html += `</tbody></table></div>`;
  }

  const econData = buildEconomicData();
  if (econData.length > 0) {
    html += `<div class="report-section"><h3>💰 Економічна частина (BOM)</h3>`;
    html += `<div class="info-pill" style="margin-bottom:12px">
      💡 Вкажіть ціни в Excel для формування кошторису. Обладнання згруповано за категоріями, типами та жилками.
    </div>`;

    html += `<table style="width:100%;margin-bottom:12px">
      <thead><tr><th>Категорія</th><th>Назва / Номенклатура</th><th>К-ть</th><th>Од.виміру</th><th>Ціна (₴)</th><th>Сума (₴)</th></tr></thead><tbody>`;

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

    html += `</tbody></table></div>`;
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

export function downloadCSV() {
  const rows = buildReportData();
  const hdr =
    "FOB;Від;Гілка;Відстань м;Затух. волокна дБ;Мех. дБ;Сигнал IN дБ;FBT;PLC;Гілка PLC;Сигнал ONU дБ;ONU;Статус\n";

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
        ? `${safeCell(r.name)};${safeCell("НЕ ПІДКЛЮЧЕНИЙ")};;;;;;;;;;;`
        : [
            safeCell(r.name),
            safeCell(r.from),
            safeCell(r.branch),
            safeCell(r.dist),
            safeCell(r.cableLoss),
            safeCell(r.mechLoss),
            safeCell(r.signalIn), 
            safeCell(r.fbt),
            safeCell(r.plc),
            safeCell(r.plcBranch),
            safeCell(r.signalONU), 
            safeCell(r.onuCnt),
            safeCell(
              {
                ok: "OK",
                warn: "Межа",
                err: "СЛАБКИЙ",
                info: "—",
              }[r.status],
            ),
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

  econData.forEach((row) => {
    const total = row.count * row.price;
    const countLabel = row.unit === "м" ? Math.ceil(row.count) : row.count;
    economicSection += `${safeCell(row.category)};${safeCell(row.name)};${safeCell(countLabel)};${safeCell(row.unit)};${safeCell(row.price > 0 ? row.price.toFixed(2) : "")};${safeCell(total > 0 ? total.toFixed(2) : "")}\n`;
  });

  economicSection += "\n💡 Вкажіть ціни в Excel для формування кошторису.\n";

  const blob = new Blob(["\uFEFF" + hdr + body + economicSection], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pon-report.csv";
  a.click();
}

export function downloadTXT() {
  const rows = buildReportData();

  const header = [
    "FOB",
    "Від",
    "Гілка",
    "Відстань м",
    "Затух. волокна дБ",
    "Мех. дБ",
    "Сигнал IN дБ",
    "FBT",
    "PLC",
    "Гілка PLC",
    "Сигнал ONU дБ",
    "ONU",
    "Статус",
  ];

  const table = [header];
  rows.forEach((r) => {
    if (r.status === "NOT_CONNECTED") {
      table.push([
        r.name,
        "НЕ ПІДКЛЮЧЕНИЙ",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
    } else {
      table.push([
        r.name,
        r.from,
        r.branch,
        r.dist,
        r.cableLoss,
        r.mechLoss,
        r.signalIn,
        r.fbt,
        r.plc,
        r.plcBranch,
        r.signalONU,
        String(r.onuCnt),
        {
          ok: "OK",
          warn: "Межа",
          err: "СЛАБКИЙ",
          info: "—",
        }[r.status],
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
  a.download = "pon-report.txt";
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
      const hasConn = conns.some((c) => c.to === onu && c.type === "patchcord");
      if (!hasConn)
        issues.push({
          icon: "❌",
          type: "err",
          msg: `${onu.name}: не підключений (немає патчкорду)`,
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

  let html = `<div class="report-section"><h3>🔍 Перевірка мережі</h3>`;
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

export function showTopology() {
  let html = `<div class="report-section"><h3>🌳 Топологія мережі (Натисніть на елемент для переходу)</h3>`;

  /**
   * @param {FOBNode} fob
   * @param {PONConnection} cable
   */
  function renderFobTree(fob, cable) {
    let h = "";
    const sig = hasOLTPath(fob) ? sigIn(fob) : null;
    const sigStr = sig !== null ? sig.toFixed(1) : "?";
    const cls =
      sig !== null
        ? sigClass(sig) === "ok"
          ? "sig-ok"
          : sigClass(sig) === "warn"
          ? "sig-warn"
          : "sig-err"
        : "";
    const dist = cable ? (connKm(cable) * 1000).toFixed(0) : "?";
    let splParts = [];
    const splitters = fob.splitters || [];
    splitters.forEach(sp => splParts.push(`${sp.type} ${sp.ratio}`));
    if (splParts.length === 0) {
      if (fob.fbtType) splParts.push(`FBT ${fob.fbtType}`);
      if (fob.plcType) splParts.push(`PLC ${fob.plcType}`);
    }
    const splitterInfo = splParts.length > 0 ? splParts.join(" + ") : "Транзит";

    h += `<div class="topo-branch">`;
    h += `<div class="topo-node topo-fob" style="cursor:pointer" onclick="focusNode('${fob.id}')" title="Показати на карті">📦 ${fob.name} <span class="topo-info">(${splitterInfo}, ${dist}м, <span class="${cls}">${sigStr} дБ</span>)</span></div>`;

    const downCables = conns.filter(
      (c) => c.from === fob && c.type === "cable",
    );
    downCables.forEach((dc) => {
      if (dc.to) h += renderFobTree(/** @type {FOBNode} */ (dc.to), dc);
    });

    const onus = conns
      .filter((c) => c.from === fob && c.type === "patchcord")
      .map((c) => c.to)
      .filter(Boolean);
    if (onus.length > 0) {
      h += `<div class="topo-onus">`;
      onus.forEach((onu) => {
        const onuSig = hasOLTPath(fob) ? sigONU(fob) : null;
        const onuSigStr = onuSig !== null ? onuSig.toFixed(1) : "?";
        const onuCls =
          onuSig !== null
            ? sigClass(onuSig) === "ok"
              ? "sig-ok"
              : sigClass(onuSig) === "warn"
              ? "sig-warn"
              : "sig-err"
            : "";
        h += `<div class="topo-node topo-onu" style="cursor:pointer" onclick="focusNode('${onu.id}')" title="Показати на карті">🏠 ${onu.name} <span class="${onuCls}">(${onuSigStr} дБ)</span></div>`;
      });
      h += `</div>`;
    }
    h += `</div>`;
    return h;
  }

  const olts = nodes.filter((n) => n.type === "OLT");
  if (olts.length === 0) {
    html += `<div style="text-align:center;color:#6e7681;padding:20px">Немає OLT у мережі</div>`;
  } else {
    olts.forEach((olt) => {
      html += `<div class="topo-tree">`;
      html += `<div class="topo-node topo-olt" style="cursor:pointer" onclick="focusNode('${olt.id}')" title="Показати на карті">🔷 ${olt.name} <span class="topo-info">(${olt.outputPower} дБ, ${olt.ports} порт${olt.ports > 1 ? "ів" : ""})</span></div>`;

      for (let p = 0; p < olt.ports; p++) {
        const portCables = conns.filter(
          (c) => c.from === olt && c.type === "cable" && c.fromPort === p,
        );
        if (portCables.length === 0) continue;
        html += `<div class="topo-branch">`;
        html += `<div class="topo-port">🔌 Порт ${p + 1}</div>`;
        portCables.forEach((cable) => {
          if (cable.to) html += renderFobTree(/** @type {FOBNode} */ (cable.to), cable);
        });
        html += `</div>`;
      }
      html += `</div>`;
    });
  }
  html += `</div>`;

  document.getElementById("modal-body").innerHTML = html;
  const h2 = document
    .getElementById("modal-overlay")
    .querySelector("h2");
  if (h2) h2.textContent = "🌳 Топологія";
  document.getElementById("modal-overlay")?.classList.add("open");
}

// Helper: calculate total loss for current FOB splitter setup
// For FBT+PLC combo: returns X branch + PLC loss + 2x MECH
// For PLC-only: returns PLC loss + MECH
// For FBT-only: returns X branch loss + MECH (tap branch)
/**
 * @param {FOBNode} fob
 * @returns {number}
 */
/**
 * @param {FOBNode} fob
 * @returns {number}
 */
function getTotalLoss(fob) {
  let loss = 0;
  const splitters = fob.splitters || [];
  
  splitters.forEach(sp => {
    if (sp.type === "FBT" && FBT_LOSSES[sp.ratio]) {
      // Use X branch (tap) as default for FBT
      loss += FBT_LOSSES[sp.ratio].x + MECH;
    } else if (sp.type === "PLC" && PLC_LOSSES[sp.ratio]) {
      loss += PLC_LOSSES[sp.ratio] + MECH;
    }
  });

  // Fallback for legacy splitters
  if (splitters.length === 0) {
    if (fob.plcType && fob.fbtType) {
      const brLoss = fob.plcBranch === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y;
      loss = brLoss + MECH + PLC_LOSSES[fob.plcType] + MECH;
    } else if (fob.plcType) {
      loss = PLC_LOSSES[fob.plcType] + MECH;
    } else if (fob.fbtType) {
      loss = FBT_LOSSES[fob.fbtType].x + MECH;
    }
  }

  return loss;
}

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

// Helper: find OLT port for a FOB by tracing back through connections
/**
 * @param {FOBNode} fob
 * @returns {{ olt: PONNode, port: number } | null}
 */
function getOLTPort(fob) {
  /** @type {PONNode} */
  let node = fob;
  const visited = new Set();

  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    const inCables = conns.filter(c => c.to === node && c.type === "cable");
    if (inCables.length === 0) break;

    const c = inCables[0];
    if (c.from.type === "OLT" && typeof c.fromPort === "number") {
      return { olt: c.from, port: c.fromPort };
    }
    node = c.from;
    if (node.type !== "FOB") break;
  }
  return null;
}

export function showScenarioCompare() {
  const current = [];
  nodes
    .filter(
      (n) => n.type === "FOB" && n.inputConn && (/** @type {FOBNode} */ (n).plcType || /** @type {FOBNode} */ (n).fbtType),
    )
    .forEach((/** @type {FOBNode} */ fob) => {
      const sig = hasOLTPath(fob) ? sigIn(fob) : null;
      const onuSig = hasOLTPath(fob) ? sigONU(fob) : null;
      const onus = conns.filter(
        (c) => c.from === fob && c.type === "patchcord",
      ).length;
      const oltInfo = getOLTPort(fob);
      current.push({
        fobId: fob.id,
        name: fob.name,
        splitter: fob.plcType
          ? `PLC ${fob.plcType}`
          : fob.fbtType
          ? `FBT ${fob.fbtType}`
          : "Транзит",
        sigIn: sig,
        sigONU: onuSig,
        onus,
        origLoss: getTotalLoss(fob),
        oltName: oltInfo?.olt?.name || "?",
        oltPort: oltInfo?.port !== undefined ? oltInfo.port + 1 : null, // 1-based for display
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
  function recalcRow(fobId, selectedSplitter) {
    const item = current.find((c) => c.fobId === fobId);
    if (!item) return null;

    const lossNew = getScenarioLoss(selectedSplitter, item.origLoss);
    const delta = lossNew - item.origLoss;
    const newSigIn = item.sigIn !== null ? item.sigIn - delta : null;
    const newSigONU = item.sigONU !== null ? item.sigONU - delta : null;
    const newSplitter = selectedSplitter === "keep" ? item.splitter : selectedSplitter;

    return {
      ...item,
      newSplitter,
      newSigIn,
      newSigONU,
      delta,
      lossNew,
    };
  }

  // Function to update table row (find by fobId to handle grouped rows)
  function updateRow(rowIndex, result) {
    // Try to find row by fobId first (more reliable with grouping)
    let row = document.querySelector(`tr[data-fob-id="${result.fobId}"]`);
    // Fallback to index if not found
    if (!row) {
      const allRows = document.querySelectorAll(`#scenario-table tbody tr:not(.scenario-group-header)`);
      row = allRows[rowIndex];
    }
    if (!row) return;

    const cIn = result.sigIn !== null
      ? sigClass(result.sigIn) === "ok" ? "sig-ok"
      : sigClass(result.sigIn) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const cOnu = result.sigONU !== null
      ? sigClass(result.sigONU) === "ok" ? "sig-ok"
      : sigClass(result.sigONU) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const nIn = result.newSigIn !== null
      ? sigClass(result.newSigIn) === "ok" ? "sig-ok"
      : sigClass(result.newSigIn) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const nOnu = result.newSigONU !== null
      ? sigClass(result.newSigONU) === "ok" ? "sig-ok"
      : sigClass(result.newSigONU) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const dStr = result.delta > 0 ? `+${result.delta.toFixed(1)}` : result.delta.toFixed(1);
    const dCls = result.delta > 0 ? "sig-err" : result.delta < 0 ? "sig-ok" : "";

    // Update cells (structure: 0=FOB, 1=Зараз, 2=Сигнал FOB, 3=Сигнал ONU, 4=select, 5=Новий FOB, 6=Новий ONU, 7=Зміна)
    const cells = row.querySelectorAll("td");
    if (cells.length >= 8) {
      cells[2].className = cIn;
      cells[2].textContent = result.sigIn !== null ? result.sigIn.toFixed(1) : "—";
      cells[3].className = cOnu;
      cells[3].textContent = result.sigONU !== null ? result.sigONU.toFixed(1) : "—";
      cells[5].className = nIn;
      cells[5].textContent = result.newSigIn !== null ? result.newSigIn.toFixed(1) : "—";
      cells[6].className = nOnu;
      cells[6].textContent = result.newSigONU !== null ? result.newSigONU.toFixed(1) : "—";
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

  let html = `<div class="report-section">
    <h3>📊 Порівняння сценаріїв</h3>
    <p style="margin-bottom:12px;color:#8b949e;font-size:12px">Оберіть сплітер для кожного FOB, щоб побачити вплив на сигнал. Зміни застосовуються автоматично.</p>
    <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;justify-content:flex-end">
      <button id="scenario-reset-btn" class="modal-btn">
        ↺ Скинути всі
      </button>
    </div>
    <table id="scenario-table"><thead><tr>
      <th>FOB</th><th>Зараз</th><th>Сигнал FOB</th><th>Сигнал ONU</th>
      <th>Сценарний сплітер</th><th>Новий FOB</th><th>Новий ONU</th><th>Зміна</th>
    </tr></thead><tbody>`;

  let globalRowIdx = 0;
  sortedGroups.forEach((groupKey) => {
    const groupItems = grouped[groupKey];
    
    // Add group header row
    html += `<tr class="scenario-group-header" style="background:rgba(88,166,255,0.1);border-top:2px solid #58a6ff;">
      <td colspan="8" style="padding:8px 12px;font-weight:600;color:#58a6ff;font-size:12px;">
        🔌 ${groupKey} (${groupItems.length} FOB${groupItems.length !== 1 ? "ів" : ""})
      </td>
    </tr>`;

    groupItems.forEach((item) => {
    const defaultSplitter = "keep"; // Default: keep current splitter
    const result = recalcRow(item.fobId, defaultSplitter);

    const cIn = item.sigIn !== null
      ? sigClass(item.sigIn) === "ok" ? "sig-ok"
      : sigClass(item.sigIn) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const cOnu = item.sigONU !== null
      ? sigClass(item.sigONU) === "ok" ? "sig-ok"
      : sigClass(item.sigONU) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const nIn = result.newSigIn !== null
      ? sigClass(result.newSigIn) === "ok" ? "sig-ok"
      : sigClass(result.newSigIn) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const nOnu = result.newSigONU !== null
      ? sigClass(result.newSigONU) === "ok" ? "sig-ok"
      : sigClass(result.newSigONU) === "warn" ? "sig-warn"
      : "sig-err"
      : "";
    const dStr = result.delta > 0 ? `+${result.delta.toFixed(1)}` : result.delta.toFixed(1);
    const dCls = result.delta > 0 ? "sig-err" : result.delta < 0 ? "sig-ok" : "";

      const optionsHtml = splitterOptions.map(opt => 
        `<option value="${opt.value}" ${opt.value === defaultSplitter ? "selected" : ""}>${opt.label}</option>`
      ).join("");

      html += `<tr data-fob-id="${item.fobId}">
        <td class="td-name">${item.name}</td>
        <td>${item.splitter}</td>
        <td class="${cIn}">${item.sigIn !== null ? item.sigIn.toFixed(1) : "—"}</td>
        <td class="${cOnu}">${item.sigONU !== null ? item.sigONU.toFixed(1) : "—"}</td>
        <td><select class="scenario-splitter-select" data-row="${item._originalIdx}" data-fob-id="${item.fobId}" style="min-width:120px;padding:4px 6px;font-size:11px">
          ${optionsHtml}
        </select></td>
        <td class="${nIn}">${result.newSigIn !== null ? result.newSigIn.toFixed(1) : "—"}</td>
        <td class="${nOnu}">${result.newSigONU !== null ? result.newSigONU.toFixed(1) : "—"}</td>
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
      const select = document.querySelector(`.scenario-splitter-select[data-fob-id="${item.fobId}"]`);
      if (select) {
        /** @type {HTMLSelectElement} */ (select).value = "keep";
        const result = recalcRow(item.fobId, "keep");
        if (result) {
          // Find row index in DOM (excluding group headers)
          const row = document.querySelector(`tr[data-fob-id="${item.fobId}"]`);
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
      const selected = tgt.value;
      const result = recalcRow(fobId, selected);
      if (result) {
        // Find the actual row in DOM by fobId
        const row = document.querySelector(`tr[data-fob-id="${fobId}"]`);
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
  const resetBtn = document.getElementById("scenario-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetAllSelections();
    });
  }

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
  count += nodes.filter((n) => n.type === "FOB" && !n.inputConn).length;
  // Disconnected ONUs
  count += nodes
    .filter((n) => n.type === "ONU")
    .filter((onu) => !conns.some((c) => c.to === onu && c.type === "patchcord")).length;
  // Weak signals
  nodes
    .filter((n) => n.type === "FOB" && n.inputConn && (/** @type {FOBNode} */ (n).plcType || /** @type {FOBNode} */ (n).fbtType))
    .forEach((/** @type {FOBNode} */ fob) => {
      const sig = sigONU(fob);
      if (sig < ONU_MIN) count++;
    });
  // Port overloads
  nodes
    .filter((n) => n.type === "OLT")
    .forEach((olt) => {
      for (let i = 0; i < olt.ports; i++) {
        if (cntONUport(olt, i) > (olt.maxOnuPerPort || 64)) count++;
      }
    });
  // Long cables
  count += conns.filter((c) => c.type === "cable" && connKm(c) > 5).length;

  const badge = document.getElementById("badge-validation");
  if (badge) {
    badge.textContent = count > 0 ? String(count) : "";
    badge.className = count > 0 ? "badge badge-red" : "badge badge-green";
  }
}
