// Shared sidebar + auth guard for every admin page except the login screen.

const ADMIN_NAV = [
  { href: "dashboard.html", label: "Dashboard" },
  { href: "students.html", label: "Manage Students" },
  { href: "batches.html", label: "Manage Batches" },
  { href: "tutors.html", label: "Manage Tutors" },
  { href: "attendance.html", label: "Attendance Reports" },
  { href: "exams.html", label: "Exam Management" },
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
        <div class="brand">📚 Tuition Admin</div>
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
