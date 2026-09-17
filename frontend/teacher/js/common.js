const TEACHER_NAV = [
  { href: "dashboard.html", label: "My Batches" },
  { href: "attendance.html", label: "Attendance / QR" },
  { href: "analytics.html", label: "Analytics" },
  { href: "exams.html", label: "Exams & Marks" },
];

function requireTeacherAuth() {
  const token = Api.getToken("tutor");
  if (!token) {
    window.location.href = "index.html";
    throw new Error("redirecting");
  }
  return token;
}

function renderTeacherShell(activeHref, innerHtml) {
  const currentPage = location.pathname.split("/").pop();
  const navHtml = TEACHER_NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === (activeHref || currentPage) ? "active" : ""}">${item.label}</a>`
  ).join("");

  document.body.innerHTML = `
    <div class="mobile-nav">${navHtml}<a href="#" id="logoutLink" style="margin-left:auto;">${iconSvg("log-out")} Log out</a></div>
    <div class="container" id="pageContent">${innerHtml}</div>
  `;
  document.getElementById("logoutLink").addEventListener("click", (e) => {
    e.preventDefault();
    Api.clearToken("tutor");
    window.location.href = "index.html";
  });
}

function showAlert(containerEl, message, type = "danger") {
  containerEl.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// ---------------------------------------------------------------------------
// Minimal CSV parse/stringify (handles quoted fields with embedded commas,
// quotes and newlines) — used by the CSV marks import/export on exams.html.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsvField(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((r) => r.map(toCsvField).join(",")).join("\r\n");
}

function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
