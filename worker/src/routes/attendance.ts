import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { newId } from "../lib/crypto";
import { validateQrToken } from "../lib/qr";
import { distanceMeters } from "../lib/geo";

const attendance = new Hono<{ Bindings: Env; Variables: Variables }>();

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
    const session = await c.env.DB.prepare("SELECT * FROM attendance_sessions WHERE id = ?")
      .bind(session_id)
      .first<{ id: string; batch_id: string; date: string; session_secret: string; status: string; ends_at: string }>();
    if (!session) return fail(c, "Attendance session not found", 404);
    if (session.batch_id !== batch_id) return fail(c, "Token does not belong to this batch", 400);
    if (session.status !== "active" || Date.now() > new Date(session.ends_at).getTime()) {
      return fail(c, "Attendance window has closed", 410);
    }

    const rotateSeconds = parseInt(c.env.QR_ROTATE_SECONDS, 10) || 10;
    const tokenValid = await validateQrToken(
      c.env.QR_HMAC_SECRET, session.session_secret, batch_id, token, rotateSeconds
    );
    if (!tokenValid) return fail(c, "QR code has expired, please rescan", 401);

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
    const batch = await c.env.DB.prepare("SELECT classroom_lat, classroom_long, geo_radius_m FROM batches WHERE id = ?")
      .bind(batch_id).first<{ classroom_lat: number | null; classroom_long: number | null; geo_radius_m: number }>();
    let distance: number | null = null;
    if (batch?.classroom_lat != null && batch?.classroom_long != null) {
      distance = distanceMeters(geo_lat, geo_long, batch.classroom_lat, batch.classroom_long);
      const radius = batch.geo_radius_m || parseInt(c.env.GEO_RADIUS_METERS, 10) || 100;
      if (distance > radius) {
        return fail(c, `You appear to be ${Math.round(distance)}m away from the classroom (limit ${radius}m)`, 403);
      }
    }

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
// GET /attendance/batch/:id — tutor's live attendance list for a batch/date.
// ---------------------------------------------------------------------------
attendance.get("/batch/:id", requireAuth("tutor", "admin"), async (c) => {
  const batchId = c.req.param("id");
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);

  const { results } = await c.env.DB.prepare(
    `SELECT s.id as student_id, s.name, s.phone, a.status, a.timestamp, a.distance_m
     FROM batch_students bs
     JOIN students s ON s.id = bs.student_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.batch_id = bs.batch_id AND a.date = ?
     WHERE bs.batch_id = ?
     ORDER BY s.name`
  ).bind(date, batchId).all();

  return ok(c, { batch_id: batchId, date, students: results });
});

export default attendance;
