import { DemoSessionResponseSchema, type DemoSessionResponse } from "@seatrush/shared";

/** sessionStorage key: one demo identity per browser tab, gone when the tab closes. */
export const DEMO_SESSION_KEY = "seatrush.demo-session";

/** Sessions this close to expiry are replaced rather than reused mid-checkout. */
const EXPIRY_MARGIN_MS = 60_000;

export type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Stand-in for sessionStorage where the browser blocks it: lasts while this page's scripts do. */
const pageMemory: SessionStore = (() => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
})();

let tabStore: SessionStore | undefined;

/**
 * The tab's sessionStorage, or, where the browser blocks or fills it (reading the property itself
 * can throw a SecurityError), an in-memory store shared by every page this tab navigates to
 * without a reload. Either way the identity is issued once and the ticket page can reuse it.
 */
export function browserSessionStore(): SessionStore {
  if (tabStore) return tabStore;
  try {
    const storage = window.sessionStorage;
    storage.setItem("seatrush.probe", "1");
    storage.removeItem("seatrush.probe");
    tabStore = storage;
  } catch {
    tabStore = pageMemory;
  }
  return tabStore;
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

/** Forgets the identity and the payment it was following, which a new identity could not see. */
export function clearDemoSession(store: SessionStore | null): void {
  try {
    store?.removeItem(DEMO_SESSION_KEY);
    store?.removeItem(TRACKED_PAYMENT_KEY);
  } catch {
    // A store that cannot be written cannot hold a stale session either.
  }
}

/** sessionStorage key for the payment this tab follows, so a reload or lost answer still finds it. */
export const TRACKED_PAYMENT_KEY = "seatrush.payment";

/**
 * The payment this tab follows. Saved with `attemptId: null` before the start request is sent, so a
 * lost answer can still be recovered from the hold's latest attempt.
 */
export interface TrackedPaymentRef {
  holdId: string;
  attemptId: string | null;
}

export function loadTrackedPayment(store: SessionStore | null): TrackedPaymentRef | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(TRACKED_PAYMENT_KEY) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "holdId" in value &&
      typeof value.holdId === "string" &&
      "attemptId" in value &&
      (typeof value.attemptId === "string" || value.attemptId === null)
    ) {
      return { holdId: value.holdId, attemptId: value.attemptId };
    }
  } catch {
    // Unreadable or malformed: nothing to follow.
  }
  return null;
}

/** Best effort, like the session itself; `null` forgets the payment. */
export function saveTrackedPayment(store: SessionStore | null, ref: TrackedPaymentRef | null): void {
  try {
    if (ref === null) store?.removeItem(TRACKED_PAYMENT_KEY);
    else store?.setItem(TRACKED_PAYMENT_KEY, JSON.stringify(ref));
  } catch {
    // The page still follows the payment in memory.
  }
}
