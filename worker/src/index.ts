import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./types";

import admin from "./routes/admin";
import tutor from "./routes/tutor";
import student from "./routes/student";
import qr from "./routes/qr";
import attendance from "./routes/attendance";
import photos from "./routes/photos";
import publicRoutes from "./routes/public";
import vendor from "./routes/vendor";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(
  "/*",
  cors({
    origin: "*", // Tighten to your Pages domain(s) in production, e.g. https://tuition.pages.dev
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  })
);

app.get("/", (c) => c.json({ name: "Tuition Management API", status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));

app.route("/admin", admin);
app.route("/tutor", tutor);
app.route("/student", student);
app.route("/qr", qr);
app.route("/attendance", attendance);
app.route("/photos", photos);
app.route("/public", publicRoutes);
app.route("/vendor", vendor);

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ success: false, error: "Internal server error" }, 500);
});

export default app;
