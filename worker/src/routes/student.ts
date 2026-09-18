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

// ---------------------------------------------------------------------------
// Online exams: list, start/resume, autosave answers, submit (auto-grades
// and writes the score into exam_marks so it shows up everywhere marks do).
// ---------------------------------------------------------------------------

function normalizeOptions(s: string | null | undefined): string {
  return (s || "").split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
}

async function finalizeAttempt(db: D1Database, attemptId: string) {
  const attempt = await db.prepare("SELECT * FROM exam_attempts WHERE id = ?").bind(attemptId)
    .first<{ id: string; exam_id: string; student_id: string; status: string; score: number | null }>();
  if (!attempt || attempt.status === "submitted") return attempt;

  const exam = await db.prepare("SELECT template_id FROM exams WHERE id = ?")
    .bind(attempt.exam_id).first<{ template_id: string }>();
  const { results: questions } = await db.prepare(
    "SELECT id, correct_options, marks FROM exam_questions WHERE template_id = ?"
  ).bind(exam!.template_id).all<{ id: string; correct_options: string; marks: number }>();
  const { results: answers } = await db.prepare(
    "SELECT question_id, selected_options FROM exam_answers WHERE attempt_id = ?"
  ).bind(attemptId).all<{ question_id: string; selected_options: string | null }>();

  const answerByQuestion: Record<string, string | null> = {};
  answers.forEach((a) => { answerByQuestion[a.question_id] = a.selected_options; });

  let score = 0;
  for (const q of questions) {
    if (normalizeOptions(q.correct_options) === normalizeOptions(answerByQuestion[q.id])) score += q.marks;
  }

  await db.prepare(
    "UPDATE exam_attempts SET status = 'submitted', submitted_at = datetime('now'), score = ? WHERE id = ?"
  ).bind(score, attemptId).run();

  await db.prepare(
    `INSERT INTO exam_marks (id, exam_id, student_id, marks_obtained, remarks)
     VALUES (?, ?, ?, ?, 'Auto-graded online exam')
     ON CONFLICT (exam_id, student_id) DO UPDATE SET marks_obtained = excluded.marks_obtained, remarks = excluded.remarks`
  ).bind(newId("mark"), attempt.exam_id, attempt.student_id, score).run();

  return { ...attempt, status: "submitted", score };
}

// ---------------------------------------------------------------------------
// Full exam history — every classroom + online exam for the student's
// batches, with marks where uploaded/graded. Any online exam still open (or
// upcoming) and not yet submitted is sorted to the top so the student
// notices it in time to start; everything else sorts by date, most recent
// first.
// ---------------------------------------------------------------------------
type ExamHistoryRow = {
  exam_id: string; exam_name: string; exam_type: string; exam_date: string; total_marks: number;
  starts_at: string | null; ends_at: string | null; duration_minutes: number | null;
  batch_name: string; marks_obtained: number | null; remarks: string | null;
  attempt_id: string | null; attempt_status: string | null;
};

student.get("/exams/history", async (c) => {
  const studentId = c.get("jwtPayload").sub;
  const { results } = await c.env.DB.prepare(
    `SELECT e.id as exam_id, e.exam_name, e.exam_type, e.exam_date, e.total_marks,
       e.starts_at, e.ends_at, e.duration_minutes,
       b.name as batch_name,
       m.marks_obtained, m.remarks,
       a.id as attempt_id, a.status as attempt_status
     FROM exams e
     JOIN batch_students bs ON bs.batch_id = e.batch_id
     JOIN batches b ON b.id = e.batch_id
     LEFT JOIN exam_marks m ON m.exam_id = e.id AND m.student_id = bs.student_id
     LEFT JOIN exam_attempts a ON a.exam_id = e.id AND a.student_id = bs.student_id
     WHERE bs.student_id = ?
     ORDER BY COALESCE(e.starts_at, e.exam_date) DESC`
  ).bind(studentId).all<ExamHistoryRow>();

  const now = Date.now();
  const withStatus = results.map((r) => {
    let windowStatus: string | null = null;
    if (r.exam_type === "online") {
      windowStatus = "upcoming";
      if (r.ends_at && now > new Date(r.ends_at).getTime()) windowStatus = "closed";
      else if (r.starts_at && now >= new Date(r.starts_at).getTime()) windowStatus = "active";
    }
    return { ...r, window_status: windowStatus };
  });

  // Pending = an online exam that's still actionable (upcoming or open) and
  // hasn't been submitted yet — these belong at the top, soonest first.
  const isPending = (r: (typeof withStatus)[number]) =>
    r.exam_type === "online" && r.attempt_status !== "submitted" && (r.window_status === "upcoming" || r.window_status === "active");

  const pending = withStatus.filter(isPending).sort((a, b) =>
    new Date(a.starts_at as string).getTime() - new Date(b.starts_at as string).getTime()
  );
  const rest = withStatus.filter((r) => !isPending(r));

  return ok(c, [...pending, ...rest]);
});

