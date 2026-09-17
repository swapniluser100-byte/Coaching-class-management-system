export type Env = {
  DB: D1Database;
  PHOTOS_BUCKET: R2Bucket;
  RATE_LIMIT_KV: KVNamespace;

  JWT_SECRET: string;
  QR_HMAC_SECRET: string;
  ADMIN_BOOTSTRAP_KEY: string;

  ENVIRONMENT: string;
  ATTENDANCE_WINDOW_MINUTES: string;
  QR_ROTATE_SECONDS: string;
  GEO_RADIUS_METERS: string;
};

export type JwtRole = "admin" | "tutor" | "student";

export type AppJwtPayload = {
  sub: string;
  role: JwtRole;
  name?: string;
  exp: number;
  iat: number;
};

export type Variables = {
  jwtPayload: AppJwtPayload;
};
