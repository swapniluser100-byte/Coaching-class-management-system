# Tuition Management System (Cloudflare Stack)

A complete attendance + exam management system for 11th/12th/CET coaching
batches, built entirely on Cloudflare's edge platform:

- **Cloudflare Workers** — API backend (Hono framework)
- **Cloudflare D1** — relational database (SQLite at the edge)
- **Cloudflare R2** — student photo storage
- **Cloudflare KV** — rate limiting + OTP throttling
- **Cloudflare Pages** — static hosting for the Admin / Teacher / Student portals

---

## 1. Architecture

```
worker/                 Cloudflare Worker (API)
  src/
    index.ts            Hono app + route mounting + CORS
    types.ts            Env bindings & shared types
    lib/
      crypto.ts          PBKDF2 password hashing, HMAC, random ids/codes/OTP
      jwt.ts              JWT issue/verify (admin/tutor/student roles)
      qr.ts               Deterministic rotating-QR-token derivation
      geo.ts              Haversine distance for geo-fencing
      response.ts         ok()/fail() JSON helpers
    middleware/
      auth.ts             Role-based JWT guard
      rateLimit.ts        KV-backed fixed-window rate limiter
    routes/
      admin.ts            Admin console API
      tutor.ts            Teacher API
      student.ts          Student API (OTP login, history, exam lookup)
      qr.ts               QR session start/current/stop
      attendance.ts       Attendance marking + live batch roster
      photos.ts           Authenticated R2 photo streaming
  schema.sql             D1 schema
  wrangler.toml

frontend/               Static sites deployed to Cloudflare Pages
  admin/                 Admin console (8 pages)
  teacher/               Teacher dashboard (mobile-friendly)
  student/               Student portal (mobile-friendly)
  shared/                Shared CSS + JS (api client, fingerprint, config)
```

### Why "Cloudflare Access JWT" became app-issued JWTs

The brief mentions Cloudflare Access JWT, but also requires **email+password
admin login** and **phone+password teacher login** — Access is designed to
gate access using an *external* identity provider (Google Workspace, OTP-via-
email, etc.), not to host your own password database. So this build issues
its own signed JWTs (HS256, `hono/jwt`, one secret per environment) for all
three roles, which satisfies "JWT-based session" while keeping full control
over credentials. If you still want an extra layer, put the whole Pages +
Workers app behind **Cloudflare Access** as defense-in-depth — it composes
fine with the app's own JWTs.

---

## 2. Anti-cheating design

| Mechanism | How it works |
|---|---|
| Rotating QR (10s) | `GET /qr/current` derives `token = HMAC(sessionSecret, batchId:windowIndex)` where `windowIndex = floor(now / 10s)`. No DB write needed per rotation. |
| Token invalidation | `/attendance/mark` accepts only the current window and one window of grace (for scan latency) — anything older is rejected. |
| Device fingerprint binding | A SHA-256 hash of canvas/WebGL/screen/timezone signals is computed client-side (`shared/js/fingerprint.js`) and bound to the student on **first OTP login**. Every later login/attendance mark must match, or it's rejected with a clear message (admin can reset it). |
| Geo-fence | Each batch stores a classroom `lat/long/radius_m`. `/attendance/mark` computes Haversine distance and rejects marks beyond the radius (default 100m). |
| Attendance window auto-close | Each session has `ends_at` (default 15 min, configurable via `ATTENDANCE_WINDOW_MINUTES`). Expired sessions are rejected server-side even if the tutor forgot to click "Stop". |
| One mark per day | `UNIQUE(student_id, batch_id, date)` on the `attendance` table — duplicate scans fail at the DB layer. |
| Rate limiting | KV-backed fixed-window limiter on `/attendance/mark`, `/student/otp/request`, and `/student/login`. |

---

## 3. Prerequisites

- Node.js 18+
- A Cloudflare account
- `npm install -g wrangler` (or use `npx wrangler`)
- `wrangler login`

---

## 4. Backend setup (Cloudflare Workers + D1 + R2 + KV)

```bash
cd worker
npm install
```

### 4.1 Create the D1 database

```bash
npx wrangler d1 create tuition-db
```

Copy the returned `database_id` into `worker/wrangler.toml` under
`[[d1_databases]]`.

### 4.2 Create the R2 bucket

```bash
npx wrangler r2 bucket create tuition-student-photos
```

### 4.3 Create the KV namespace (rate limiting / OTP throttling)

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
```

Copy the returned `id` into `worker/wrangler.toml` under `[[kv_namespaces]]`.

### 4.4 Apply the schema

```bash
npm run db:migrate:remote     # production D1
npm run db:migrate:local      # local dev D1 (used by `wrangler dev`)
```

### 4.5 Set secrets

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put QR_HMAC_SECRET
npx wrangler secret put ADMIN_BOOTSTRAP_KEY
```

Use long random values, e.g. `openssl rand -hex 32`.

