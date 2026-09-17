// Minimal fetch wrapper shared by the admin, teacher and student portals.
// Each portal stores its own JWT under a distinct localStorage key so a
// person can, in theory, be logged into more than one role in one browser.

const Api = (() => {
  function tokenKeyFor(role) {
    return `tms_${role}_token`;
  }

  function getToken(role) {
    return localStorage.getItem(tokenKeyFor(role));
  }

  function setToken(role, token) {
    localStorage.setItem(tokenKeyFor(role), token);
  }

  function clearToken(role) {
    localStorage.removeItem(tokenKeyFor(role));
  }

  async function request(role, path, { method = "GET", body, isForm = false, raw = false } = {}) {
    const headers = {};
    const token = role ? getToken(role) : null;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body && !isForm) headers["Content-Type"] = "application/json";
    if (isForm && body?.type) headers["Content-Type"] = body.type; // Blob/File content-type for raw uploads

    const res = await fetch(`${window.API_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });

    if (raw) return res;

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Unexpected response (${res.status})`);
    }
    if (!res.ok || json.success === false) {
      throw new Error(json.error || `Request failed (${res.status})`);
    }
    return json.data;
  }

  return { request, getToken, setToken, clearToken };
})();
