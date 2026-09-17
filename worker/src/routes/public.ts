import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok } from "../lib/response";

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const DEFAULT_TUITION_NAME = "Tuition Management System";
export const DEFAULT_BRAND_COLOR = "#3654e0";

// No auth — every portal's login/landing page needs this before anyone is signed in.
publicRoutes.get("/settings", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('tuition_name', 'brand_color')").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return ok(c, {
    tuition_name: map.tuition_name || DEFAULT_TUITION_NAME,
    brand_color: map.brand_color || DEFAULT_BRAND_COLOR,
  });
});

export default publicRoutes;
