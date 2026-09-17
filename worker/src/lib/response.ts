import type { Context } from "hono";

export function ok(c: Context, data: unknown, status: 200 | 201 = 200) {
  return c.json({ success: true, data }, status);
}

export function fail(c: Context, message: string, status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 = 400) {
  return c.json({ success: false, error: message }, status);
}
