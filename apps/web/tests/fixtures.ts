import {
  ALL_SEAT_LABELS,
  SEAT_PRICE_PAISE,
  type Hold,
  type ScreeningSnapshot,
  type SeatSnapshot,
} from "@seatrush/shared";

export const SCREENING_ID = "b2c27e48-b27a-4261-951d-e669f565d225";

/** Deterministic uuid per seat label: row letter as its char code, then the seat number. B7 → …-000000004207. */
export function seatId(label: string): string {
  const code = label.charCodeAt(0).toString(16);
  return `00000000-0000-4000-8000-${`${code}${label.slice(1).padStart(2, "0")}`.padStart(12, "0")}`;
}

type SeatOverride = Partial<Pick<SeatSnapshot, "state" | "heldByYou" | "hold">>;

/** Any held seat carries its hold reference (contract: non-null for every held seat). */
const SOME_HOLD = { id: "33333333-3333-4333-8333-333333333333", expiresAt: "2026-11-07T10:05:00.000Z" };

export function makeSnapshot({
  seats = {},
  yourHold = null,
  lastEventId = "1",
  serverTime = "2026-11-07T10:00:00.000Z",
}: {
  seats?: Record<string, SeatOverride>;
  yourHold?: Hold | null;
  lastEventId?: string;
  serverTime?: string;
} = {}): ScreeningSnapshot {
  const list: SeatSnapshot[] = ALL_SEAT_LABELS.map((label) => ({
    id: seatId(label),
    label,
    row: label.slice(0, 1),
    number: Number(label.slice(1)),
    state: "available",
    heldByYou: false,
    hold: seats[label]?.state === "held" ? SOME_HOLD : null,
    ...seats[label],
  }));
  const count = (state: SeatSnapshot["state"]) => list.filter((seat) => seat.state === state).length;
  return {
    screening: {
      id: SCREENING_ID,
      title: "SeatRush: Opening Night",
      startsAt: "2026-11-08T14:30:00.000Z",
      durationMinutes: 180,
      seatPricePaise: SEAT_PRICE_PAISE,
    },
    seats: list,
    counts: { available: count("available"), held: count("held"), confirmed: count("confirmed") },
    yourHold,
    lastEventId,
    serverTime,
  };
}

export function makeHold(labels: readonly string[], overrides: Partial<Hold> = {}): Hold {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    screeningId: SCREENING_ID,
    status: "active",
    seats: labels.map((label) => ({ id: seatId(label), label })),
    amountPaise: SEAT_PRICE_PAISE * labels.length,
    createdAt: "2026-11-07T10:00:00.000Z",
    expiresAt: "2026-11-07T10:05:00.000Z",
    ...overrides,
  };
}
