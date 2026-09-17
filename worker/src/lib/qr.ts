import { hmacSha256Hex } from "./crypto";

export type QrTokenPayload = {
  batch_id: string;
  session_id: string;
  token: string;
  window: number;
  expires_at: number; // epoch ms
};

/**
 * Deterministically derives the rotating token for a given time window so we
 * never need to write a DB row on every 10-second rotation. The token is a
 * function of a per-session random secret (unpredictable, unguessable) and
 * the current window index, so it changes every ROTATE_SECONDS and old
 * windows become invalid the moment the window advances.
 */
export async function deriveQrToken(
  qrHmacSecret: string,
  sessionSecret: string,
  batchId: string,
  windowIndex: number
): Promise<string> {
  const message = `${batchId}:${windowIndex}:${sessionSecret}`;
  const full = await hmacSha256Hex(qrHmacSecret, message);
  return full.slice(0, 20);
}

export function currentWindowIndex(rotateSeconds: number, atMs: number = Date.now()): number {
  return Math.floor(atMs / (rotateSeconds * 1000));
}

export function windowEndMs(rotateSeconds: number, windowIndex: number): number {
  return (windowIndex + 1) * rotateSeconds * 1000;
}

/**
 * Validates a scanned token against the current window and one window of
 * grace (to absorb scan/network latency), so tokens are invalidated shortly
 * after they rotate rather than being valid indefinitely.
 */
export async function validateQrToken(
  qrHmacSecret: string,
  sessionSecret: string,
  batchId: string,
  submittedToken: string,
  rotateSeconds: number,
  atMs: number = Date.now()
): Promise<boolean> {
  const current = currentWindowIndex(rotateSeconds, atMs);
  for (const w of [current, current - 1]) {
    const expected = await deriveQrToken(qrHmacSecret, sessionSecret, batchId, w);
    if (expected === submittedToken) return true;
  }
  return false;
}
