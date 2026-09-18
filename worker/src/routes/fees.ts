import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { ok, fail } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { newId } from "../lib/crypto";

const fees = new Hono<{ Bindings: Env; Variables: Variables }>();

fees.use("/*", requireAuth("tutor", "admin"));

// A tutor may only touch fee data for students in one of their own batches;
// an admin has no such restriction.
async function assertStudentAccess(c: any, studentId: string): Promise<boolean> {
  const jwt = c.get("jwtPayload");
  if (jwt.role === "admin") {
    const student = await c.env.DB.prepare("SELECT 1 FROM students WHERE id = ?").bind(studentId).first();
    return !!student;
  }
  const membership = await c.env.DB.prepare(
    `SELECT 1 FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
     WHERE bs.student_id = ? AND b.tutor_id = ?`
  ).bind(studentId, jwt.sub).first();
  return !!membership;
}

fees.get("/student/:id", async (c) => {
  const studentId = c.req.param("id");
  if (!(await assertStudentAccess(c, studentId))) return fail(c, "Student not found", 404);

  const student = await c.env.DB.prepare(
    "SELECT id, name, phone, class_level, total_fee FROM students WHERE id = ?"
  ).bind(studentId).first<{ id: string; name: string; phone: string; class_level: string | null; total_fee: number | null }>();
  if (!student) return fail(c, "Student not found", 404);

  const { results: payments } = await c.env.DB.prepare(
    "SELECT id, amount, payment_date, mode, notes FROM fee_payments WHERE student_id = ? ORDER BY payment_date DESC, created_at DESC"
  ).bind(studentId).all<{ id: string; amount: number; payment_date: string; mode: string | null; notes: string | null }>();

  const paidFee = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalFee = student.total_fee;

  return ok(c, {
    student: { id: student.id, name: student.name, phone: student.phone, class_level: student.class_level },
    total_fee: totalFee,
    paid_fee: paidFee,
    remaining_fee: totalFee != null ? totalFee - paidFee : null,
    payments,
  });
});

fees.post("/student/:id/total", async (c) => {
  const studentId = c.req.param("id");
  if (!(await assertStudentAccess(c, studentId))) return fail(c, "Student not found", 404);

  const { total_fee } = await c.req.json<{ total_fee: number | null }>();
  if (total_fee !== null && (typeof total_fee !== "number" || total_fee < 0)) {
    return fail(c, "total_fee must be a non-negative number or null", 400);
  }

  await c.env.DB.prepare("UPDATE students SET total_fee = ? WHERE id = ?").bind(total_fee, studentId).run();
  return ok(c, { student_id: studentId, total_fee });
});

fees.post("/student/:id/payments", async (c) => {
  const studentId = c.req.param("id");
  if (!(await assertStudentAccess(c, studentId))) return fail(c, "Student not found", 404);

  const { amount, payment_date, mode, notes } = await c.req.json<{
    amount: number; payment_date: string; mode?: string; notes?: string;
  }>();
  if (typeof amount !== "number" || amount <= 0) return fail(c, "amount must be a positive number", 400);
  if (!payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) return fail(c, "payment_date must be in YYYY-MM-DD format", 400);

  const jwt = c.get("jwtPayload");
  const id = newId("pay");
  await c.env.DB.prepare(
    `INSERT INTO fee_payments (id, student_id, amount, payment_date, mode, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, studentId, amount, payment_date, mode || null, notes || null, jwt.sub).run();

  return ok(c, { id, student_id: studentId, amount, payment_date, mode: mode || null, notes: notes || null }, 201);
});

fees.delete("/payment/:id", async (c) => {
  const paymentId = c.req.param("id");
  const payment = await c.env.DB.prepare("SELECT student_id FROM fee_payments WHERE id = ?")
    .bind(paymentId).first<{ student_id: string }>();
  if (!payment) return fail(c, "Payment not found", 404);
  if (!(await assertStudentAccess(c, payment.student_id))) return fail(c, "Payment not found", 404);

  await c.env.DB.prepare("DELETE FROM fee_payments WHERE id = ?").bind(paymentId).run();
  return ok(c, { id: paymentId });
});

export default fees;
