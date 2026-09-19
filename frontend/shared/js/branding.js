// Loads the admin-configured tuition name, brand color and logo, and applies
// them app-wide: the brand color overrides the --color-primary CSS variable
// (used everywhere buttons, links and active nav states already draw their
// color from), the tuition name is written into any element marked
// [data-brand-name] (a data-brand-name attribute value, if set, is appended
// as a suffix, e.g. data-brand-name="Admin" -> "Sharma's Classes Admin"),
// and a configured logo swaps in for the paired [data-brand-icon] emoji at
// every [data-brand-logo] <img>.

const Branding = (() => {
  let loadPromise = null;
  let rankIcons = ["🥇", "🥈", "🥉"];
  let rankImages = [null, null, null];

  // HTML for a top-3 rank badge: the uploaded image if one is set, otherwise
  // the configured emoji/text; null for any other rank. Pages that render
  // ranks should `await Branding.load()` first.
  function rankIcon(rank) {
    if (!(rank >= 1 && rank <= 3)) return null;
    const image = rankImages[rank - 1];
    if (image) return `<img src="${window.API_BASE_URL}${image}" alt="Rank ${rank}" style="height:1.1em;width:auto;vertical-align:-0.2em;" />`;
    return String(rankIcons[rank - 1]).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function hexShade(hex, amount) {
    const clean = (hex || "").replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return hex;
    const num = parseInt(clean, 16);
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const r = clamp(((num >> 16) & 0xff) + amount);
    const g = clamp(((num >> 8) & 0xff) + amount);
    const b = clamp((num & 0xff) + amount);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }

  function applyColor(color) {
    if (!color) return;
    document.documentElement.style.setProperty("--color-primary", color);
    document.documentElement.style.setProperty("--color-primary-dark", hexShade(color, -25));
  }

  function applyName(name) {
    if (!name) return;
    document.querySelectorAll("[data-brand-name]").forEach((el) => {
      const suffix = el.getAttribute("data-brand-name");
      el.textContent = suffix ? `${name} ${suffix}` : name;
    });
  }

  function applyLogo(logoUrl) {
    document.querySelectorAll("[data-brand-logo]").forEach((el) => {
      if (logoUrl) {
        el.src = `${window.API_BASE_URL}${logoUrl}`;
        el.classList.remove("hidden");
      } else {
        el.removeAttribute("src");
        el.classList.add("hidden");
      }
    });
    document.querySelectorAll("[data-brand-icon]").forEach((el) => {
      el.classList.toggle("hidden", !!logoUrl);
    });
  }

  function load() {
    if (!loadPromise) {
      loadPromise = fetch(`${window.API_BASE_URL}/public/settings`, { cache: "no-store" })
        .then((r) => r.json())
        .then((json) => {
          const data = json.success ? json.data : {};
          applyColor(data.brand_color);
          applyName(data.tuition_name);
          applyLogo(data.logo_url);
          if (Array.isArray(data.rank_icons) && data.rank_icons.length === 3) rankIcons = data.rank_icons;
          if (Array.isArray(data.rank_images) && data.rank_images.length === 3) rankImages = data.rank_images;
          return data;
        })
        .catch(() => ({}));
    }
    return loadPromise;
  }

  return { load, applyName, applyColor, applyLogo, rankIcon };
})();

Branding.load();
