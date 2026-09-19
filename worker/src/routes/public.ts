import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const DEFAULT_TUITION_NAME = "Tuition Management System";
export const DEFAULT_BRAND_COLOR = "#3654e0";
export const DEFAULT_RANK_ICONS = ["🥇", "🥈", "🥉"];
export const LOGO_R2_KEY = "branding/logo";

// No auth — every portal's login/landing page needs this before anyone is signed in.
publicRoutes.get("/settings", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('tuition_name', 'brand_color', 'logo_updated_at', 'rank_1_icon', 'rank_2_icon', 'rank_3_icon')").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return ok(c, {
    tuition_name: map.tuition_name || DEFAULT_TUITION_NAME,
    brand_color: map.brand_color || DEFAULT_BRAND_COLOR,
    rank_icons: [1, 2, 3].map((n) => map[`rank_${n}_icon`] || DEFAULT_RANK_ICONS[n - 1]),
    logo_url: map.logo_updated_at ? `/public/logo?v=${encodeURIComponent(map.logo_updated_at)}` : null,
  });
});

// No auth — the logo needs to render on every login page before anyone is signed in.
publicRoutes.get("/logo", async (c) => {
  const object = await c.env.PHOTOS_BUCKET.get(LOGO_R2_KEY);
  if (!object) return fail(c, "No logo set", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

export default publicRoutes;
