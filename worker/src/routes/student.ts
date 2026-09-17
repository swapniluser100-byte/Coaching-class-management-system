import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { newId, randomOtp, hashPassword, verifyPassword } from "../lib/crypto";
import { issueJwt } from "../lib/jwt";

const student = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Mock OTP login: step 1 issues an OTP (in production this would be sent via
// SMS gateway; here it is stored hashed and returned only when ENVIRONMENT
// is not "production", so the flow is testable end-to-end without an SMS
// provider configured).
// ---------------------------------------------------------------------------
student.post(
  "/otp/request",
  rateLimit({ keyPrefix: "otp-request", limit: 5, windowSeconds: 60 }),
  async (c) => {
    const { phone } = await c.req.json<{ phone: string }>();
    if (!phone) return fail(c, "phone is required", 400);

    const existing = await c.env.DB.prepare("SELECT id FROM students WHERE phone = ?").bind(phone).first();
    if (!existing) return fail(c, "No student registered with this phone number", 404);

    const otp = randomOtp();
    const otpHash = await hashPassword(otp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await c.env.DB.prepare(
      "INSERT INTO otp_requests (id, phone, otp_hash, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(newId("otp"), phone, otpHash, expiresAt).run();

    const isProd = c.env.ENVIRONMENT === "production";
    return ok(c, { message: "OTP sent", ...(isProd ? {} : { mock_otp: otp }) });
  }
);

// Step 2: verify OTP, bind device fingerprint on first login, issue JWT.
student.post(
  "/login",
  rateLimit({ keyPrefix: "student-login", limit: 10, windowSeconds: 60 }),
  async (c) => {
    const { phone, otp, device_fingerprint } = await c.req.json<{
      phone: string; otp: string; device_fingerprint: string;
    }>();
    if (!phone || !otp || !device_fingerprint) {
      return fail(c, "phone, otp and device_fingerprint are required", 400);
    }

    const otpRow = await c.env.DB.prepare(
      "SELECT * FROM otp_requests WHERE phone = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1"
    ).bind(phone).first<{ id: string; otp_hash: string; expires_at: string }>();
    if (!otpRow) return fail(c, "No pending OTP for this number, request a new one", 400);
    if (new Date(otpRow.expires_at).getTime() < Date.now()) return fail(c, "OTP expired", 400);

    const valid = await verifyPassword(otp, otpRow.otp_hash);
    if (!valid) return fail(c, "Incorrect OTP", 401);

    await c.env.DB.prepare("UPDATE otp_requests SET consumed = 1 WHERE id = ?").bind(otpRow.id).run();

    const stu = await c.env.DB.prepare("SELECT * FROM students WHERE phone = ?")
      .bind(phone).first<{ id: string; name: string; device_fingerprint: string | null; active: number }>();
    if (!stu || !stu.active) return fail(c, "Student account not found or inactive", 404);

    if (!stu.device_fingerprint) {
      // First login: bind this device as the student's registered device.
      await c.env.DB.prepare("UPDATE students SET device_fingerprint = ? WHERE id = ?")
        .bind(device_fingerprint, stu.id).run();
    } else if (stu.device_fingerprint !== device_fingerprint) {
      return fail(c, "This account is already bound to another device. Contact admin to reset it.", 403);
    }

    const token = await issueJwt(c.env.JWT_SECRET, stu.id, "student", stu.name);
    return ok(c, { token, student: { id: stu.id, name: stu.name } });
  }
);

student.use("/*", requireAuth("student"));

student.get("/profile", async (c) => {
  const id = c.get("jwtPayload").sub;
  const row = await c.env.DB.prepare(
    "SELECT id, name, phone, parent_phone, class_level, photo_url FROM students WHERE id = ?"
  ).bind(id).first();
  return ok(c, row);
});

student.get("/history", async (c) => {
  const id = c.get("jwtPayload").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT a.date, a.status, a.timestamp, b.name as batch_name
     FROM attendance a JOIN batches b ON b.id = a.batch_id
     WHERE a.student_id = ? ORDER BY a.date DESC LIMIT 200`
  ).bind(id).all();
  return ok(c, results);
});

student.get("/schedule", async (c) => {
  const id = c.get("jwtPayload").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.subject, b.class_level, b.schedule_days, b.schedule_time
     FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
     WHERE bs.student_id = ? AND b.active = 1`
  ).bind(id).all();
  return ok(c, results);
});

student.post("/photo", async (c) => {
  const id = c.get("jwtPayload").sub;
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  if (!contentType.startsWith("image/")) return fail(c, "Only image uploads are allowed", 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return fail(c, "Empty file", 400);
  if (body.byteLength > 5 * 1024 * 1024) return fail(c, "Image too large (max 5MB)", 400);

  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const key = `students/${id}/${newId()}.${ext}`;

  await c.env.PHOTOS_BUCKET.put(key, body, { httpMetadata: { contentType } });
  await c.env.DB.prepare("UPDATE students SET photo_url = ? WHERE id = ?").bind(key, id).run();

  return ok(c, { photo_key: key });
});

// ---------------------------------------------------------------------------
// POST /student/exam/view — look up marks by unique exam_code.
// ---------------------------------------------------------------------------
student.post("/exam/view", async (c) => {
  const studentId = c.get("jwtPayload").sub;
  const { exam_code } = await c.req.json<{ exam_code: string }>();
  if (!exam_code) return fail(c, "exam_code is required", 400);

  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE exam_code = ?")
    .bind(exam_code.toUpperCase().trim()).first<{
      id: string; batch_id: string; exam_name: string; exam_date: string; total_marks: number;
    }>();
  if (!exam) return fail(c, "Invalid exam code", 404);

  const membership = await c.env.DB.prepare(
    "SELECT 1 FROM batch_students WHERE batch_id = ? AND student_id = ?"
  ).bind(exam.batch_id, studentId).first();
  if (!membership) return fail(c, "This exam is not available for your batch", 403);

  const myMark = await c.env.DB.prepare(
    "SELECT marks_obtained, remarks FROM exam_marks WHERE exam_id = ? AND student_id = ?"
  ).bind(exam.id, studentId).first<{ marks_obtained: number; remarks: string | null }>();

  const stats = await c.env.DB.prepare(
    `SELECT ROUND(AVG(marks_obtained), 1) as batch_average, MAX(marks_obtained) as topper_marks, COUNT(*) as total_entries
     FROM exam_marks WHERE exam_id = ?`
  ).bind(exam.id).first<{ batch_average: number; topper_marks: number; total_entries: number }>();

  let rank: number | null = null;
  if (myMark) {
    const rankRow = await c.env.DB.prepare(
      "SELECT COUNT(*) + 1 as rank FROM exam_marks WHERE exam_id = ? AND marks_obtained > ?"
    ).bind(exam.id, myMark.marks_obtained).first<{ rank: number }>();
    rank = rankRow?.rank ?? null;
  }

  return ok(c, {
    exam: {
      exam_name: exam.exam_name,
      exam_date: exam.exam_date,
      total_marks: exam.total_marks,
    },
    marks_obtained: myMark?.marks_obtained ?? null,
    remarks: myMark?.remarks ?? null,
    batch_average: stats?.batch_average ?? null,
    topper_marks: stats?.topper_marks ?? null,
    rank,
    total_students: stats?.total_entries ?? 0,
  });
});

export default student;
