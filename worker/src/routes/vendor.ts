import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { hashPassword, verifyPassword, newId } from "../lib/crypto";
import { issueJwt } from "../lib/jwt";

const vendor = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// One-time bootstrap: creates the first (and normally only) vendor account.
// Requires the VENDOR_BOOTSTRAP_KEY secret and only works while the
// vendor_users table is empty — mirrors the admin bootstrap flow.
// ---------------------------------------------------------------------------
vendor.post("/bootstrap", async (c) => {
  const body = await c.req.json<{ email: string; password: string; name?: string; bootstrap_key: string }>();
  if (body.bootstrap_key !== c.env.VENDOR_BOOTSTRAP_KEY) return fail(c, "Invalid bootstrap key", 403);

  const { count } = (await c.env.DB.prepare("SELECT COUNT(*) as count FROM vendor_users").first()) as { count: number };
  if (count > 0) return fail(c, "Vendor account already exists", 409);

  if (!body.email || !body.password || body.password.length < 8) {
    return fail(c, "Email and password (min 8 chars) are required", 400);
  }

  const id = newId("vendor");
  const passwordHash = await hashPassword(body.password);
  await c.env.DB.prepare("INSERT INTO vendor_users (id, email, password_hash, name) VALUES (?, ?, ?, ?)")
    .bind(id, body.email.toLowerCase(), passwordHash, body.name || null)
    .run();

  return ok(c, { id, email: body.email }, 201);
});

vendor.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return fail(c, "Email and password required", 400);

  const row = await c.env.DB.prepare("SELECT * FROM vendor_users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<{ id: string; email: string; password_hash: string; name: string | null }>();
  if (!row) return fail(c, "Invalid credentials", 401);

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return fail(c, "Invalid credentials", 401);

  const token = await issueJwt(c.env.JWT_SECRET, row.id, "vendor", row.name || row.email);
  return ok(c, { token, vendor: { id: row.id, email: row.email, name: row.name } });
});

vendor.use("/*", requireAuth("vendor"));

// ---------------------------------------------------------------------------
// Renewal reminder — the only thing a vendor manages here. Shown as a
// read-only, dismissible banner in the tuition's own admin console; never
// blocks access to anything.
// ---------------------------------------------------------------------------
vendor.get("/settings/renewal", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('renewal_date', 'renewal_amount', 'renewal_contact')").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return ok(c, {
    renewal_date: map.renewal_date || null,
    renewal_amount: map.renewal_amount ? Number(map.renewal_amount) : null,
    renewal_contact: map.renewal_contact || null,
  });
});

vendor.post("/settings/renewal", async (c) => {
  const { renewal_date, renewal_amount, renewal_contact } = await c.req.json<{
    renewal_date?: string | null; renewal_amount?: number | null; renewal_contact?: string | null;
  }>();

  if (renewal_date !== undefined && renewal_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(renewal_date)) {
    return fail(c, "Renewal date must be in YYYY-MM-DD format", 400);
  }
  if (renewal_amount !== undefined && renewal_amount !== null && (typeof renewal_amount !== "number" || renewal_amount < 0)) {
    return fail(c, "Renewal amount must be a non-negative number", 400);
  }

  const updates: [string, string][] = [];
  const deletes: string[] = [];
  if (renewal_date !== undefined) { if (renewal_date === null) deletes.push("renewal_date"); else updates.push(["renewal_date", renewal_date]); }
  if (renewal_amount !== undefined) { if (renewal_amount === null) deletes.push("renewal_amount"); else updates.push(["renewal_amount", String(renewal_amount)]); }
  if (renewal_contact !== undefined) { if (!renewal_contact || !renewal_contact.trim()) deletes.push("renewal_contact"); else updates.push(["renewal_contact", renewal_contact.trim()]); }

  for (const [key, value] of updates) {
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value).run();
  }
  for (const key of deletes) {
    await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  }

  return ok(c, { updated: updates.map(([key]) => key), removed: deletes });
});

export default vendor;
