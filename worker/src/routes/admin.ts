import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { hashPassword, verifyPassword, newId, randomExamCode } from "../lib/crypto";
import { issueJwt } from "../lib/jwt";
import { LOGO_R2_KEY } from "./public";

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// One-time bootstrap: creates the first admin account. Requires the
// ADMIN_BOOTSTRAP_KEY secret and only works while the admins table is empty.
// ---------------------------------------------------------------------------
admin.post("/bootstrap", async (c) => {
  const body = await c.req.json<{ email: string; password: string; name?: string; bootstrap_key: string }>();
  if (body.bootstrap_key !== c.env.ADMIN_BOOTSTRAP_KEY) return fail(c, "Invalid bootstrap key", 403);

  const { count } = (await c.env.DB.prepare("SELECT COUNT(*) as count FROM admins").first()) as { count: number };
  if (count > 0) return fail(c, "Admin already exists", 409);

  if (!body.email || !body.password || body.password.length < 8) {
    return fail(c, "Email and password (min 8 chars) are required", 400);
  }

  const id = newId("admin");
  const passwordHash = await hashPassword(body.password);
  await c.env.DB.prepare("INSERT INTO admins (id, email, password_hash, name) VALUES (?, ?, ?, ?)")
    .bind(id, body.email.toLowerCase(), passwordHash, body.name || null)
    .run();

  return ok(c, { id, email: body.email }, 201);
});

admin.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return fail(c, "Email and password required", 400);

  const row = await c.env.DB.prepare("SELECT * FROM admins WHERE email = ?")
    .bind(email.toLowerCase())
    .first<{ id: string; email: string; password_hash: string; name: string | null }>();
  if (!row) return fail(c, "Invalid credentials", 401);

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return fail(c, "Invalid credentials", 401);

  const token = await issueJwt(c.env.JWT_SECRET, row.id, "admin", row.name || row.email);
  return ok(c, { token, admin: { id: row.id, email: row.email, name: row.name } });
});

