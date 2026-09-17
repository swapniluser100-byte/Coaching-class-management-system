import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { newId } from "../lib/crypto";
import { deriveQrToken, currentWindowIndex, windowEndMs } from "../lib/qr";

const qr = new Hono<{ Bindings: Env; Variables: Variables }>();

qr.use("/*", requireAuth("tutor"));

async function assertOwnsBatch(c: any, batchId: string): Promise<boolean> {
  const tutorId = c.get("jwtPayload").sub;
  const batch = await c.env.DB.prepare("SELECT id FROM batches WHERE id = ? AND tutor_id = ?")
    .bind(batchId, tutorId).first();
  return !!batch;
}

qr.post("/start", async (c) => {
  const { batch_id } = await c.req.json<{ batch_id: string }>();
  if (!batch_id) return fail(c, "batch_id is required", 400);
  if (!(await assertOwnsBatch(c, batch_id))) return fail(c, "Batch not found or not assigned to you", 403);

  const tutorId = c.get("jwtPayload").sub;
  const today = new Date().toISOString().slice(0, 10);

  // Close any stale active session for this batch/date before starting a new one.
  await c.env.DB.prepare(
    "UPDATE attendance_sessions SET status = 'closed', stopped_at = datetime('now') WHERE batch_id = ? AND date = ? AND status = 'active'"
  ).bind(batch_id, today).run();

  const windowMinutes = parseInt(c.env.ATTENDANCE_WINDOW_MINUTES, 10) || 15;
  const id = newId("sess");
  const sessionSecret = crypto.randomUUID();
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + windowMinutes * 60 * 1000);

  await c.env.DB.prepare(
    `INSERT INTO attendance_sessions (id, batch_id, date, session_secret, started_at, ends_at, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(id, batch_id, today, sessionSecret, startedAt.toISOString(), endsAt.toISOString(), tutorId).run();

  return ok(c, { session_id: id, batch_id, date: today, ends_at: endsAt.toISOString() }, 201);
});

qr.get("/current", async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) return fail(c, "session_id is required", 400);

  const session = await c.env.DB.prepare("SELECT * FROM attendance_sessions WHERE id = ?")
    .bind(sessionId).first<{
      id: string; batch_id: string; session_secret: string; status: string; ends_at: string; created_by: string;
    }>();
  if (!session) return fail(c, "Session not found", 404);
  if (session.created_by !== c.get("jwtPayload").sub) return fail(c, "Not your session", 403);

  const now = Date.now();
  if (session.status !== "active" || now > new Date(session.ends_at).getTime()) {
    if (session.status === "active") {
      await c.env.DB.prepare("UPDATE attendance_sessions SET status = 'closed' WHERE id = ?").bind(sessionId).run();
    }
    return fail(c, "Attendance session has closed", 410);
  }

  const rotateSeconds = parseInt(c.env.QR_ROTATE_SECONDS, 10) || 10;
  const windowIndex = currentWindowIndex(rotateSeconds, now);
  const token = await deriveQrToken(c.env.QR_HMAC_SECRET, session.session_secret, session.batch_id, windowIndex);
  const expiresAt = windowEndMs(rotateSeconds, windowIndex);

  return ok(c, {
    session_id: session.id,
    batch_id: session.batch_id,
    token,
    expires_at: expiresAt,
    session_ends_at: session.ends_at,
  });
});

qr.post("/stop", async (c) => {
  const { session_id } = await c.req.json<{ session_id: string }>();
  if (!session_id) return fail(c, "session_id is required", 400);

  const session = await c.env.DB.prepare("SELECT * FROM attendance_sessions WHERE id = ?")
    .bind(session_id).first<{ created_by: string; batch_id: string; date: string }>();
  if (!session) return fail(c, "Session not found", 404);
  if (session.created_by !== c.get("jwtPayload").sub) return fail(c, "Not your session", 403);

  await c.env.DB.prepare(
    "UPDATE attendance_sessions SET status = 'closed', stopped_at = datetime('now') WHERE id = ?"
  ).bind(session_id).run();

  // Mark students who never scanned as absent for the day, for reporting completeness.
  await c.env.DB.prepare(
    `INSERT INTO attendance (id, student_id, batch_id, session_id, date, status, timestamp)
     SELECT lower(hex(randomblob(16))), bs.student_id, ?, ?, ?, 'absent', datetime('now')
     FROM batch_students bs
     WHERE bs.batch_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM attendance a WHERE a.student_id = bs.student_id AND a.batch_id = ? AND a.date = ?
       )`
  ).bind(session.batch_id, session_id, session.date, session.batch_id, session.batch_id, session.date).run();

  return ok(c, { session_id, status: "closed" });
});

export default qr;
