-- =============================================================================
-- Tuition Management System - Cloudflare D1 Schema
-- Run: wrangler d1 execute tuition-db --file=./schema.sql
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- admins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- tutors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  can_upload_marks INTEGER NOT NULL DEFAULT 1, -- 1 = allowed by admin, 0 = disallowed
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  subject        TEXT,
  class_level    TEXT NOT NULL, -- '11th' | '12th' | 'CET'
  tutor_id       TEXT REFERENCES tutors(id) ON DELETE SET NULL,
  schedule_days  TEXT,          -- e.g. 'Mon,Wed,Fri'
  schedule_time  TEXT,          -- e.g. '17:00-18:30'
  classroom_lat  REAL,          -- registered classroom geo-fence center
  classroom_long REAL,
  geo_radius_m   INTEGER NOT NULL DEFAULT 100,
  fee_amount     REAL,          -- this batch's fee; a student's total fee is the sum across every batch they're in
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  phone               TEXT UNIQUE NOT NULL,
  parent_phone        TEXT,
  class_level         TEXT,
  device_fingerprint  TEXT,       -- bound on first successful OTP login or PIN attendance mark
  photo_url           TEXT,       -- R2 object URL/key
  pin_hash            TEXT,       -- optional 4-digit PIN (admin-set) for login-free attendance marking
  pin_failed_attempts INTEGER NOT NULL DEFAULT 0, -- locks after 5; admin reset required
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- batch_students (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_students (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, student_id)
);

-- ---------------------------------------------------------------------------
-- attendance_sessions
-- One row per "tutor starts attendance" event. The rotating QR token is
-- derived deterministically from (session_secret, batch_id, time-window)
-- so we never need to write a new DB row every 10 seconds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,   -- YYYY-MM-DD
  session_secret TEXT NOT NULL,   -- random per-session pepper for HMAC token derivation
  started_at     TEXT NOT NULL,
  ends_at        TEXT NOT NULL,   -- auto-close time
  stopped_at     TEXT,            -- set when tutor manually stops
  status         TEXT NOT NULL DEFAULT 'active', -- active | closed
  created_by     TEXT NOT NULL REFERENCES tutors(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_batch_date ON attendance_sessions(batch_id, date);

-- Kept for spec compatibility / audit trail of issued tokens (optional writes)
CREATE TABLE IF NOT EXISTS attendance_qr_tokens (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- attendance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  batch_id           TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  session_id         TEXT REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  date               TEXT NOT NULL,     -- YYYY-MM-DD
  status             TEXT NOT NULL DEFAULT 'present', -- present | absent
  timestamp          TEXT NOT NULL DEFAULT (datetime('now')),
  geo_lat            REAL,
  geo_long           REAL,
  distance_m         REAL,
  device_fingerprint TEXT,
  source             TEXT NOT NULL DEFAULT 'self', -- self (QR/PIN) | manual (tutor override)
  UNIQUE (student_id, batch_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_batch_date ON attendance(batch_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);

-- ---------------------------------------------------------------------------
-- exam_templates — the reusable "master" question bank for online exams.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- exam_questions — MCQ bank tied to a template. question_type 'single' means
-- exactly one of correct_options is right (radio buttons); 'multi' means one
-- or more (checkboxes) and the student must select exactly the correct set
-- for the marks (no partial credit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_questions (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES exam_templates(id) ON DELETE CASCADE,
  question_text   TEXT NOT NULL,
  question_type   TEXT NOT NULL DEFAULT 'single', -- single | multi
  option_a        TEXT NOT NULL,
  option_b        TEXT NOT NULL,
  option_c        TEXT,
  option_d        TEXT,
  correct_options TEXT NOT NULL, -- comma-separated option letters, e.g. "A" or "A,C"
  marks           INTEGER NOT NULL DEFAULT 1,
  order_index     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_exam_questions_template ON exam_questions(template_id);

-- ---------------------------------------------------------------------------
-- exams
-- Each row is one scheduled sitting of an exam for one batch (classroom or
-- online). For online exams, template_id points at the reusable question
-- bank above — the same template can be scheduled again for other batches
-- by creating another exams row with the same template_id, without
-- duplicating any questions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exams (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  exam_name         TEXT NOT NULL,
  exam_date         TEXT NOT NULL,
  total_marks       INTEGER NOT NULL,
  exam_code         TEXT UNIQUE NOT NULL,
  exam_type         TEXT NOT NULL DEFAULT 'classroom', -- classroom | online
  template_id       TEXT REFERENCES exam_templates(id) ON DELETE SET NULL, -- online only
  starts_at         TEXT,    -- online only: ISO datetime the exam window opens
  ends_at           TEXT,    -- online only: ISO datetime the exam window closes
  duration_minutes  INTEGER, -- online only: per-student time limit once they start
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- exam_attempts — one student's timed attempt at one scheduled online exam.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_attempts (
  id           TEXT PRIMARY KEY,
  exam_id      TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deadline_at  TEXT NOT NULL, -- min(started_at + duration_minutes, exam.ends_at)
  submitted_at TEXT,
  status       TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | submitted
  score        INTEGER,
  UNIQUE (exam_id, student_id)
);

-- ---------------------------------------------------------------------------
-- exam_answers — a student's answer to one question within one attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_answers (
  id               TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  question_id      TEXT NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  selected_options TEXT, -- comma-separated option letters, NULL = unanswered
  UNIQUE (attempt_id, question_id)
);

-- ---------------------------------------------------------------------------
-- exam_marks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_marks (
  id             TEXT PRIMARY KEY,
  exam_id        TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  marks_obtained INTEGER NOT NULL,
  remarks        TEXT,
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_marks_exam ON exam_marks(exam_id);

-- ---------------------------------------------------------------------------
-- otp_requests - mock OTP store for student login
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_requests (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  otp_hash   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_requests(phone);

-- ---------------------------------------------------------------------------
-- settings - single-row-per-key app configuration (tuition name, brand color)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- vendor_users - the service provider's own login, separate from the
-- tuition's own admin account. Only a vendor can set the renewal reminder
-- (Next Renewal Date / Amount / Contact) shown in the admin console; the
-- tuition's admin can see it but not edit it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- fee_payments — one row per fee payment recorded against a student. Total
-- fee is the sum of fee_amount across every batch the student is in
-- (batches.fee_amount), paid fee is the sum of these rows, and remaining is
-- the difference -- none of the three are stored, only ever derived.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_payments (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,
  payment_date TEXT NOT NULL, -- YYYY-MM-DD
  mode         TEXT,          -- cash | online | cheque | upi | other (free text)
  notes        TEXT,
  recorded_by  TEXT,          -- tutor_id or admin_id who recorded it
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fee_payments_student ON fee_payments(student_id);
