import { Hono, type Context } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { newId, verifyPassword } from "../lib/crypto";
import { validateQrToken } from "../lib/qr";
import { distanceMeters } from "../lib/geo";

const attendance = new Hono<{ Bindings: Env; Variables: Variables }>();

type SessionRow = { id: string; batch_id: string; date: string; session_secret: string; status: string; ends_at: string };

// Shared QR session/token validation used by both the logged-in and
// PIN-based (login-free) attendance-marking endpoints.
async function validateAttendanceSession(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  session_id: string,
  batch_id: string,
  token: string
): Promise<{ session: SessionRow } | { error: Response }> {
  const session = await c.env.DB.prepare("SELECT * FROM attendance_sessions WHERE id = ?")
    .bind(session_id)
    .first<SessionRow>();
  if (!session) return { error: fail(c, "Attendance session not found", 404) };
  if (session.batch_id !== batch_id) return { error: fail(c, "Token does not belong to this batch", 400) };
  if (session.status !== "active" || Date.now() > new Date(session.ends_at).getTime()) {
    return { error: fail(c, "Attendance window has closed", 410) };
  }

  const rotateSeconds = parseInt(c.env.QR_ROTATE_SECONDS, 10) || 10;
  const tokenValid = await validateQrToken(
    c.env.QR_HMAC_SECRET, session.session_secret, batch_id, token, rotateSeconds
  );
  if (!tokenValid) return { error: fail(c, "QR code has expired, please rescan", 401) };

  return { session };
}

// Shared geo-fence check: null distance means the batch has no classroom
// coordinates configured, so the check is skipped entirely.
async function checkGeoFence(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  batch_id: string,
  geo_lat: number,
  geo_long: number
): Promise<{ distance: number | null } | { error: Response }> {
  const batch = await c.env.DB.prepare("SELECT classroom_lat, classroom_long, geo_radius_m FROM batches WHERE id = ?")
    .bind(batch_id).first<{ classroom_lat: number | null; classroom_long: number | null; geo_radius_m: number }>();
  if (batch?.classroom_lat == null || batch?.classroom_long == null) return { distance: null };

  const distance = distanceMeters(geo_lat, geo_long, batch.classroom_lat, batch.classroom_long);
  const radius = batch.geo_radius_m || parseInt(c.env.GEO_RADIUS_METERS, 10) || 100;
  if (distance > radius) {
    return { error: fail(c, `You appear to be ${Math.round(distance)}m away from the classroom (limit ${radius}m)`, 403) };
  }
  return { distance };
}

// ---------------------------------------------------------------------------
// POST /attendance/mark — student scans QR to mark attendance.
// Runs every anti-cheating check in the spec, in order, failing fast.
// ---------------------------------------------------------------------------
attendance.post(
  "/mark",
  requireAuth("student"),
  rateLimit({ keyPrefix: "attendance-mark", limit: 8, windowSeconds: 60 }),
  async (c) => {
    const studentId = c.get("jwtPayload").sub;
    const body = await c.req.json<{
      session_id: string;
      batch_id: string;
      token: string;
      geo_lat: number;
      geo_long: number;
      device_fingerprint: string;
    }>();

    const { session_id, batch_id, token, geo_lat, geo_long, device_fingerprint } = body;
    if (!session_id || !batch_id || !token || geo_lat === undefined || geo_long === undefined || !device_fingerprint) {
      return fail(c, "session_id, batch_id, token, geo_lat, geo_long and device_fingerprint are all required", 400);
    }

    // 1. Session + token must be valid and not expired / rotated out.
    const sessionResult = await validateAttendanceSession(c, session_id, batch_id, token);
    if ("error" in sessionResult) return sessionResult.error;
    const { session } = sessionResult;

    // 2. Student must belong to the batch.
    const membership = await c.env.DB.prepare(
      "SELECT 1 FROM batch_students WHERE batch_id = ? AND student_id = ?"
    ).bind(batch_id, studentId).first();
    if (!membership) return fail(c, "You are not enrolled in this batch", 403);

    // 3. Student's registered device must match (bound at first OTP login).
    const student = await c.env.DB.prepare("SELECT device_fingerprint, active FROM students WHERE id = ?")
      .bind(studentId).first<{ device_fingerprint: string | null; active: number }>();
    if (!student || !student.active) return fail(c, "Student account not found or inactive", 404);
    if (student.device_fingerprint && student.device_fingerprint !== device_fingerprint) {
      return fail(c, "This device is not your registered device. Contact admin to reset it.", 403);
    }

    // 4. Geo-fence check: must be within the batch's configured radius.
    const geoResult = await checkGeoFence(c, batch_id, geo_lat, geo_long);
    if ("error" in geoResult) return geoResult.error;
    const { distance } = geoResult;

    // 5. No duplicate attendance for the same day (UNIQUE constraint is the source of truth).
    const id = newId("att");
    try {
      await c.env.DB.prepare(
        `INSERT INTO attendance (id, student_id, batch_id, session_id, date, status, timestamp, geo_lat, geo_long, distance_m, device_fingerprint)
         VALUES (?, ?, ?, ?, ?, 'present', datetime('now'), ?, ?, ?, ?)`
      ).bind(id, studentId, batch_id, session_id, session.date, geo_lat, geo_long, distance, device_fingerprint).run();
    } catch {
      return fail(c, "Attendance already marked for today", 409);
    }

    return ok(c, { id, status: "present", date: session.date }, 201);
  }
);

