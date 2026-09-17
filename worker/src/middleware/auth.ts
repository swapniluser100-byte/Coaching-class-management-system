import type { Context, Next } from "hono";
import type { Env, JwtRole, Variables } from "../types";
import { verifyJwt } from "../lib/jwt";
import { fail } from "../lib/response";

export function requireAuth(...allowedRoles: JwtRole[]) {
  return async (c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) => {
    const header = c.req.header("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return fail(c, "Missing bearer token", 401);

    const payload = await verifyJwt(c.env.JWT_SECRET, token);
    if (!payload) return fail(c, "Invalid or expired token", 401);

    if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
      return fail(c, "Insufficient permissions", 403);
    }

    c.set("jwtPayload", payload);
    await next();
  };
}