admin.use("/*", requireAuth("admin"));

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
admin.get("/students", async (c) => {
  // batch_ids/batch_names are parallel comma-separated lists (every batch
  // the student is in, not just the most recent) -- they come from the same
  // GROUP BY so the two lists line up position-for-position.
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.phone, s.parent_phone, s.class_level, s.photo_url, s.device_fingerprint, s.active, s.created_at,
       (s.pin_hash IS NOT NULL) as pin_set, s.pin_failed_attempts,
       GROUP_CONCAT(b.id) as batch_ids,
       GROUP_CONCAT(b.name) as batch_names
     FROM students s
     LEFT JOIN batch_students bs ON bs.student_id = s.id
     LEFT JOIN batches b ON b.id = bs.batch_id
     GROUP BY s.id ORDER BY s.created_at DESC`
  ).all();
  return ok(c, results);
});

admin.post("/student/create", async (c) => {
  const b = await c.req.json<{
    name: string; phone: string; parent_phone?: string; class_level?: string; batch_id?: string;
  }>();
  if (!b.name || !b.phone) return fail(c, "name and phone are required", 400);

  const id = newId("stu");
  try {
    await c.env.DB.prepare(
      "INSERT INTO students (id, name, phone, parent_phone, class_level) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, b.name, b.phone, b.parent_phone || null, b.class_level || null).run();
  } catch {
    return fail(c, "A student with this phone number already exists", 409);
  }

  if (b.batch_id) {
    await c.env.DB.prepare(
      "INSERT INTO batch_students (id, batch_id, student_id) VALUES (?, ?, ?)"
    ).bind(newId("bs"), b.batch_id, id).run();
  }

  return ok(c, { id }, 201);
});

admin.post("/student/update", async (c) => {
  const b = await c.req.json<{
    id: string; name?: string; phone?: string; parent_phone?: string; class_level?: string;
    active?: boolean; reset_device?: boolean; batch_id?: string;
  }>();
  if (!b.id) return fail(c, "id is required", 400);

  await c.env.DB.prepare(
    `UPDATE students SET
       name = COALESCE(?, name),
       phone = COALESCE(?, phone),
       parent_phone = COALESCE(?, parent_phone),
       class_level = COALESCE(?, class_level),
       active = COALESCE(?, active),
       device_fingerprint = CASE WHEN ? = 1 THEN NULL ELSE device_fingerprint END
     WHERE id = ?`
  ).bind(
    b.name ?? null, b.phone ?? null, b.parent_phone ?? null, b.class_level ?? null,
    b.active === undefined ? null : (b.active ? 1 : 0),
    b.reset_device ? 1 : 0,
    b.id
  ).run();

  if (b.batch_id) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO batch_students (id, batch_id, student_id) VALUES (?, ?, ?)"
    ).bind(newId("bs"), b.batch_id, b.id).run();
  }

  return ok(c, { id: b.id });
});

// Sets (or resets) a student's 4-digit PIN for login-free attendance
// marking. Also clears any accumulated failed-attempt lockout.
admin.post("/student/set-pin", async (c) => {
  const { id, pin } = await c.req.json<{ id: string; pin: string }>();
  if (!id || !pin) return fail(c, "id and pin are required", 400);
  if (!/^\d{4}$/.test(pin)) return fail(c, "PIN must be exactly 4 digits", 400);

  const pinHash = await hashPassword(pin);
  await c.env.DB.prepare(
    "UPDATE students SET pin_hash = ?, pin_failed_attempts = 0 WHERE id = ?"
  ).bind(pinHash, id).run();

  return ok(c, { id });
});

admin.post("/student/delete", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!id) return fail(c, "id is required", 400);
  await c.env.DB.prepare("DELETE FROM students WHERE id = ?").bind(id).run();
  return ok(c, { id });
});

// Assign / remove students from a batch
admin.post("/batch/assign-student", async (c) => {
  const { batch_id, student_id } = await c.req.json<{ batch_id: string; student_id: string }>();
  if (!batch_id || !student_id) return fail(c, "batch_id and student_id required", 400);
  try {
    await c.env.DB.prepare("INSERT INTO batch_students (id, batch_id, student_id) VALUES (?, ?, ?)")
      .bind(newId("bs"), batch_id, student_id).run();
  } catch {
    return fail(c, "Student already assigned to this batch", 409);
  }
  return ok(c, { batch_id, student_id }, 201);
});

admin.post("/batch/remove-student", async (c) => {
  const { batch_id, student_id } = await c.req.json<{ batch_id: string; student_id: string }>();
  if (!batch_id || !student_id) return fail(c, "batch_id and student_id required", 400);
  await c.env.DB.prepare("DELETE FROM batch_students WHERE batch_id = ? AND student_id = ?")
    .bind(batch_id, student_id).run();
  return ok(c, { batch_id, student_id });
});

// ---------------------------------------------------------------------------
// Student photo upload -> R2
// ---------------------------------------------------------------------------
admin.post("/student/:id/photo", async (c) => {
  const studentId = c.req.param("id");
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  if (!contentType.startsWith("image/")) return fail(c, "Only image uploads are allowed", 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return fail(c, "Empty file", 400);
  if (body.byteLength > 5 * 1024 * 1024) return fail(c, "Image too large (max 5MB)", 400);

  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
  const key = `students/${studentId}/${newId()}.${ext}`;

  await c.env.PHOTOS_BUCKET.put(key, body, { httpMetadata: { contentType } });
  await c.env.DB.prepare("UPDATE students SET photo_url = ? WHERE id = ?").bind(key, studentId).run();

  return ok(c, { photo_key: key });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------
admin.get("/batches", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.*, t.name as tutor_name,
       (SELECT COUNT(*) FROM batch_students bs WHERE bs.batch_id = b.id) as strength
     FROM batches b LEFT JOIN tutors t ON t.id = b.tutor_id
     ORDER BY b.created_at DESC`
  ).all();
  return ok(c, results);
});

admin.get("/batch/:id/students", async (c) => {
  const batchId = c.req.param("id");
  const { results } = await c.env.DB.prepare(
    `SELECT s.* FROM students s
     JOIN batch_students bs ON bs.student_id = s.id
     WHERE bs.batch_id = ? ORDER BY s.name`
  ).bind(batchId).all();
  return ok(c, results);
});

