import { describe, expect, it, vi } from "vitest";

import type { Executor } from "../lib/memory/belief";
import { isUsableWorldFork, worldIdFromCookie } from "../lib/server/village";
import { signWorldCookie, verifyWorldCookie } from "../lib/server/world-cookie";

const WORLD = "28491041-354c-493b-a5e4-212e6bd99cf8";
const OTHER_WORLD = "38491041-354c-493b-a5e4-212e6bd99cf8";
const TEMPLATE = "6de26358-78e4-4ac0-bb1a-9d81e3999c4f";
const SECRET = "unit-test-world-cookie-secret-at-least-32-bytes";

describe("signed world cookie", () => {
  it("round-trips a versioned UUID with an HMAC", () => {
    const cookie = signWorldCookie(WORLD, SECRET);

    expect(cookie).toMatch(/^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyWorldCookie(cookie, SECRET)).toBe(WORLD);
  });

  it("rejects a changed world id even when the old MAC is retained", () => {
    const cookie = signWorldCookie(WORLD, SECRET);
    const tampered = cookie.replace(WORLD, OTHER_WORLD);

    expect(verifyWorldCookie(tampered, SECRET)).toBeNull();
  });

  it("rejects a changed, non-canonical or wrong-key MAC", () => {
    const cookie = signWorldCookie(WORLD, SECRET);
    const [version, world, mac] = cookie.split(".");
    const changedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;

    expect(verifyWorldCookie(`${version}.${world}.${changedMac}`, SECRET)).toBeNull();
    expect(verifyWorldCookie(`${cookie}!`, SECRET)).toBeNull();
    expect(verifyWorldCookie(cookie, `${SECRET}-different`)).toBeNull();
  });

  it("treats an old unsigned UUID and malformed input as unusable", () => {
    expect(verifyWorldCookie(WORLD, SECRET)).toBeNull();
    expect(verifyWorldCookie("v1.not-a-uuid.signature", SECRET)).toBeNull();
    expect(verifyWorldCookie(undefined, SECRET)).toBeNull();
    expect(() => signWorldCookie("not-a-uuid", SECRET)).toThrow();
  });
});

describe("world fork validation", () => {
  it("requires a non-template direct child of the active template", async () => {
    const exec = vi.fn(async () => [{ id: WORLD }]) as unknown as Executor;

    await expect(isUsableWorldFork(exec, WORLD, TEMPLATE)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("is_template = false AND forked_from = $2"),
      [WORLD, TEMPLATE],
    );
  });

  it("rejects a signed id that no longer resolves to an eligible fork", async () => {
    const exec = vi.fn(async () => []) as unknown as Executor;
    await expect(isUsableWorldFork(exec, WORLD, TEMPLATE)).resolves.toBe(false);
  });

  it("silently treats a legacy unsigned cookie as a request for a fresh fork", async () => {
    const exec = vi.fn(async () => [{ id: WORLD }]) as unknown as Executor;

    await expect(worldIdFromCookie(exec, WORLD, SECRET, TEMPLATE)).resolves.toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves a signed cookie only after the database fork check", async () => {
    const exec = vi.fn(async () => [{ id: WORLD }]) as unknown as Executor;
    const cookie = signWorldCookie(WORLD, SECRET);

    await expect(worldIdFromCookie(exec, cookie, SECRET, TEMPLATE)).resolves.toBe(WORLD);
    expect(exec).toHaveBeenCalledOnce();
  });
});