// ---------------------------------------------------------------------------
// POST /attendance/mark-pin — login-free attendance marking. Scan the QR,
// then identify yourself with your phone number + a 4-digit PIN (set by
// admin) instead of a full OTP login. Weaker than JWT-based /mark (a static
// PIN is far more guessable than a fresh OTP), so it locks after 5 wrong
// attempts and still enforces the same device-fingerprint binding, geo-fence
// and one-mark-per-day checks.
// ---------------------------------------------------------------------------
attendance.post(
  "/mark-pin",
  rateLimit({ keyPrefix: "attendance-mark-pin", limit: 8, windowSeconds: 60 }),
  async (c) => {
    const body = await c.req.json<{
      session_id: string;
      batch_id: string;
      token: string;
      phone: string;
      pin: string;
      geo_lat: number;
      geo_long: number;
      device_fingerprint: string;
    }>();

    const { session_id, batch_id, token, phone, pin, geo_lat, geo_long, device_fingerprint } = body;
    if (!session_id || !batch_id || !token || !phone || !pin || geo_lat === undefined || geo_long === undefined || !device_fingerprint) {
      return fail(c, "session_id, batch_id, token, phone, pin, geo_lat, geo_long and device_fingerprint are all required", 400);
    }

    // 1. Session + token must be valid and not expired / rotated out.
    const sessionResult = await validateAttendanceSession(c, session_id, batch_id, token);
    if ("error" in sessionResult) return sessionResult.error;
    const { session } = sessionResult;

    // 2. Identify the student by phone, and make sure they belong to this batch.
    const student = await c.env.DB.prepare(
      `SELECT s.id, s.active, s.device_fingerprint, s.pin_hash, s.pin_failed_attempts
       FROM students s
       JOIN batch_students bs ON bs.student_id = s.id
       WHERE s.phone = ? AND bs.batch_id = ?`
    ).bind(phone, batch_id).first<{
      id: string; active: number; device_fingerprint: string | null; pin_hash: string | null; pin_failed_attempts: number;
    }>();
    if (!student || !student.active) return fail(c, "No active student with this phone number in this batch", 404);

    // 3. PIN must be set and not locked out from too many wrong attempts.
    if (!student.pin_hash) return fail(c, "No PIN set for this account yet. Ask your admin to set one.", 403);
    if (student.pin_failed_attempts >= 5) {
      return fail(c, "Too many incorrect PIN attempts. Ask your admin to reset your PIN.", 403);
    }

    const pinValid = await verifyPassword(pin, student.pin_hash);
    if (!pinValid) {
      const attempts = student.pin_failed_attempts + 1;
      await c.env.DB.prepare("UPDATE students SET pin_failed_attempts = ? WHERE id = ?").bind(attempts, student.id).run();
      const remaining = Math.max(0, 5 - attempts);
      return fail(c, `Incorrect PIN. ${remaining} attempt(s) remaining before lockout.`, 401);
    }
    await c.env.DB.prepare("UPDATE students SET pin_failed_attempts = 0 WHERE id = ?").bind(student.id).run();

    // 4. Device fingerprint: bind on first use, otherwise must match.
    if (student.device_fingerprint && student.device_fingerprint !== device_fingerprint) {
      return fail(c, "This device is not your registered device. Contact admin to reset it.", 403);
    }
    if (!student.device_fingerprint) {
      await c.env.DB.prepare("UPDATE students SET device_fingerprint = ? WHERE id = ?").bind(device_fingerprint, student.id).run();
    }

    // 5. Geo-fence check: must be within the batch's configured radius.
    const geoResult = await checkGeoFence(c, batch_id, geo_lat, geo_long);
    if ("error" in geoResult) return geoResult.error;
    const { distance } = geoResult;

    // 6. No duplicate attendance for the same day (UNIQUE constraint is the source of truth).
    const id = newId("att");
    try {
      await c.env.DB.prepare(
        `INSERT INTO attendance (id, student_id, batch_id, session_id, date, status, timestamp, geo_lat, geo_long, distance_m, device_fingerprint)
         VALUES (?, ?, ?, ?, ?, 'present', datetime('now'), ?, ?, ?, ?)`
      ).bind(id, student.id, batch_id, session_id, session.date, geo_lat, geo_long, distance, device_fingerprint).run();
    } catch {
      return fail(c, "Attendance already marked for today", 409);
    }

    return ok(c, { id, status: "present", date: session.date }, 201);
  }
);