admin.post("/batch/create", async (c) => {
  const b = await c.req.json<{
    name: string; subject?: string; class_level: string; tutor_id?: string;
    schedule_days?: string; schedule_time?: string;
    classroom_lat?: number; classroom_long?: number; geo_radius_m?: number; fee_amount?: number;
  }>();
  if (!b.name || !b.class_level) return fail(c, "name and class_level are required", 400);
  if (b.fee_amount !== undefined && b.fee_amount !== null && (typeof b.fee_amount !== "number" || b.fee_amount < 0)) {
    return fail(c, "fee_amount must be a non-negative number", 400);
  }

  const id = newId("batch");
  await c.env.DB.prepare(
    `INSERT INTO batches (id, name, subject, class_level, tutor_id, schedule_days, schedule_time, classroom_lat, classroom_long, geo_radius_m, fee_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, b.name, b.subject || null, b.class_level, b.tutor_id || null,
    b.schedule_days || null, b.schedule_time || null,
    b.classroom_lat ?? null, b.classroom_long ?? null, b.geo_radius_m ?? 100, b.fee_amount ?? null
  ).run();

  return ok(c, { id }, 201);
});

admin.post("/batch/update", async (c) => {
  const b = await c.req.json<{
    id: string; name?: string; subject?: string; class_level?: string; tutor_id?: string;
    schedule_days?: string; schedule_time?: string;
    classroom_lat?: number; classroom_long?: number; geo_radius_m?: number; active?: boolean;
    fee_amount?: number | null;
  }>();
  if (!b.id) return fail(c, "id is required", 400);
  if (b.fee_amount !== undefined && b.fee_amount !== null && (typeof b.fee_amount !== "number" || b.fee_amount < 0)) {
    return fail(c, "fee_amount must be a non-negative number", 400);
  }

  await c.env.DB.prepare(
    `UPDATE batches SET
       name = COALESCE(?, name), subject = COALESCE(?, subject), class_level = COALESCE(?, class_level),
       tutor_id = COALESCE(?, tutor_id), schedule_days = COALESCE(?, schedule_days),
       schedule_time = COALESCE(?, schedule_time), classroom_lat = COALESCE(?, classroom_lat),
       classroom_long = COALESCE(?, classroom_long), geo_radius_m = COALESCE(?, geo_radius_m),
       active = COALESCE(?, active),
       fee_amount = CASE WHEN ? = 1 THEN ? ELSE fee_amount END
     WHERE id = ?`
  ).bind(
    b.name ?? null, b.subject ?? null, b.class_level ?? null, b.tutor_id ?? null,
    b.schedule_days ?? null, b.schedule_time ?? null, b.classroom_lat ?? null,
    b.classroom_long ?? null, b.geo_radius_m ?? null,
    b.active === undefined ? null : (b.active ? 1 : 0),
    b.fee_amount !== undefined ? 1 : 0, b.fee_amount ?? null,
    b.id
  ).run();

  return ok(c, { id: b.id });
});

admin.post("/batch/delete", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!id) return fail(c, "id is required", 400);
  await c.env.DB.prepare("DELETE FROM batches WHERE id = ?").bind(id).run();
  return ok(c, { id });
});

// ---------------------------------------------------------------------------
// Tutors
// ---------------------------------------------------------------------------
admin.get("/tutors", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, phone, can_upload_marks, active, created_at FROM tutors ORDER BY created_at DESC"
  ).all();
  return ok(c, results);
});

admin.post("/tutor/create", async (c) => {
  const b = await c.req.json<{ name: string; phone: string; password: string }>();
  if (!b.name || !b.phone || !b.password) return fail(c, "name, phone and password are required", 400);

  const id = newId("tutor");
  const passwordHash = await hashPassword(b.password);
  try {
    await c.env.DB.prepare("INSERT INTO tutors (id, name, phone, password_hash) VALUES (?, ?, ?, ?)")
      .bind(id, b.name, b.phone, passwordHash).run();
  } catch {
    return fail(c, "A tutor with this phone number already exists", 409);
  }
  return ok(c, { id }, 201);
});

admin.post("/tutor/update", async (c) => {
  const b = await c.req.json<{
    id: string; name?: string; phone?: string; password?: string;
    can_upload_marks?: boolean; active?: boolean;
  }>();
  if (!b.id) return fail(c, "id is required", 400);

  const passwordHash = b.password ? await hashPassword(b.password) : null;

  await c.env.DB.prepare(
    `UPDATE tutors SET
       name = COALESCE(?, name), phone = COALESCE(?, phone),
       password_hash = COALESCE(?, password_hash),
       can_upload_marks = COALESCE(?, can_upload_marks), active = COALESCE(?, active)
     WHERE id = ?`
  ).bind(
    b.name ?? null, b.phone ?? null, passwordHash,
    b.can_upload_marks === undefined ? null : (b.can_upload_marks ? 1 : 0),
    b.active === undefined ? null : (b.active ? 1 : 0),
    b.id
  ).run();

  return ok(c, { id: b.id });
});

admin.post("/tutor/delete", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!id) return fail(c, "id is required", 400);
  await c.env.DB.prepare("DELETE FROM tutors WHERE id = ?").bind(id).run();
  return ok(c, { id });
});

// ---------------------------------------------------------------------------
// Exam Templates (online exam question banks) — created once, then scheduled
// for any number of batches via /admin/exam/create with a template_id.
// ---------------------------------------------------------------------------
admin.post("/exam-template/create", async (c) => {
  const { name, subject } = await c.req.json<{ name: string; subject?: string }>();
  if (!name) return fail(c, "name is required", 400);

  const id = newId("tmpl");
  await c.env.DB.prepare("INSERT INTO exam_templates (id, name, subject) VALUES (?, ?, ?)")
    .bind(id, name, subject || null).run();
  return ok(c, { id }, 201);
});

admin.get("/exam-templates", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.subject, t.created_at,
       (SELECT COUNT(*) FROM exam_questions q WHERE q.template_id = t.id) as question_count,
       (SELECT COALESCE(SUM(marks), 0) FROM exam_questions q WHERE q.template_id = t.id) as total_marks,
       (SELECT COUNT(*) FROM exams e WHERE e.template_id = t.id) as scheduled_count
     FROM exam_templates t ORDER BY t.created_at DESC`
  ).all();
  return ok(c, results);
});

