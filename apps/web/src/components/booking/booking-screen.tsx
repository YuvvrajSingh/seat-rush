"use client";

import {
  MAX_SEATS_PER_HOLD,
  SEAT_ROWS,
  SEATS_PER_ROW,
  type Hold,
  type PaymentAttempt,
  type PaymentScenario,
  type ScreeningSnapshot,
} from "@seatrush/shared";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { env } from "../../env.js";
import { panelView, type BookingState, type Notice, type PanelView } from "../../lib/booking-state.js";
import { formatSeatList } from "../../lib/messages.js";
import { formatPaise } from "../../lib/money.js";
import { paymentPhase } from "../../lib/payment.js";
import { buildHall } from "../../lib/seat-map.js";
import { primaryAction } from "../actions.js";
import { Auditorium, LegendItem, SeatLegend } from "../hall.js";
import { Seat } from "../seat.js";
import { HoldCountdown } from "./hold-countdown.js";
import { BookedResult, PayingAfterHold, PaymentStep, RefundResult } from "./payment-panel.js";
import { SeatGrid } from "./seat-grid.js";
import { useBooking } from "./use-booking.js";

const startsAtFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
});
const clockFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" });

const GRID_HELP_ID = "seat-grid-help";

const PANEL_HEADINGS: Record<PanelView["kind"], string> = {
  selection: "Your seats",
  hold: "Held for you",
  "paying-after-hold": "Hold ended",
  booked: "Booked",
  refund: "Not booked",
};

