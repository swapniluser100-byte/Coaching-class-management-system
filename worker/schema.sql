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
-- exams
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exams (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  exam_name    TEXT NOT NULL,
  exam_date    TEXT NOT NULL,
  total_marks  INTEGER NOT NULL,
  exam_code    TEXT UNIQUE NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
