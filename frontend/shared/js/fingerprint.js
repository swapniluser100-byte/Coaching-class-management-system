// Lightweight, dependency-free device fingerprint.
// Combines several stable browser/hardware signals (canvas rendering,
// WebGL renderer string, screen geometry, timezone, CPU cores) into a
// single SHA-256 hash. This is intentionally NOT stored in localStorage as
// the source of truth — it is recomputed each time so that switching
// browsers/devices genuinely changes the fingerprint, which is what the
// backend uses to bind a student to "their registered device".

async function getDeviceFingerprint() {
  const parts = [];

  parts.push(navigator.userAgent || "");
  parts.push(String(screen.width) + "x" + String(screen.height) + "x" + String(screen.colorDepth));
  parts.push(String(navigator.hardwareConcurrency || ""));
  parts.push(String(navigator.language || ""));
  parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  parts.push(String(navigator.maxTouchPoints || 0));

  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = 220;
    canvas.height = 30;
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 220, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("tuition-attendance-fp", 2, 2);
    parts.push(canvas.toDataURL());
  } catch {
    parts.push("no-canvas");
  }

  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbgInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
    if (gl && dbgInfo) {
      parts.push(gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) || "");
      parts.push(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) || "");
    }
  } catch {
    parts.push("no-webgl");
  }

  const raw = parts.join("###");
  const encoded = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
