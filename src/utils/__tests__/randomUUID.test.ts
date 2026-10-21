import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "../randomUUID";
import { getRNG, resetRNG, setRNG } from "../random";

afterEach(() => {
  vi.unstubAllGlobals();
  resetRNG();
});

describe("randomUUID", () => {
  it("uses the native method when available", () => {
    const native = vi.fn(() => "12345678-1234-4123-8123-123456789abc");
    vi.stubGlobal("crypto", { randomUUID: native });
    expect(randomUUID()).toBe("12345678-1234-4123-8123-123456789abc");
    expect(native).toHaveBeenCalledOnce();
  });

  it.each([0, 255])("creates a v4 UUID without randomUUID on HTTP (bytes %i)", (value) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(value));
    vi.stubGlobal("crypto", { getRandomValues });
    const next = vi.fn(() => 0.5);
    const rng = { next };
    setRNG(rng);

    const id = randomUUID();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toBe(value === 0
      ? "00000000-0000-4000-8000-000000000000"
      : "ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRNG()).toBe(rng);
    expect(next).not.toHaveBeenCalled();
  });
});
