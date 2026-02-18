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
    .forEach((fob) => {
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
  nodes.filter((n) => n.type === "FOB" && n.fbtType).forEach((n) => {
    const key = `FBT ${n.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && n.plcType).forEach((n) => {
    const key = `PLC ${n.plcType}`;
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
  nodes.filter((n) => n.type === "FOB" && n.fbtType).forEach((n) => {
    const key = `FBT ${n.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && n.plcType).forEach((n) => {
    const key = `PLC ${n.plcType}`;
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
  nodes.filter((n) => n.type === "FOB" && n.fbtType).forEach((n) => {
    const key = `FBT ${n.fbtType}`;
    fbtCounts[key] = (fbtCounts[key] || 0) + 1;
  });

  const plcCounts = {};
  nodes.filter((n) => n.type === "FOB" && n.plcType).forEach((n) => {
    const key = `PLC ${n.plcType}`;
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
    .filter((n) => n.type === "FOB" && n.inputConn && (n.plcType || n.fbtType))
    .forEach((fob) => {
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
  document.getElementById("modal-overlay").classList.add("open");
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

  // Visual focus feedback
  setTimeout(() => {
    mapNode.marker.openPopup();
    if (mapNode.marker._icon) {
      const icon = mapNode.marker._icon;
      icon.style.transition = "transform 0.5s, box-shadow 0.5s";
      icon.style.transform = "scale(1.5)";
      icon.style.boxShadow = "0 0 20px #58a6ff";
      setTimeout(() => {
        icon.style.transform = "";
        icon.style.boxShadow = "";
      }, 1000);
    }
  }, 50);
}

export function showTopology() {
  let html = `<div class="report-section"><h3>🌳 Топологія мережі (Натисніть на елемент для переходу)</h3>`;

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
      if (dc.to) h += renderFobTree(dc.to, dc);
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
          if (cable.to) html += renderFobTree(cable.to, cable);
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
  document.getElementById("modal-overlay").classList.add("open");
}

export function showScenarioCompare() {
  const current = [];
  nodes
    .filter(
      (n) => n.type === "FOB" && n.inputConn && (n.plcType || n.fbtType),
    )
    .forEach((fob) => {
      const sig = hasOLTPath(fob) ? sigIn(fob) : null;
      const onuSig = hasOLTPath(fob) ? sigONU(fob) : null;
      const onus = conns.filter(
        (c) => c.from === fob && c.type === "patchcord",
      ).length;
      current.push({
        name: fob.name,
        splitter: fob.plcType
          ? `PLC ${fob.plcType}`
          : fob.fbtType
          ? `FBT ${fob.fbtType}`
          : "Транзит",
        sigIn: sig,
        sigONU: onuSig,
        onus,
      });
    });

  const scenario = current.map((f) => {
    const origSplit = f.splitter;
    let lossOrig = 0;
    let lossNew = 0;
    if (origSplit.includes("PLC 1x2")) lossOrig = 3.6;
    else if (origSplit.includes("PLC 1x4")) lossOrig = 7.0;
    else if (origSplit.includes("PLC 1x8")) lossOrig = 10.2;
    else if (origSplit.includes("PLC 1x16")) lossOrig = 13.5;
    else if (origSplit.includes("PLC 1x32")) lossOrig = 17.0;
    else if (origSplit.includes("PLC 1x64")) lossOrig = 21.0;
    else if (origSplit.includes("FBT 50/50")) lossOrig = 3.5;
    else if (origSplit.includes("FBT 40/60")) lossOrig = 2.2;
    else if (origSplit.includes("FBT 30/70")) lossOrig = 1.5;
    else if (origSplit.includes("FBT 20/80")) lossOrig = 1.0;
    else if (origSplit.includes("FBT 10/90")) lossOrig = 0.5;
    lossNew = 10.2; // PLC 1x8

    const delta = lossNew - lossOrig;
    const newSigIn = f.sigIn !== null ? f.sigIn - delta : null;
    const newSigONU = f.sigONU !== null ? f.sigONU - delta : null;
    return {
      ...f,
      newSplitter: "PLC 1x8",
      newSigIn,
      newSigONU,
      delta,
    };
  });

  let html = `<div class="report-section"><h3>📊 Сценарій: усі сплітери → PLC 1×8</h3>
    <table><thead><tr><th>FOB</th><th>Зараз</th><th>Сигнал FOB</th><th>Сигнал ONU</th><th>→ PLC 1×8</th><th>Новий FOB</th><th>Новий ONU</th><th>Зміна</th></tr></thead><tbody>`;

  scenario.forEach((s) => {
    const cIn =
      s.sigIn !== null
        ? sigClass(s.sigIn) === "ok"
          ? "sig-ok"
          : sigClass(s.sigIn) === "warn"
          ? "sig-warn"
          : "sig-err"
        : "";
    const cOnu =
      s.sigONU !== null
        ? sigClass(s.sigONU) === "ok"
          ? "sig-ok"
          : sigClass(s.sigONU) === "warn"
          ? "sig-warn"
          : "sig-err"
        : "";
    const nIn =
      s.newSigIn !== null
        ? sigClass(s.newSigIn) === "ok"
          ? "sig-ok"
          : sigClass(s.newSigIn) === "warn"
          ? "sig-warn"
          : "sig-err"
        : "";
    const nOnu =
      s.newSigONU !== null
        ? sigClass(s.newSigONU) === "ok"
          ? "sig-ok"
          : sigClass(s.newSigONU) === "warn"
          ? "sig-warn"
          : "sig-err"
        : "";
    const dStr = s.delta > 0 ? `+${s.delta.toFixed(1)}` : s.delta.toFixed(1);
    const dCls = s.delta > 0 ? "sig-err" : s.delta < 0 ? "sig-ok" : "";

    html += `<tr>
      <td class="td-name">${s.name}</td>
      <td>${s.splitter}</td>
      <td class="${cIn}">${s.sigIn !== null ? s.sigIn.toFixed(1) : "—"}</td>
      <td class="${cOnu}">${s.sigONU !== null ? s.sigONU.toFixed(1) : "—"}</td>
      <td>${s.newSplitter}</td>
      <td class="${nIn}">${s.newSigIn !== null ? s.newSigIn.toFixed(1) : "—"}</td>
      <td class="${nOnu}">${s.newSigONU !== null ? s.newSigONU.toFixed(1) : "—"}</td>
      <td class="${dCls}">${dStr} дБ</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;

  if (scenario.length === 0) {
    html = `<div style="text-align:center;color:#6e7681;padding:30px">Немає FOB зі сплітерами для порівняння</div>`;
  }

  document.getElementById("modal-body").innerHTML = html;
  const h2 = document
    .getElementById("modal-overlay")
    .querySelector("h2");
  if (h2) h2.textContent = "🔄 Порівняння сценаріїв";
  document.getElementById("modal-overlay").classList.add("open");
}

export function openHelp() {
  document.getElementById("help-overlay").classList.add("open");
}

export function closeHelp() {
  document.getElementById("help-overlay").classList.remove("open");
}

