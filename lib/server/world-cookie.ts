import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_VERSION = "v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizedWorldId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function signature(worldId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${COOKIE_VERSION}.${worldId}`, "utf8")
    .digest();
}

/** Sign a validated world UUID for storage in the HttpOnly session cookie. */
export function signWorldCookie(worldId: string, secret: string): string {
  const normalized = normalizedWorldId(worldId);
  if (!normalized) throw new Error("Refusing to sign an invalid world id.");

  return `${COOKIE_VERSION}.${normalized}.${signature(normalized, secret).toString("base64url")}`;
}

/**
 * Verify and recover a world UUID. Any legacy unsigned value, malformed UUID,
 * wrong version or bad MAC is simply unusable, so callers can migrate it by
 * issuing a fresh fork without exposing why validation failed.
 */
export function verifyWorldCookie(value: unknown, secret: string): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;

  const worldId = normalizedWorldId(parts[1]);
  if (!worldId || worldId !== parts[1] || !MAC_PATTERN.test(parts[2])) return null;

  let received: Buffer;
  try {
    received = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }

  const expected = signature(worldId, secret);
  if (received.length !== expected.length) return null;
  return timingSafeEqual(received, expected) ? worldId : null;
}
