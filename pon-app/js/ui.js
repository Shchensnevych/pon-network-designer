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

function buildReportData() {
  const rows = [];
  nodes
    .filter((n) => n.type === "FOB")
    .forEach((/** @type {FOBNode} */ fob) => {
      if (!fob.inputConn) {
        rows.push({ name: fob.name, status: "NOT_CONNECTED" });
        return;
      }
      const c = fob.inputConn;
      const dm = connKm(c) * 1000;
      const cLoss = (dm / 1000) * FIBER_DB_KM;
      const si = sigIn(fob);
      const so = fob.plcType || fob.fbtType ? sigONU(fob) : null;

      rows.push({
        name: fob.name,
        from: c.from.name || c.from.type,
        branch: c.branch || "—",
        dist: dm.toFixed(1),
        cableLoss: cLoss.toFixed(3),
        mechLoss: MECH,
        signalIn: si.toFixed(2),
        fbt: fob.fbtType || "—",
        xLoss: fob.fbtType ? FBT_LOSSES[fob.fbtType].x.toFixed(2) : "—",
        yLoss: fob.fbtType ? FBT_LOSSES[fob.fbtType].y.toFixed(2) : "—",
        plc: fob.plcType || "—",
        plcBranch: fob.plcBranch || "—",
        plcLoss: fob.plcType ? PLC_LOSSES[fob.plcType].toFixed(2) : "—",
        signalONU: so !== null ? so.toFixed(2) : "—",
        onuCnt: conns.filter((x) => x.from === fob && x.type === "patchcord").length,
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
  const onuCount = nodes.filter((n) => n.type === "ONU").length;
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

  // Economic part: grouped equipment prices (for cost estimates)
  // Helper: extract base name for grouping (e.g., "FOB-03-16" → "FOB-03-16", "FOB-1" → individual)
  function getBaseName(name, type) {
    // If name matches pattern like "TYPE-XX-YY" (with multiple segments), group by base
    const match = name.match(/^([A-Z]+-\d+-\d+)/);
    if (match) return match[1]; // Group by base pattern
    // Otherwise, treat each as individual
    return name;
  }

  // Group equipment by base name
  const groupedOlt = {};
  nodes.filter((n) => n.type === "OLT").forEach((n) => {
    const base = getBaseName(n.name, "OLT");
    if (!groupedOlt[base]) groupedOlt[base] = { name: base, count: 0, price: 0 };
    groupedOlt[base].count++;
    const price = typeof n.price === "number" ? n.price : 0;
    if (price > 0 && groupedOlt[base].price === 0) groupedOlt[base].price = price;
  });

  const groupedFob = {};
  nodes.filter((n) => n.type === "FOB").forEach((n) => {
    const base = getBaseName(n.name, "FOB");
    if (!groupedFob[base]) groupedFob[base] = { name: base, count: 0, price: 0 };
    groupedFob[base].count++;
    const price = typeof n.price === "number" ? n.price : 0;
    if (price > 0 && groupedFob[base].price === 0) groupedFob[base].price = price;
  });

  const groupedOnu = {};
  nodes.filter((n) => n.type === "ONU").forEach((n) => {
    const base = getBaseName(n.name, "ONU");
    if (!groupedOnu[base]) groupedOnu[base] = { name: base, count: 0, price: 0 };
    groupedOnu[base].count++;
    const price = typeof n.price === "number" ? n.price : 0;
    if (price > 0 && groupedOnu[base].price === 0) groupedOnu[base].price = price;
  });

  // Count splitters by type
  const fbtCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).fbtType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `FBT ${fob.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).plcType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `PLC ${fob.plcType}`;
    plcCounts[key] = (plcCounts[key] || 0) + 1;
  });

  const hasEquipment = Object.keys(groupedOlt).length > 0 || Object.keys(groupedFob).length > 0 || 
                       Object.keys(groupedOnu).length > 0 || Object.keys(fbtCounts).length > 0 || 
                       Object.keys(plcCounts).length > 0;

  if (hasEquipment) {
    html += `<div class="report-section"><h3>💰 Економічна частина (для кошторису)</h3>`;
    html += `<div class="info-pill" style="margin-bottom:12px">
      💡 Вкажіть ціни в Excel для формування кошторису. Обладнання згруповано за типом/назвою.
    </div>`;

    html += `<table style="width:100%;margin-bottom:12px">
      <thead><tr><th>Обладнання</th><th>Кількість</th><th>Ціна за од. (₴)</th><th>Сума (₴)</th></tr></thead><tbody>`;

    // OLT
    Object.values(groupedOlt).forEach((g) => {
      const total = g.count * g.price;
      html += `<tr>
        <td class="td-name">${g.name}</td>
        <td>${g.count} шт.</td>
        <td>${g.price > 0 ? g.price.toFixed(2) : ""}</td>
        <td>${total > 0 ? total.toFixed(2) : ""}</td>
      </tr>`;
    });

    // FOB
    Object.values(groupedFob).forEach((g) => {
      const total = g.count * g.price;
      html += `<tr>
        <td class="td-name">${g.name}</td>
        <td>${g.count} шт.</td>
        <td>${g.price > 0 ? g.price.toFixed(2) : ""}</td>
        <td>${total > 0 ? total.toFixed(2) : ""}</td>
      </tr>`;
    });

    // ONU
    Object.values(groupedOnu).forEach((g) => {
      const total = g.count * g.price;
      html += `<tr>
        <td class="td-name">${g.name}</td>
        <td>${g.count} шт.</td>
        <td>${g.price > 0 ? g.price.toFixed(2) : ""}</td>
        <td>${total > 0 ? total.toFixed(2) : ""}</td>
      </tr>`;
    });

    // FBT Splitters
    Object.entries(fbtCounts).forEach(([type, count]) => {
      html += `<tr>
        <td class="td-name">${type}</td>
        <td>${count} шт.</td>
        <td></td>
        <td></td>
      </tr>`;
    });

    // PLC Splitters
    Object.entries(plcCounts).forEach(([type, count]) => {
      html += `<tr>
        <td class="td-name">${type}</td>
        <td>${count} шт.</td>
        <td></td>
        <td></td>
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

  function safeCell(v, forceText = false) {
    const s = String(v ?? "");
    // Force text format for specific columns (e.g., Signal IN dB) to prevent Excel date conversion
    if (forceText) {
      // Use formula format for numeric values to prevent date conversion
      return excelForceTextCell(s);
    }
    // Typical problematic patterns for Excel auto-date: 10/90, 1/2, 12-11, etc.
    if (/^\d{1,2}[\/-]\d{1,4}$/.test(s)) return excelForceTextCell(s);
    // Also check for numeric values that might be interpreted as dates (e.g., 1.40, 1.4)
    if (/^\d+\.\d+$/.test(s) && parseFloat(s) < 32) {
      // Small decimal numbers might be dates (day.month or similar)
      return excelForceTextCell(s);
    }
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
            safeCell(r.signalIn, true), // Force text to prevent Excel date conversion
            safeCell(r.fbt),
            safeCell(r.plc),
            safeCell(r.plcBranch),
            safeCell(r.signalONU, true), // Force text for signal values
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

  // Add economic part: grouped equipment (for cost estimates)
  function getBaseName(name, type) {
    const match = name.match(/^([A-Z]+-\d+-\d+)/);
    if (match) return match[1];
    return name;
  }

  const groupedOlt = {};
  nodes.filter((n) => n.type === "OLT").forEach((n) => {
    const base = getBaseName(n.name, "OLT");
    if (!groupedOlt[base]) groupedOlt[base] = { name: base, count: 0 };
    groupedOlt[base].count++;
  });

  const groupedFob = {};
  nodes.filter((n) => n.type === "FOB").forEach((n) => {
    const base = getBaseName(n.name, "FOB");
    if (!groupedFob[base]) groupedFob[base] = { name: base, count: 0 };
    groupedFob[base].count++;
  });

  const groupedOnu = {};
  nodes.filter((n) => n.type === "ONU").forEach((n) => {
    const base = getBaseName(n.name, "ONU");
    if (!groupedOnu[base]) groupedOnu[base] = { name: base, count: 0 };
    groupedOnu[base].count++;
  });

  const fbtCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).fbtType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `FBT ${fob.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).plcType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `PLC ${fob.plcType}`;
    plcCounts[key] = (plcCounts[key] || 0) + 1;
  });

  let economicSection = "\n\n💰 Економічна частина (для кошторису)\n";
  economicSection += "Обладнання;Кількість;Ціна за од. (₴);Сума (₴)\n";

  Object.values(groupedOlt).forEach((g) => {
    economicSection += `${safeCell(g.name)};${safeCell(g.count + " шт.")};;\n`;
  });
  Object.values(groupedFob).forEach((g) => {
    economicSection += `${safeCell(g.name)};${safeCell(g.count + " шт.")};;\n`;
  });
  Object.values(groupedOnu).forEach((g) => {
    economicSection += `${safeCell(g.name)};${safeCell(g.count + " шт.")};;\n`;
  });
  Object.entries(fbtCounts).forEach(([type, count]) => {
    economicSection += `${safeCell(type)};${safeCell(count + " шт.")};;\n`;
  });
  Object.entries(plcCounts).forEach(([type, count]) => {
    economicSection += `${safeCell(type)};${safeCell(count + " шт.")};;\n`;
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

  // Add economic part: grouped equipment (for cost estimates)
  function getBaseName(name, type) {
    const match = name.match(/^([A-Z]+-\d+-\d+)/);
    if (match) return match[1];
    return name;
  }

  const groupedOlt = {};
  nodes.filter((n) => n.type === "OLT").forEach((n) => {
    const base = getBaseName(n.name, "OLT");
    if (!groupedOlt[base]) groupedOlt[base] = { name: base, count: 0 };
    groupedOlt[base].count++;
  });

  const groupedFob = {};
  nodes.filter((n) => n.type === "FOB").forEach((n) => {
    const base = getBaseName(n.name, "FOB");
    if (!groupedFob[base]) groupedFob[base] = { name: base, count: 0 };
    groupedFob[base].count++;
  });

  const groupedOnu = {};
  nodes.filter((n) => n.type === "ONU").forEach((n) => {
    const base = getBaseName(n.name, "ONU");
    if (!groupedOnu[base]) groupedOnu[base] = { name: base, count: 0 };
    groupedOnu[base].count++;
  });

  const fbtCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).fbtType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `FBT ${fob.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && /** @type {FOBNode} */ (n).plcType).forEach((n) => {
    const fob = /** @type {FOBNode} */ (n);
    const key = `PLC ${fob.plcType}`;
    plcCounts[key] = (plcCounts[key] || 0) + 1;
  });

  const econHeader = ["Обладнання", "Кількість", "Ціна за од. (₴)", "Сума (₴)"];
  const econTable = [econHeader];

  Object.values(groupedOlt).forEach((g) => {
    econTable.push([g.name, `${g.count} шт.`, "", ""]);
  });
  Object.values(groupedFob).forEach((g) => {
    econTable.push([g.name, `${g.count} шт.`, "", ""]);
  });
  Object.values(groupedOnu).forEach((g) => {
    econTable.push([g.name, `${g.count} шт.`, "", ""]);
  });
  Object.entries(fbtCounts).forEach(([type, count]) => {
    econTable.push([type, `${count} шт.`, "", ""]);
  });
  Object.entries(plcCounts).forEach(([type, count]) => {
    econTable.push([type, `${count} шт.`, "", ""]);
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
    .filter((n) => n.type === "FOB" && !n.inputConn)
    .forEach((fob) => {
      issues.push({
        icon: "❌",
        type: "err",
        msg: `${fob.name}: не підключений (немає вхідного кабелю)`,
      });
    });

  nodes
    .filter((n) => n.type === "ONU")
    .forEach((onu) => {
      const hasConn = conns.some((c) => c.to === onu && c.type === "patchcord");
      if (!hasConn)
        issues.push({
          icon: "❌",
          type: "err",
          msg: `${onu.name}: не підключений (немає патчкорду)`,
        });
    });

  nodes
    .filter((n) => n.type === "FOB" && n.inputConn && (/** @type {FOBNode} */ (n).plcType || /** @type {FOBNode} */ (n).fbtType))
    .forEach((/** @type {FOBNode} */ fob) => {
      const sig = sigONU(fob);
      if (sig < ONU_MIN - 3)
        issues.push({
          icon: "❌",
          type: "err",
          msg: `${fob.name}: критично слабкий сигнал ONU (${sig.toFixed(1)} дБ)`,
        });
      else if (sig < ONU_MIN)
        issues.push({
          icon: "⚠️",
          type: "warn",
          msg: `${fob.name}: сигнал на межі порогу (${sig.toFixed(1)} дБ)`,
        });
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
          msg: `Довгий кабель: ${c.from.name}→${c.to.name} (${(km * 1000).toFixed(
            0,
          )} м)`,
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
          });
          break;
        }
        visited.add(cur.id);
        if (!cur.inputConn || cur.inputConn.from.type !== "FOB") break;
        cur = cur.inputConn.from;
      }
    });

  let html = `<div class="report-section"><h3>🔍 Перевірка мережі</h3>`;
  if (issues.length === 0) {
    html += `<div style="padding:20px;text-align:center;color:#3fb950">✅ Серйозних проблем не виявлено</div>`;
  } else {
    html += `<ul style="list-style:none;padding:0;margin:0">`;
    issues.forEach((i) => {
      const cls = i.type === "err" ? "td-err" : i.type === "warn" ? "td-warn" : "";
      html += `<li class="${cls}" style="margin-bottom:4px">${i.icon} ${i.msg}</li>`;
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
    if (fob.fbtType) splParts.push(`FBT ${fob.fbtType}`);
    if (fob.plcType) splParts.push(`PLC ${fob.plcType}`);
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
function getTotalLoss(fob) {
  if (fob.plcType && fob.fbtType) {
    // Combo: FBT X branch + PLC + mechanical losses
    const brLoss = fob.plcBranch === "X" ? FBT_LOSSES[fob.fbtType].x : FBT_LOSSES[fob.fbtType].y;
    return brLoss + MECH + PLC_LOSSES[fob.plcType] + MECH;
  }
  if (fob.plcType) {
    return PLC_LOSSES[fob.plcType] + MECH;
  }
  if (fob.fbtType) {
    // FBT only: use X branch (tap) as default
    return FBT_LOSSES[fob.fbtType].x + MECH;
  }
  return 0;
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
  while (node && node.inputConn) {
    const c = node.inputConn;
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
