const STUDENT_NAV = [
  { href: "dashboard.html", label: "Home" },
  { href: "scan.html", label: "Scan QR" },
  { href: "history.html", label: "History" },
  { href: "exam.html", label: "Exam Marks" },
];

function requireStudentAuth() {
  const token = Api.getToken("student");
  if (!token) {
    window.location.href = "index.html";
    throw new Error("redirecting");
  }
  return token;
}

function renderStudentShell(activeHref, innerHtml) {
  const currentPage = location.pathname.split("/").pop();
  const navHtml = STUDENT_NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === (activeHref || currentPage) ? "active" : ""}">${item.label}</a>`
  ).join("");

  document.body.innerHTML = `
    <div class="mobile-nav">${navHtml}<a href="#" id="logoutLink" style="margin-left:auto;">Log out</a></div>
    <div class="container-narrow" id="pageContent">${innerHtml}</div>
  `;
  document.getElementById("logoutLink").addEventListener("click", (e) => {
    e.preventDefault();
    Api.clearToken("student");
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
