import { sign, verify } from "hono/jwt";
import type { AppJwtPayload, JwtRole } from "../types";

const SESSION_TTL_SECONDS: Record<JwtRole, number> = {
  admin: 60 * 60 * 8, // 8 hours
  tutor: 60 * 60 * 12, // 12 hours
  student: 60 * 60 * 24 * 7, // 7 days
};

export async function issueJwt(
  secret: string,
  sub: string,
  role: JwtRole,
  name?: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AppJwtPayload = {
    sub,
    role,
    name,
    iat: now,
    exp: now + SESSION_TTL_SECONDS[role],
  };
  return sign(payload, secret, "HS256");
}

export async function verifyJwt(secret: string, token: string): Promise<AppJwtPayload | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as unknown as AppJwtPayload;
    return payload;
  } catch {
    return null;
  }
}