student.post("/exam/:exam_id/start", async (c) => {
  const studentId = c.get("jwtPayload").sub;
  const examId = c.req.param("exam_id");

  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id = ? AND exam_type = 'online'").bind(examId)
    .first<{ id: string; batch_id: string; template_id: string; starts_at: string; ends_at: string; duration_minutes: number; total_marks: number; exam_name: string }>();
  if (!exam) return fail(c, "Online exam not found", 404);

  const membership = await c.env.DB.prepare("SELECT 1 FROM batch_students WHERE batch_id = ? AND student_id = ?")
    .bind(exam.batch_id, studentId).first();
  if (!membership) return fail(c, "This exam is not available for your batch", 403);

  const now = Date.now();
  if (now < new Date(exam.starts_at).getTime()) return fail(c, "This exam hasn't started yet", 403);
  if (now > new Date(exam.ends_at).getTime()) return fail(c, "This exam's window has closed", 403);

  let attempt = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?")
    .bind(examId, studentId).first<{ id: string; status: string; deadline_at: string }>();

  if (attempt?.status === "submitted") return fail(c, "You have already submitted this exam", 409);

  if (!attempt) {
    const deadlineMs = Math.min(now + exam.duration_minutes * 60 * 1000, new Date(exam.ends_at).getTime());
    const id = newId("attempt");
    const deadlineIso = new Date(deadlineMs).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO exam_attempts (id, exam_id, student_id, started_at, deadline_at, status)
       VALUES (?, ?, ?, datetime('now'), ?, 'in_progress')`
    ).bind(id, examId, studentId, deadlineIso).run();
    attempt = { id, status: "in_progress", deadline_at: deadlineIso };
  } else if (now > new Date(attempt.deadline_at).getTime()) {
    await finalizeAttempt(c.env.DB, attempt.id);
    return fail(c, "Your time for this exam ran out and it was submitted automatically.", 410);
  }

  const { results: questions } = await c.env.DB.prepare(
    "SELECT id, question_text, question_type, option_a, option_b, option_c, option_d, marks FROM exam_questions WHERE template_id = ? ORDER BY order_index, id"
  ).bind(exam.template_id).all();

  const { results: existingAnswers } = await c.env.DB.prepare(
    "SELECT question_id, selected_options FROM exam_answers WHERE attempt_id = ?"
  ).bind(attempt.id).all();

  return ok(c, {
    attempt_id: attempt.id,
    exam_name: exam.exam_name,
    total_marks: exam.total_marks,
    deadline_at: attempt.deadline_at,
    questions,
    answers: existingAnswers,
  });
});

student.post("/exam/attempt/:attempt_id/answer", async (c) => {
  const studentId = c.get("jwtPayload").sub;
  const attemptId = c.req.param("attempt_id");
  const { question_id, selected_options } = await c.req.json<{ question_id: string; selected_options: string[] }>();
  if (!question_id) return fail(c, "question_id is required", 400);

  const attempt = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ? AND student_id = ?")
    .bind(attemptId, studentId).first<{ id: string; status: string; deadline_at: string }>();
  if (!attempt) return fail(c, "Attempt not found", 404);
  if (attempt.status === "submitted") return fail(c, "This exam has already been submitted", 409);
  if (Date.now() > new Date(attempt.deadline_at).getTime()) {
    await finalizeAttempt(c.env.DB, attemptId);
    return fail(c, "Your time for this exam ran out", 410);
  }

  await c.env.DB.prepare(
    `INSERT INTO exam_answers (id, attempt_id, question_id, selected_options)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (attempt_id, question_id) DO UPDATE SET selected_options = excluded.selected_options`
  ).bind(newId("ans"), attemptId, question_id, (selected_options || []).join(",")).run();

  return ok(c, { saved: true });
});

student.post("/exam/attempt/:attempt_id/submit", async (c) => {
  const studentId = c.get("jwtPayload").sub;
  const attemptId = c.req.param("attempt_id");

  const attempt = await c.env.DB.prepare("SELECT * FROM exam_attempts WHERE id = ? AND student_id = ?")
    .bind(attemptId, studentId).first<{ id: string; exam_id: string }>();
  if (!attempt) return fail(c, "Attempt not found", 404);

  const finalized = await finalizeAttempt(c.env.DB, attemptId);
  const exam = await c.env.DB.prepare("SELECT total_marks, template_id FROM exams WHERE id = ?")
    .bind(attempt.exam_id).first<{ total_marks: number; template_id: string }>();

  const { results: questions } = await c.env.DB.prepare(
    "SELECT id, question_text, option_a, option_b, option_c, option_d, correct_options, marks FROM exam_questions WHERE template_id = ? ORDER BY order_index, id"
  ).bind(exam!.template_id).all<Record<string, unknown>>();
  const { results: answers } = await c.env.DB.prepare(
    "SELECT question_id, selected_options FROM exam_answers WHERE attempt_id = ?"
  ).bind(attemptId).all<{ question_id: string; selected_options: string | null }>();
  const answerByQuestion: Record<string, string | null> = {};
  answers.forEach((a) => { answerByQuestion[a.question_id] = a.selected_options; });

  const review = questions.map((q) => ({ ...q, your_answer: answerByQuestion[q.id as string] || "" }));

  return ok(c, {
    score: (finalized as { score: number | null } | undefined)?.score ?? null,
    total_marks: exam?.total_marks,
    review,
  });
});

export default student;
