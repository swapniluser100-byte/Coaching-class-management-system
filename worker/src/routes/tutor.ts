import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { verifyPassword, newId } from "../lib/crypto";
import { issueJwt } from "../lib/jwt";

const tutor = new Hono<{ Bindings: Env; Variables: Variables }>();

tutor.post("/login", async (c) => {
  const { phone, password } = await c.req.json<{ phone: string; password: string }>();
  if (!phone || !password) return fail(c, "phone and password required", 400);

  const row = await c.env.DB.prepare("SELECT * FROM tutors WHERE phone = ? AND active = 1")
    .bind(phone).first<{ id: string; name: string; password_hash: string; can_upload_marks: number }>();
  if (!row) return fail(c, "Invalid credentials", 401);

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return fail(c, "Invalid credentials", 401);

  const token = await issueJwt(c.env.JWT_SECRET, row.id, "tutor", row.name);
  return ok(c, { token, tutor: { id: row.id, name: row.name, can_upload_marks: !!row.can_upload_marks } });
});

tutor.use("/*", requireAuth("tutor"));

tutor.get("/batches", async (c) => {
  const tutorId = c.get("jwtPayload").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM batch_students bs WHERE bs.batch_id = b.id) as strength
     FROM batches b WHERE b.tutor_id = ? AND b.active = 1 ORDER BY b.name`
  ).bind(tutorId).all();
  return ok(c, results);
});

tutor.get("/exams", async (c) => {
  const tutorId = c.get("jwtPayload").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT e.* FROM exams e JOIN batches b ON b.id = e.batch_id
     WHERE b.tutor_id = ? ORDER BY e.exam_date DESC`
  ).bind(tutorId).all();
  return ok(c, results);
});

tutor.post("/exam/upload-marks", async (c) => {
  const tutorId = c.get("jwtPayload").sub;

  const permission = await c.env.DB.prepare("SELECT can_upload_marks FROM tutors WHERE id = ?")
    .bind(tutorId).first<{ can_upload_marks: number }>();
  if (!permission?.can_upload_marks) return fail(c, "You are not permitted to upload marks. Contact admin.", 403);

  const b = await c.req.json<{
    exam_id: string;
    marks: { student_id: string; marks_obtained: number; remarks?: string }[];
  }>();
  if (!b.exam_id || !Array.isArray(b.marks)) return fail(c, "exam_id and marks[] are required", 400);

  // Ensure the exam belongs to one of this tutor's batches.
  const exam = await c.env.DB.prepare(
    `SELECT e.id FROM exams e JOIN batches b ON b.id = e.batch_id WHERE e.id = ? AND b.tutor_id = ?`
  ).bind(b.exam_id, tutorId).first();
  if (!exam) return fail(c, "Exam not found for your batches", 404);

  const stmts = b.marks.map((m) =>
    c.env.DB.prepare(
      `INSERT INTO exam_marks (id, exam_id, student_id, marks_obtained, remarks)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (exam_id, student_id) DO UPDATE SET marks_obtained = excluded.marks_obtained, remarks = excluded.remarks`
    ).bind(newId("mark"), b.exam_id, m.student_id, m.marks_obtained, m.remarks || null)
  );
  await c.env.DB.batch(stmts);

  return ok(c, { exam_id: b.exam_id, count: b.marks.length });
});

// ---------------------------------------------------------------------------
// Analytics for a tutor's own batches: daily summary, attendance %, absentee
// trends, heatmap data — consumed by the teacher dashboard's Chart.js views.
// ---------------------------------------------------------------------------
tutor.get("/analytics/:batch_id", async (c) => {
  const tutorId = c.get("jwtPayload").sub;
  const batchId = c.req.param("batch_id");

  const batch = await c.env.DB.prepare("SELECT id FROM batches WHERE id = ? AND tutor_id = ?")
    .bind(batchId, tutorId).first();
  if (!batch) return fail(c, "Batch not found", 404);

  const { results: dailySummary } = await c.env.DB.prepare(
    `SELECT date,
       COUNT(CASE WHEN status = 'present' THEN 1 END) as present,
       COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent
     FROM attendance WHERE batch_id = ? GROUP BY date ORDER BY date DESC LIMIT 60`
  ).bind(batchId).all();

  const { results: studentHistory } = await c.env.DB.prepare(
    `SELECT s.id as student_id, s.name,
       COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present_count,
       COUNT(a.id) as total_sessions
     FROM batch_students bs
     JOIN students s ON s.id = bs.student_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.batch_id = bs.batch_id
     WHERE bs.batch_id = ? GROUP BY s.id ORDER BY s.name`
  ).bind(batchId).all();

  return ok(c, { dailySummary, studentHistory });
});

export default tutor;
