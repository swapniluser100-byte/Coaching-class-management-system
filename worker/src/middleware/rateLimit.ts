import type { Context, Next } from "hono";
import type { Env } from "../types";
import { fail } from "../lib/response";

/**
 * Fixed-window rate limiter backed by Workers KV.
 * Keys expire automatically via KV's `expirationTtl`.
 */
export function rateLimit(opts: { keyPrefix: string; limit: number; windowSeconds: number }) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const identity =
      c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
    const windowBucket = Math.floor(Date.now() / (opts.windowSeconds * 1000));
    const key = `rl:${opts.keyPrefix}:${identity}:${windowBucket}`;

    const current = await c.env.RATE_LIMIT_KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= opts.limit) {
      return fail(c, "Too many requests, please slow down", 429);
    }

    await c.env.RATE_LIMIT_KV.put(key, String(count + 1), {
      expirationTtl: opts.windowSeconds + 5,
    });

    await next();
  };
}
