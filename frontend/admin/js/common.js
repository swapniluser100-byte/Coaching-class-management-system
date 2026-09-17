// Shared sidebar + auth guard for every admin page except the login screen.

const ADMIN_NAV = [
  { href: "dashboard.html", label: "Dashboard" },
  { href: "students.html", label: "Manage Students" },
  { href: "batches.html", label: "Manage Batches" },
  { href: "tutors.html", label: "Manage Tutors" },
  { href: "attendance.html", label: "Attendance Reports" },
  { href: "exams.html", label: "Exam Management" },
  { href: "question-banks.html", label: "Question Banks" },
  { href: "marks.html", label: "Marks Upload" },
  { href: "settings.html", label: "Settings" },
];

function requireAdminAuth() {
  const token = Api.getToken("admin");
  if (!token) {
    window.location.href = "index.html";
    throw new Error("redirecting");
  }
  return token;
}

function renderAdminShell(activeHref, innerHtml) {
  const currentPage = location.pathname.split("/").pop();
  const navHtml = ADMIN_NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === (activeHref || currentPage) ? "active" : ""}">${item.label}</a>`
  ).join("");

  const mobileNavHtml = ADMIN_NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === (activeHref || currentPage) ? "active" : ""}">${item.label}</a>`
  ).join("");

  document.body.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span data-brand-icon>📚</span><img data-brand-logo class="hidden" alt="Logo" style="height:20px; vertical-align:-4px; margin-right:4px;" /> <span data-brand-name="Admin">Tuition Admin</span></div>
        <nav>${navHtml}</nav>
        <div style="margin-top:24px; padding: 0 12px;">
          <button class="btn btn-secondary btn-block" id="logoutBtn">Log out</button>
        </div>
      </aside>
      <div class="main">
        <div class="admin-mobile-nav mobile-nav">${mobileNavHtml}<a href="#" id="logoutLinkMobile" style="margin-left:auto;">Log out</a></div>
        <div class="topbar">
          <div id="pageTitle" style="font-weight:700;"></div>
          <div class="text-muted" style="font-size:13px;">Pune Tuition Classes</div>
        </div>
        <div class="container">${innerHtml}</div>
      </div>
    </div>
  `;
  document.getElementById("logoutLinkMobile").addEventListener("click", (e) => {
    e.preventDefault();
    Api.clearToken("admin");
    window.location.href = "index.html";
  });
  document.getElementById("logoutBtn").addEventListener("click", () => {
    Api.clearToken("admin");
    window.location.href = "index.html";
  });
  Branding.load().then((d) => { Branding.applyName(d.tuition_name); Branding.applyLogo(d.logo_url); });
}

function setPageTitle(title) {
  const el = document.getElementById("pageTitle");
  if (el) el.textContent = title;
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
// Icon buttons for table row actions (Edit / Delete / etc.) — used instead of
// labeled buttons to keep dense tables compact. Icons are inline SVG (Feather
// icon paths) so there's no external icon-font dependency.
// ---------------------------------------------------------------------------
const ICON_PATHS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  power: '<path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>',
  reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};

function iconSvg(name) {
  // Explicit width/height so the icon renders at a sane size even when used
  // outside a .btn/.icon-btn context that would otherwise size it via CSS.
  return `<svg viewBox="0 0 24 24" width="16" height="16" style="vertical-align:-3px" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}

// opts: { icon, title, onclick, href, variant: 'secondary'|'danger'|'success'|'warning' }
function iconButton(opts) {
  const variant = opts.variant || "secondary";
  const attrs = `class="icon-btn icon-btn-${variant}" title="${escapeHtml(opts.title)}" aria-label="${escapeHtml(opts.title)}"`;
  if (opts.href) {
    return `<a ${attrs} href="${opts.href}">${iconSvg(opts.icon)}</a>`;
  }
  return `<button type="button" ${attrs} onclick="${opts.onclick}">${iconSvg(opts.icon)}</button>`;
}

// ---------------------------------------------------------------------------
// Minimal CSV parse/stringify (handles quoted fields with embedded commas,
// quotes and newlines) — used by the CSV marks import/export on marks.html.
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
