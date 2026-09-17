import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";

const photos = new Hono<{ Bindings: Env; Variables: Variables }>();

// Any authenticated role (admin, tutor, student) may view a student photo.
photos.get("/*", requireAuth("admin", "tutor", "student"), async (c) => {
  const key = c.req.path.replace(/^\/photos\//, "");
  if (!key) return fail(c, "Missing photo key", 400);

  const object = await c.env.PHOTOS_BUCKET.get(key);
  if (!object) return fail(c, "Photo not found", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(object.body, { headers });
});

export default photos;