export function BookingScreen() {
  const { state, toggleSeat, holdSeats, releaseHold, refresh, pay, dismissPayment } = useBooking(
    env.NEXT_PUBLIC_API_URL,
  );
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const { snapshot } = state;
  const view = panelView(state);

  const rows = useMemo(() => (snapshot ? buildHall(snapshot.seats) : []), [snapshot]);
  const selection = useMemo(() => new Set(state.selection), [state.selection]);
  const taken = useMemo(() => new Set(state.taken), [state.taken]);

  // Holding, paying, releasing or expiry swaps the panel's contents, unmounting the button that had
  // focus. Put focus on the panel heading as soon as that renders, unless the customer has moved on.
  // The first snapshot only shows what is already true (a hold kept across a reload), so it moves nothing.
  const panelKey = `${view.kind}:${state.hold?.id ?? ""}:${view.kind === "hold" && view.attempt ? paymentPhase(view.attempt).kind : ""}`;
  const loaded = snapshot !== null;
  const shownPanel = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!loaded || shownPanel.current === panelKey) return;
    const first = shownPanel.current === undefined;
    shownPanel.current = panelKey;
    if (first) return;
    if (document.activeElement === null || document.activeElement === document.body) panelHeading.current?.focus();
  }, [panelKey, loaded]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-[90rem] flex-col px-gutter">
      <a
        href="#main"
        className="sr-only rounded-md bg-ink px-4 py-2 font-semibold text-paper focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-10"
      >
        Skip to booking
      </a>
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule py-4">
        <Link href="/" translate="no" className="font-display text-2xl leading-none font-extrabold tracking-tight">
          SeatRush
        </Link>
        <p className="text-sm text-pretty text-ink-muted">
          {state.customerName ? (
            <>
              Booking as <span className="font-semibold text-ink">{state.customerName}</span>
            </>
          ) : state.sessionProblem === "rate_limited" ? (
            "Too many demo sessions from this network in the last minute. Look around; holding opens shortly."
          ) : state.sessionProblem === "unavailable" ? (
            "Could not start a demo session. Look around; this page tries again shortly."
          ) : (
            "Getting a demo session…"
          )}
        </p>
      </header>

      <main
        id="main"
        tabIndex={-1}
        className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-x-[clamp(2rem,4vw,4rem)] gap-y-8 py-8 outline-none lg:grid-cols-[minmax(0,1.25fr)_minmax(20rem,1fr)] lg:grid-rows-[auto_1fr] lg:content-center lg:gap-y-6 lg:py-6"
      >
        <div className="max-w-[36rem] lg:col-start-2 lg:row-start-1 lg:self-end">
          <ScreeningHeading snapshot={snapshot} />
        </div>

        <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:self-center">
          <Auditorium caption={<HallCaption state={state} />}>
            {rows.length > 0 ? (
              <SeatGrid
                rows={rows}
                selection={selection}
                taken={taken}
                onToggle={toggleSeat}
                describedBy={GRID_HELP_ID}
              />
            ) : (
              <EmptyHall connection={state.connection} />
            )}
          </Auditorium>
        </div>

        <section aria-labelledby="booking-panel-heading" className="max-w-[36rem] lg:col-start-2 lg:row-start-2 lg:self-start">
          <h2
            id="booking-panel-heading"
            ref={panelHeading}
            tabIndex={-1}
            className="font-display text-2xl font-bold focus-visible:outline-offset-4"
          >
            {PANEL_HEADINGS[view.kind]}
          </h2>
          {view.kind === "hold" ? (
            <HoldDetails
              key={view.hold.id}
              hold={view.hold}
              attempt={view.attempt}
              clockOffsetMs={state.clockOffsetMs}
              pending={state.pending}
              onPay={pay}
              onRelease={releaseHold}
              onZero={refresh}
            />
          ) : view.kind === "booked" ? (
            <BookedResult payment={view.payment} bookingId={view.bookingId} onDismiss={dismissPayment} />
          ) : view.kind === "refund" ? (
            <RefundResult payment={view.payment} onDismiss={dismissPayment} />
          ) : view.kind === "paying-after-hold" ? (
            <PayingAfterHold attempt={view.attempt} />
          ) : (
            <SelectionDetails state={state} onHold={holdSeats} />
          )}
          <div role="status" aria-live="polite" aria-atomic="true">
            {state.notice ? <NoticeView key={state.notice.id} notice={state.notice} /> : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function ScreeningHeading({ snapshot }: { snapshot: ScreeningSnapshot | null }) {
  const screening = snapshot?.screening;
  return (
    <>
      <h1 className="font-display text-4xl font-extrabold tracking-tight text-balance sm:text-5xl">
        {screening?.title ?? "Book seats"}
      </h1>
      <p className="mt-2 text-ink-muted">
        {screening
          ? `${startsAtFormat.format(new Date(screening.startsAt))}, ${screening.durationMinutes / 60} hours`
          : "Opening the seat map…"}
      </p>
      <p id={GRID_HELP_ID} className="mt-4 max-w-[60ch] text-sm text-pretty text-ink-muted">
        Choose 1 to {MAX_SEATS_PER_HOLD} seats, then hold them. Choosing a seat does not reserve it; only a hold
        does. Arrow keys move between seats, Enter or Space chooses one.
      </p>
    </>
  );
}

function SelectionDetails({ state, onHold }: { state: BookingState; onHold: () => void }) {
  const { snapshot, selection, pending } = state;
  // Hall order (A1, A2 … J10) reads better than the order the seats were chosen in.
  const labels = snapshot
    ? snapshot.seats.filter((seat) => selection.includes(seat.id)).map((seat) => seat.label)
    : [];
  const holding = pending === "hold";
  const unavailable = labels.length === 0 || holding || !snapshot;

  return (
    <>
      <p className="mt-3 font-display text-3xl font-bold tabular-nums">
        {labels.length > 0 ? formatSeatList(labels) : <span className="text-ink-muted">None chosen yet</span>}
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        {labels.length} of {MAX_SEATS_PER_HOLD} seats chosen
      </p>
      {snapshot ? (
        <p className="mt-4 text-sm text-pretty">
          {formatPaise(snapshot.screening.seatPricePaise)} a seat. The box office works out the total when it
          holds your seats.
        </p>
      ) : null}
      <button
        type="button"
        aria-disabled={unavailable || undefined}
        onClick={unavailable ? undefined : onHold}
        className={`${primaryAction} mt-5 w-full sm:w-auto`}
      >
        {holding
          ? "Holding…"
          : labels.length > 0
            ? `Hold ${labels.length} ${labels.length === 1 ? "seat" : "seats"}`
            : "Hold seats"}
      </button>
    </>
  );
}

function HoldDetails({
  hold,
  attempt,
  clockOffsetMs,
  pending,
  onPay,
  onRelease,
  onZero,
}: {
  hold: Hold;
  attempt: PaymentAttempt | null;
  clockOffsetMs: number;
  pending: BookingState["pending"];
  onPay: (scenario: PaymentScenario) => void;
  onRelease: () => void;
  onZero: () => void;
}) {
  const labels = hold.seats.map((seat) => seat.label);
  return (
    <>
      <p className="mt-3 font-display text-3xl font-bold tabular-nums">{formatSeatList(labels)}</p>
      <dl className="mt-4 divide-y divide-rule border-y border-rule">
        <div className="flex items-baseline justify-between gap-4 py-3">
          <dt className="text-sm text-ink-muted">Total</dt>
          <dd className="font-display text-2xl font-bold tabular-nums">{formatPaise(hold.amountPaise)}</dd>
        </div>
        <div className="py-3">
          <HoldCountdown hold={hold} clockOffsetMs={clockOffsetMs} onZero={onZero} />
        </div>
      </dl>
      <PaymentStep
        amountPaise={hold.amountPaise}
        attempt={attempt}
        starting={pending === "pay"}
        releasing={pending === "release"}
        onPay={onPay}
        onRelease={onRelease}
      />
    </>
  );
}

function NoticeView({ notice }: { notice: Notice }) {
  if (notice.kind === "announce") return <p className="sr-only">{notice.text}</p>;
  if (notice.kind === "expired") {
    return (
      <div className="mt-6 flex items-center gap-4">
        <Image
          src="/images/hold-expired.webp"
          alt=""
          width={88}
          height={88}
          className="size-22 shrink-0 rounded-xl border border-hall-edge"
        />
        <p className="text-pretty">{notice.text}</p>
      </div>
    );
  }
  return (
    <p
      className={`mt-6 border-l-2 pl-3 text-pretty ${notice.kind === "problem" ? "border-signal-warn" : "border-signal-ok"}`}
    >
      {notice.text}
    </p>
  );
}

function HallCaption({ state }: { state: BookingState }) {
  const { snapshot, connection } = state;
  return (
    <>
      <SeatLegend>
        <LegendItem
          seat={<Seat state="available" number={7} mark="selected" />}
          label="Chosen by you"
          hint="Not held until you hold it"
        />
      </SeatLegend>
      {snapshot ? (
        <p className="mt-4 text-xs text-hall-ink-muted">
          {snapshot.counts.available} available, {snapshot.counts.held} held, {snapshot.counts.confirmed} confirmed.
          Seat map as of {clockFormat.format(new Date(snapshot.serverTime))}.
        </p>
      ) : null}
      <div role="status">
        {snapshot && connection !== "ok" ? (
          <p className="mt-1 text-xs font-semibold text-hall-ink">
            {connection === "busy"
              ? "The box office is busy. Showing the last seat map; trying again shortly."
              : connection === "failing"
                ? "The box office answered with an error. Showing the last seat map; trying again every 2 seconds."
                : "Lost contact with the box office. Showing the last seat map; trying again every 2 seconds."}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** Before the first snapshot: the hall's outline only. No seat is drawn with a state it may not have. */
function EmptyHall({ connection }: { connection: BookingState["connection"] }) {
  return (
    <div className="hall-plan relative mt-5 flex flex-col items-center gap-seat-gap sm:mt-6">
      {SEAT_ROWS.map((row) => (
        <div key={row} aria-hidden="true" className="flex items-center gap-(--hall-row-gap)">
          <span className="w-(--hall-letter)" />
          {[0, SEATS_PER_ROW / 2].map((start) => (
            <div
              key={start}
              className={`flex gap-seat-gap ${start > 0 ? "ms-[calc(var(--hall-aisle)+var(--hall-row-gap))]" : ""}`}
            >
              {Array.from({ length: SEATS_PER_ROW / 2 }, (_, index) => (
                <span key={index} className="size-seat rounded-seat border-[1.5px] border-hall-edge" />
              ))}
            </div>
          ))}
          <span className="w-(--hall-letter)" />
        </div>
      ))}
      <div className="absolute inset-0 grid place-items-center p-4">
        <p role="status" className="max-w-[28rem] rounded-lg bg-hall px-4 py-3 text-center text-sm text-pretty">
          {connection === "unreachable" ? (
            <>
              The box office is not answering at{" "}
              <span translate="no" className="break-all font-semibold">
                {env.NEXT_PUBLIC_API_URL}
              </span>
              . Start it with{" "}
              <code translate="no" className="whitespace-nowrap">
                pnpm --filter @seatrush/api dev
              </code>
              ; this page keeps trying.
            </>
          ) : connection === "busy" ? (
            "The box office is busy right now. This page tries again in a few seconds."
          ) : connection === "failing" ? (
            "The box office answered with an error instead of the seat map. This page keeps trying."
          ) : (
            "Opening the seat map…"
          )}
        </p>
      </div>
    </div>
  );
}
