import { DemoSessionResponseSchema, type DemoSessionResponse } from "@seatrush/shared";

/** sessionStorage key: one demo identity per browser tab, gone when the tab closes. */
export const DEMO_SESSION_KEY = "seatrush.demo-session";

/** Sessions this close to expiry are replaced rather than reused mid-checkout. */
const EXPIRY_MARGIN_MS = 60_000;

export type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The tab's sessionStorage, or null where the browser blocks it (reading the property itself can
 * throw a SecurityError). Without storage the session lives in memory for the page's lifetime.
 */
export function browserSessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Returns the stored demo session if it is well-formed and not about to expire. Storage errors
 * read as "nothing stored": persistence is a convenience, never a reason to stop booking.
 */
export function loadDemoSession(store: SessionStore | null, nowMs: number): DemoSessionResponse | null {
  let raw: string | null;
  try {
    raw = store?.getItem(DEMO_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = DemoSessionResponseSchema.safeParse(value);
  if (!parsed.success || Date.parse(parsed.data.expiresAt) - EXPIRY_MARGIN_MS <= nowMs) {
    clearDemoSession(store);
    return null;
  }
  return parsed.data;
}

/** Best effort: a full or blocked store keeps the session in memory only (the caller holds it). */
export function saveDemoSession(store: SessionStore | null, session: DemoSessionResponse): void {
  try {
    store?.setItem(DEMO_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Nothing to do: the caller still has the session.
  }
}

export function clearDemoSession(store: SessionStore | null): void {
  try {
    store?.removeItem(DEMO_SESSION_KEY);
  } catch {
    // A store that cannot be written cannot hold a stale session either.
  }
}