admin.get("/exam-template/:id", async (c) => {
  const id = c.req.param("id");
  const template = await c.env.DB.prepare("SELECT * FROM exam_templates WHERE id = ?").bind(id).first();
  if (!template) return fail(c, "Template not found", 404);

  const { results: questions } = await c.env.DB.prepare(
    "SELECT * FROM exam_questions WHERE template_id = ? ORDER BY order_index, id"
  ).bind(id).all();

  return ok(c, { template, questions });
});

// Bulk-replaces every question in a template (same "edit the whole list, save
// once" pattern as marks upload) — simplest way to build/edit a question bank.
admin.post("/exam-template/:id/questions", async (c) => {
  const templateId = c.req.param("id");
  const template = await c.env.DB.prepare("SELECT id FROM exam_templates WHERE id = ?").bind(templateId).first();
  if (!template) return fail(c, "Template not found", 404);

  const { questions } = await c.req.json<{
    questions: {
      question_text: string;
      question_type?: "single" | "multi";
      option_a: string; option_b: string; option_c?: string; option_d?: string;
      correct_options: string[];
      marks?: number;
    }[];
  }>();
  if (!Array.isArray(questions) || questions.length === 0) {
    return fail(c, "At least one question is required", 400);
  }
  for (const q of questions) {
    if (!q.question_text || !q.option_a || !q.option_b || !q.correct_options?.length) {
      return fail(c, "Each question needs question_text, option_a, option_b and at least one correct option", 400);
    }
    if ((q.question_type || "single") === "single" && q.correct_options.length !== 1) {
      return fail(c, `"${q.question_text}" is a single-answer question but has ${q.correct_options.length} correct options marked`, 400);
    }
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM exam_questions WHERE template_id = ?").bind(templateId),
    ...questions.map((q, i) =>
      c.env.DB.prepare(
        `INSERT INTO exam_questions
           (id, template_id, question_text, question_type, option_a, option_b, option_c, option_d, correct_options, marks, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        newId("q"), templateId, q.question_text, q.question_type || "single",
        q.option_a, q.option_b, q.option_c || null, q.option_d || null,
        q.correct_options.join(","), q.marks || 1, i
      )
    ),
  ]);

  return ok(c, { template_id: templateId, count: questions.length });
});

// ---------------------------------------------------------------------------
// Exams & Marks
// ---------------------------------------------------------------------------
admin.post("/exam/create", async (c) => {
  const b = await c.req.json<{
    batch_id: string; exam_name: string; exam_date: string; total_marks?: number;
    exam_type?: "classroom" | "online";
    template_id?: string; starts_at?: string; ends_at?: string; duration_minutes?: number;
  }>();
  if (!b.batch_id || !b.exam_name || !b.exam_date) {
    return fail(c, "batch_id, exam_name and exam_date are required", 400);
  }

  const examType = b.exam_type === "online" ? "online" : "classroom";
  let totalMarks = b.total_marks;

  if (examType === "online") {
    if (!b.template_id) return fail(c, "template_id is required for an online exam", 400);
    if (!b.starts_at || !b.ends_at || !b.duration_minutes) {
      return fail(c, "starts_at, ends_at and duration_minutes are required for an online exam", 400);
    }
    const template = await c.env.DB.prepare("SELECT id FROM exam_templates WHERE id = ?").bind(b.template_id).first();
    if (!template) return fail(c, "Template not found", 404);
    if (!totalMarks) {
      const sum = await c.env.DB.prepare("SELECT COALESCE(SUM(marks), 0) as total FROM exam_questions WHERE template_id = ?")
        .bind(b.template_id).first<{ total: number }>();
      totalMarks = sum?.total || 0;
      if (!totalMarks) return fail(c, "This template has no questions yet — add questions before scheduling it", 400);
    }
  } else if (!totalMarks) {
    return fail(c, "total_marks is required for a classroom exam", 400);
  }

  const id = newId("exam");
  let examCode = randomExamCode();
  // Guarantee uniqueness even in the astronomically unlikely case of a collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await c.env.DB.prepare("SELECT id FROM exams WHERE exam_code = ?").bind(examCode).first();
    if (!existing) break;
    examCode = randomExamCode();
  }

  await c.env.DB.prepare(
    `INSERT INTO exams (id, batch_id, exam_name, exam_date, total_marks, exam_code, exam_type, template_id, starts_at, ends_at, duration_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, b.batch_id, b.exam_name, b.exam_date, totalMarks, examCode, examType,
    examType === "online" ? b.template_id : null,
    examType === "online" ? b.starts_at : null,
    examType === "online" ? b.ends_at : null,
    examType === "online" ? b.duration_minutes : null
  ).run();

  return ok(c, { id, exam_code: examCode }, 201);
});

// Batch and exam_type are fixed at creation (per the "master template,
// scheduled per batch" model) — schedule a new exam instead if either needs
// to change. Everything else (name, date/window, marks) can be edited here.
admin.post("/exam/update", async (c) => {
  const b = await c.req.json<{
    id: string;
    exam_name?: string;
    exam_date?: string;
    total_marks?: number; // classroom only — online always recomputes from its template
    starts_at?: string;
    ends_at?: string;
    duration_minutes?: number;
  }>();
  if (!b.id) return fail(c, "id is required", 400);

  const exam = await c.env.DB.prepare("SELECT id, exam_type, template_id FROM exams WHERE id = ?")
    .bind(b.id).first<{ id: string; exam_type: string; template_id: string | null }>();
  if (!exam) return fail(c, "Exam not found", 404);

  let totalMarks: number | null | undefined = b.total_marks;
  if (exam.exam_type === "online" && exam.template_id) {
    const sum = await c.env.DB.prepare("SELECT COALESCE(SUM(marks), 0) as total FROM exam_questions WHERE template_id = ?")
      .bind(exam.template_id).first<{ total: number }>();
    totalMarks = sum?.total ?? 0;
  }

  await c.env.DB.prepare(
    `UPDATE exams SET
       exam_name = COALESCE(?, exam_name),
       exam_date = COALESCE(?, exam_date),
       total_marks = COALESCE(?, total_marks),
       starts_at = COALESCE(?, starts_at),
       ends_at = COALESCE(?, ends_at),
       duration_minutes = COALESCE(?, duration_minutes)
     WHERE id = ?`
  ).bind(
    b.exam_name ?? null, b.exam_date ?? null, totalMarks ?? null,
    b.starts_at ?? null, b.ends_at ?? null, b.duration_minutes ?? null,
    b.id
  ).run();

  return ok(c, { id: b.id });
});

admin.post("/exam/delete", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  if (!id) return fail(c, "id is required", 400);
  await c.env.DB.prepare("DELETE FROM exams WHERE id = ?").bind(id).run();
  return ok(c, { id });
});

admin.get("/exams", async (c) => {
  const batchId = c.req.query("batch_id");
  const query = batchId
    ? c.env.DB.prepare("SELECT * FROM exams WHERE batch_id = ? ORDER BY exam_date DESC").bind(batchId)
    : c.env.DB.prepare("SELECT * FROM exams ORDER BY exam_date DESC");
  const { results } = await query.all();
  return ok(c, results);
});

admin.post("/exam/upload-marks", async (c) => {
  const b = await c.req.json<{
    exam_id: string;
    marks: { student_id: string; marks_obtained: number; remarks?: string }[];
  }>();
  if (!b.exam_id || !Array.isArray(b.marks)) return fail(c, "exam_id and marks[] are required", 400);

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

admin.get("/exam/:exam_code", async (c) => {
  const code = c.req.param("exam_code").toUpperCase();
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE exam_code = ?").bind(code).first();
  if (!exam) return fail(c, "Exam not found", 404);

  const { results: marks } = await c.env.DB.prepare(
    `SELECT em.student_id, s.name as student_name, em.marks_obtained, em.remarks
     FROM exam_marks em JOIN students s ON s.id = em.student_id
     WHERE em.exam_id = ? ORDER BY em.marks_obtained DESC`
  ).bind((exam as { id: string }).id).all();

  return ok(c, { exam, marks });
});

// ---------------------------------------------------------------------------
// Attendance reports & CSV export
// ---------------------------------------------------------------------------
admin.get("/attendance/report", async (c) => {
  const batchId = c.req.query("batch_id");
  const from = c.req.query("from");
  const to = c.req.query("to");

  let query = `
    SELECT a.id, a.student_id, s.name as student_name, a.batch_id, b.name as batch_name,
           a.date, a.status, a.timestamp, a.distance_m, a.source
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    JOIN batches b ON b.id = a.batch_id
    WHERE 1=1`;
  const binds: unknown[] = [];
  if (batchId) { query += " AND a.batch_id = ?"; binds.push(batchId); }
  if (from) { query += " AND a.date >= ?"; binds.push(from); }
  if (to) { query += " AND a.date <= ?"; binds.push(to); }
  query += " ORDER BY a.date DESC, a.timestamp DESC";

  const { results } = await c.env.DB.prepare(query).bind(...binds).all();
  return ok(c, results);
});

admin.get("/attendance/export.csv", async (c) => {
  const batchId = c.req.query("batch_id");
  let query = `
    SELECT a.date, b.name as batch_name, s.name as student_name, s.phone, a.status, a.timestamp, a.source
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    JOIN batches b ON b.id = a.batch_id
    WHERE 1=1`;
  const binds: unknown[] = [];
  if (batchId) { query += " AND a.batch_id = ?"; binds.push(batchId); }
  query += " ORDER BY a.date DESC";

  const { results } = await c.env.DB.prepare(query).bind(...binds).all();

  const header = "Date,Batch,Student,Phone,Status,Timestamp,Source";
  const escapeCsv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = (results as Record<string, unknown>[]).map((r) =>
    [r.date, r.batch_name, r.student_name, r.phone, r.status, r.timestamp, r.source].map(escapeCsv).join(",")
  );
  const csv = [header, ...rows].join("\n");

  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="attendance_export.csv"`,
  });
});

// ---------------------------------------------------------------------------
// Analytics: batch strength, attendance %, top absentees
// ---------------------------------------------------------------------------
admin.get("/analytics/overview", async (c) => {
  const { results: batchStrength } = await c.env.DB.prepare(
    `SELECT b.id as batch_id, b.name as batch_name, COUNT(bs.student_id) as strength
     FROM batches b LEFT JOIN batch_students bs ON bs.batch_id = b.id
     GROUP BY b.id ORDER BY b.name`
  ).all();

  const { results: attendancePct } = await c.env.DB.prepare(
    `SELECT b.id as batch_id, b.name as batch_name,
       COUNT(DISTINCT a.date) as sessions_held,
       ROUND(100.0 * COUNT(CASE WHEN a.status = 'present' THEN 1 END) /
         NULLIF(COUNT(DISTINCT a.date) * (SELECT COUNT(*) FROM batch_students bs2 WHERE bs2.batch_id = b.id), 0), 1) as attendance_pct
     FROM batches b LEFT JOIN attendance a ON a.batch_id = b.id
     GROUP BY b.id ORDER BY b.name`
  ).all();

  const { results: topAbsentees } = await c.env.DB.prepare(
    `SELECT s.id as student_id, s.name as student_name, b.name as batch_name,
       (SELECT COUNT(DISTINCT a2.date) FROM attendance a2 WHERE a2.batch_id = bs.batch_id) as sessions_held,
       COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present_count
     FROM batch_students bs
     JOIN students s ON s.id = bs.student_id
     JOIN batches b ON b.id = bs.batch_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.batch_id = bs.batch_id
     GROUP BY s.id, bs.batch_id
     HAVING sessions_held > 0
     ORDER BY (1.0 * present_count / sessions_held) ASC
     LIMIT 20`
  ).all();

  return ok(c, { batchStrength, attendancePct, topAbsentees });
});

// ---------------------------------------------------------------------------
// General settings: tuition name + brand color shown across every portal.
// ---------------------------------------------------------------------------
admin.post("/settings/update", async (c) => {
  const { tuition_name, brand_color } = await c.req.json<{ tuition_name?: string; brand_color?: string }>();

  if (tuition_name !== undefined && !tuition_name.trim()) {
    return fail(c, "Tuition name can't be empty", 400);
  }
  if (brand_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(brand_color)) {
    return fail(c, "Brand color must be a hex color like #3654e0", 400);
  }

  const updates: [string, string][] = [];
  if (tuition_name !== undefined) updates.push(["tuition_name", tuition_name.trim()]);
  if (brand_color !== undefined) updates.push(["brand_color", brand_color]);

  for (const [key, value] of updates) {
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value).run();
  }

  return ok(c, { updated: updates.map(([key]) => key) });
});

// Read-only for the tuition's own admin — only a vendor (see routes/vendor.ts)
// can set these, so the admin can see the reminder but not edit it away.
admin.get("/settings/renewal", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('renewal_date', 'renewal_amount', 'renewal_contact')").all<{ key: string; value: string }>();
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return ok(c, {
    renewal_date: map.renewal_date || null,
    renewal_amount: map.renewal_amount ? Number(map.renewal_amount) : null,
    renewal_contact: map.renewal_contact || null,
  });
});

admin.post("/settings/logo", async (c) => {
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  if (!contentType.startsWith("image/")) return fail(c, "Only image uploads are allowed", 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return fail(c, "Empty file", 400);
  if (body.byteLength > 2 * 1024 * 1024) return fail(c, "Logo too large (max 2MB)", 400);

  await c.env.PHOTOS_BUCKET.put(LOGO_R2_KEY, body, { httpMetadata: { contentType } });
  const updatedAt = new Date().toISOString();
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('logo_updated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(updatedAt).run();

  return ok(c, { logo_url: `/public/logo?v=${encodeURIComponent(updatedAt)}` });
});

admin.post("/settings/logo/remove", async (c) => {
  await c.env.PHOTOS_BUCKET.delete(LOGO_R2_KEY);
  await c.env.DB.prepare("DELETE FROM settings WHERE key = 'logo_updated_at'").run();
  return ok(c, { removed: true });
});

export default admin;