### 4.6 Run locally / deploy

```bash
npm run dev       # http://127.0.0.1:8787
npm run deploy    # publishes to https://tuition-management-api.<subdomain>.workers.dev
```

> **Local testing tip:** `wrangler dev` reads `worker/.dev.vars` for secrets,
> but a plain var already declared under `wrangler.toml`'s `[vars]` (like
> `ENVIRONMENT`) is **not** overridden by `.dev.vars` in Wrangler 3.x. To see
> the mock OTP echoed back by `/student/otp/request` while testing locally,
> temporarily set `ENVIRONMENT = "development"` in `wrangler.toml` — just
> remember to set it back to `"production"` before deploying.

### 4.7 Create the first admin account

The admin table starts empty on purpose. Bootstrap it once:

```bash
curl -X POST https://<your-worker-url>/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"ChangeMe123!","bootstrap_key":"<ADMIN_BOOTSTRAP_KEY value>"}'
```

(The Admin login page also has a "Create the first admin account" link that
does this from the browser.) This endpoint refuses to run once any admin
already exists.

---

## 5. Frontend setup (Cloudflare Pages)

The frontend is plain HTML/CSS/JS — no build step required.

1. Point it at your Worker: edit `frontend/shared/js/config.js`'s
   `DEFAULT_API_BASE_URL`, **or** just log into any portal and use its
   Settings page (Admin → Settings) to set the API URL per-browser via
   localStorage — handy for testing against `wrangler dev` locally.
2. Deploy the `frontend/` directory as a Cloudflare Pages project:

```bash
cd frontend
npx wrangler pages deploy . --project-name=tuition-management
```

3. In the Worker's `wrangler.toml`, tighten CORS from `origin: "*"` to your
   Pages URL (e.g. `https://tuition-management.pages.dev`) before going live.

### Portal URLs after deploy

- `https://<pages-domain>/` — landing page linking to all three portals
- `https://<pages-domain>/admin/` — Admin console
- `https://<pages-domain>/teacher/` — Teacher dashboard
- `https://<pages-domain>/student/` — Student portal

---

## 6. Using the system end-to-end

1. **Bootstrap admin** (§4.7), log into `/admin/`.
2. **Manage Tutors** → add a tutor (phone + password).
3. **Manage Batches** → create a batch, assign the tutor, set the classroom's
   lat/long (use the "Use my current location" button while standing in the
   classroom) and geo-fence radius.
4. **Manage Students** → add students (phone number is their login).
5. Assign students to the batch from the Students form (or Batches page).
6. **Teacher** logs into `/teacher/`, opens "Attendance / QR" for the batch,
   clicks **Start Attendance Session** — a QR appears and rotates every 10s.
7. **Student** logs into `/student/` with phone + OTP (in non-production
   `ENVIRONMENT`, the OTP is echoed back in the response for easy testing —
   wire up a real SMS gateway before going to production). First login binds
   their device fingerprint.
8. Student opens **Scan QR**, grants camera + location permission, scans the
   teacher's screen — attendance is marked if all anti-cheating checks pass.
9. **Exams**: Admin (or an authorized tutor) creates an exam under **Exam
   Management**, gets a unique `exam_code`, uploads marks under **Marks
   Upload**. Students look up their marks in the **Exam Marks** tab of the
   student portal using that code.

---

## 7. Security notes / production hardening checklist

- [ ] Set real (long, random) values for `JWT_SECRET`, `QR_HMAC_SECRET`,
      `ADMIN_BOOTSTRAP_KEY` — never commit them. `wrangler.toml`'s `[vars]`
      section only holds non-secret config.
- [ ] Restrict CORS `origin` in `worker/src/index.ts` to your real Pages
      domain(s) instead of `*`.
- [ ] Replace the mock OTP (`/student/otp/request`) with a real SMS gateway
      (Twilio, MSG91, etc.) called from the Worker before going live; stop
      returning `mock_otp` in the response once `ENVIRONMENT=production`.
- [ ] Consider layering **Cloudflare Access** in front of `/admin/*` pages
      for an additional network-level gate beyond the app's own JWT login.
- [ ] Rotate `JWT_SECRET` periodically; all existing sessions will need to
      re-authenticate after rotation.
- [ ] Add Cloudflare's platform-level Rate Limiting rules in front of the
      Worker as a second layer beyond the KV-based limiter here.
- [ ] Student photo uploads and R2 reads all require a valid Bearer token —
      don't make the R2 bucket public.

---

## 8. Database schema

See [`worker/schema.sql`](worker/schema.sql) for the full D1 schema,
including two implementation details not spelled out in a typical spec:

- `attendance_sessions` — one row per "tutor starts attendance" event,
  holding a random `session_secret` used to deterministically derive that
  session's rotating QR tokens (so no row needs to be written every 10s).
- `otp_requests` — hashed, expiring, single-use mock OTPs for student login.
