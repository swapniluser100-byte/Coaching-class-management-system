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
