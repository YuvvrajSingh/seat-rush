import type { DemoSessionResponse } from "@seatrush/shared";
import { describe, expect, it } from "vitest";
import { DEMO_SESSION_KEY, clearDemoSession, loadDemoSession, saveDemoSession } from "../src/lib/demo-session.js";

/** In-memory stand-in for sessionStorage. */
function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const session: DemoSessionResponse = {
  token: "header.payload.signature",
  expiresAt: "2026-11-07T11:00:00.000Z",
  customer: { id: "62cb9f54-dd26-49f1-b573-018e86fa2e07", displayName: "Demo Customer 842" },
};
const now = Date.parse("2026-11-07T10:00:00.000Z");

describe("demo session storage", () => {
  it("round-trips a session", () => {
    const store = memoryStore();
    saveDemoSession(store, session);
    expect(loadDemoSession(store, now)).toEqual(session);
  });

  it("is empty when nothing was stored", () => {
    expect(loadDemoSession(memoryStore(), now)).toBeNull();
  });

  it("discards a session within a minute of expiry so a checkout never starts on a dying token", () => {
    const store = memoryStore();
    saveDemoSession(store, session);
    expect(loadDemoSession(store, Date.parse("2026-11-07T10:59:30.000Z"))).toBeNull();
    expect(store.items.has(DEMO_SESSION_KEY)).toBe(false);
  });

  it.each(["not json", JSON.stringify({ token: "x" }), "null"])("discards a malformed entry %s", (raw) => {
    const store = memoryStore();
    store.setItem(DEMO_SESSION_KEY, raw);
    expect(loadDemoSession(store, now)).toBeNull();
    expect(store.items.has(DEMO_SESSION_KEY)).toBe(false);
  });

  it("treats a store that throws on every call as empty and never throws itself", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(() => saveDemoSession(blocked, session)).not.toThrow();
    expect(loadDemoSession(blocked, now)).toBeNull();
    expect(() => clearDemoSession(blocked)).not.toThrow();
  });

  it("works without any store", () => {
    expect(() => saveDemoSession(null, session)).not.toThrow();
    expect(loadDemoSession(null, now)).toBeNull();
  });
});