// ---------------------------------------------------------------------------
// GET /attendance/batch/:id — tutor's live attendance list for a batch/date.
// ---------------------------------------------------------------------------
attendance.get("/batch/:id", requireAuth("tutor", "admin"), async (c) => {
  const batchId = c.req.param("id");
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);

  const { results } = await c.env.DB.prepare(
    `SELECT s.id as student_id, s.name, s.phone, a.status, a.timestamp, a.distance_m, a.source
     FROM batch_students bs
     JOIN students s ON s.id = bs.student_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.batch_id = bs.batch_id AND a.date = ?
     WHERE bs.batch_id = ?
     ORDER BY s.name`
  ).bind(date, batchId).all();

  return ok(c, { batch_id: batchId, date, students: results });
});

// ---------------------------------------------------------------------------
// POST /attendance/mark-manual — tutor/admin manually marks a student
// present, for students who can't scan (no working phone, camera issues,
// etc). Bypasses QR/geo/device checks entirely, so it's clearly flagged
// with source='manual' everywhere attendance is displayed or exported.
// ---------------------------------------------------------------------------
attendance.post("/mark-manual", requireAuth("tutor", "admin"), async (c) => {
  const { batch_id, student_id, date } = await c.req.json<{
    batch_id: string; student_id: string; date?: string;
  }>();
  if (!batch_id || !student_id) return fail(c, "batch_id and student_id are required", 400);

  const jwt = c.get("jwtPayload");
  if (jwt.role === "tutor") {
    const batch = await c.env.DB.prepare("SELECT id FROM batches WHERE id = ? AND tutor_id = ?")
      .bind(batch_id, jwt.sub).first();
    if (!batch) return fail(c, "Batch not found or not assigned to you", 403);
  }

  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM batch_students WHERE batch_id = ? AND student_id = ?"
  ).bind(batch_id, student_id).first();
  if (!membership) return fail(c, "Student is not enrolled in this batch", 404);

  const markDate = date || new Date().toISOString().slice(0, 10);
  const id = newId("att");
  await c.env.DB.prepare(
    `INSERT INTO attendance (id, student_id, batch_id, date, status, timestamp, source)
     VALUES (?, ?, ?, ?, 'present', datetime('now'), 'manual')
     ON CONFLICT (student_id, batch_id, date)
     DO UPDATE SET status = 'present', timestamp = datetime('now'), source = 'manual'`
  ).bind(id, student_id, batch_id, markDate).run();

  return ok(c, { student_id, batch_id, date: markDate, status: "present" }, 201);
});

// ---------------------------------------------------------------------------
// POST /attendance/mark-absent — tutor/admin corrects a present mark (self,
// PIN, or manual) back to absent. Same ownership rules as mark-manual;
// always recorded as source='manual' since it's an explicit override.
// ---------------------------------------------------------------------------
attendance.post("/mark-absent", requireAuth("tutor", "admin"), async (c) => {
  const { batch_id, student_id, date } = await c.req.json<{
    batch_id: string; student_id: string; date?: string;
  }>();
  if (!batch_id || !student_id) return fail(c, "batch_id and student_id are required", 400);

  const jwt = c.get("jwtPayload");
  if (jwt.role === "tutor") {
    const batch = await c.env.DB.prepare("SELECT id FROM batches WHERE id = ? AND tutor_id = ?")
      .bind(batch_id, jwt.sub).first();
    if (!batch) return fail(c, "Batch not found or not assigned to you", 403);
  }

  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM batch_students WHERE batch_id = ? AND student_id = ?"
  ).bind(batch_id, student_id).first();
  if (!membership) return fail(c, "Student is not enrolled in this batch", 404);

  const markDate = date || new Date().toISOString().slice(0, 10);
  const id = newId("att");
  await c.env.DB.prepare(
    `INSERT INTO attendance (id, student_id, batch_id, date, status, timestamp, source)
     VALUES (?, ?, ?, ?, 'absent', datetime('now'), 'manual')
     ON CONFLICT (student_id, batch_id, date)
     DO UPDATE SET status = 'absent', timestamp = datetime('now'), source = 'manual'`
  ).bind(id, student_id, batch_id, markDate).run();

  return ok(c, { student_id, batch_id, date: markDate, status: "absent" }, 201);
});

export default attendance;
