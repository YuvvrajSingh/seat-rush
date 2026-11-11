"use client";

import type { Booking } from "@seatrush/shared";
import { useEffect, useMemo, useState } from "react";
import { env } from "../env.js";
import { ApiError, createBookingApi } from "../lib/booking-api.js";
import { browserSessionStore, loadDemoSession } from "../lib/demo-session.js";
import { formatSeatList } from "../lib/messages.js";
import { formatPaise } from "../lib/money.js";
import { primaryAction, secondaryAction } from "./actions.js";
import { TicketStub, confirmedFormat, ticketTimeFormat } from "./ticket-stub.js";

type TicketState =
  /** 404, or no demo session in this tab: the same answer, so nobody can probe for bookings. */
  | { kind: "not-found" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; booking: Booking };

/**
 * FR-07 printable ticket. Fetched in the browser with this tab's demo session, because a booking
 * is visible only to the customer who made it. Printing drops the photograph for plain text.
 */
export function TicketView({ bookingId }: { bookingId: string }) {
  const api = useMemo(() => createBookingApi(env.NEXT_PUBLIC_API_URL), []);
  // Each answer names the booking and request it belongs to; anything else on screen is "loading".
  const [result, setResult] = useState<{ bookingId: string; request: number; state: TicketState } | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let superseded = false;
    const settle = (state: TicketState) => {
      if (!superseded) setResult({ bookingId, request, state });
    };
    void (async () => {
      const session = loadDemoSession(browserSessionStore(), Date.now());
      if (!session) return settle({ kind: "not-found" });
      try {
        settle({ kind: "loaded", booking: await api.getBooking(bookingId, session.token) });
      } catch (error) {
        if (error instanceof ApiError && (error.code === "not_found" || error.code === "bad_request" || error.code === "unauthorized")) {
          settle({ kind: "not-found" });
        } else {
          settle({
            kind: "failed",
            message:
              error instanceof ApiError && error.code === "network"
                ? "Lost contact with the box office before it answered."
                : "The box office could not fetch this booking.",
          });
        }
      }
    })();
    return () => {
      superseded = true;
    };
  }, [api, bookingId, request]);

  const state = result?.bookingId === bookingId && result.request === request ? result.state : null;
  if (!state) return <p className="text-ink-muted">Opening your ticket…</p>;
  switch (state.kind) {
    case "not-found":
      return (
        <section aria-labelledby="ticket-heading" className="max-w-[40rem]">
          <h1 id="ticket-heading" className="font-display text-4xl font-extrabold tracking-tight text-balance">
            Booking not found
          </h1>
          <p className="mt-4 text-pretty">
            This booking does not exist, or it is not yours. A ticket opens only in the browser tab that booked it.
          </p>
        </section>
      );
    case "failed":
      return (
        <section aria-labelledby="ticket-heading" className="max-w-[40rem]">
          <h1 id="ticket-heading" className="font-display text-4xl font-extrabold tracking-tight text-balance">
            Ticket not loaded
          </h1>
          <p role="alert" className="mt-4 text-pretty">
            {state.message} Your booking is unaffected.
          </p>
          <button type="button" onClick={() => setRequest((count) => count + 1)} className={`${secondaryAction} mt-5`}>
            Try again
          </button>
        </section>
      );
    case "loaded":
      return <Ticket booking={state.booking} />;
  }
}

function Ticket({ booking }: { booking: Booking }) {
  const seats = booking.tickets.map((ticket) => ticket.label);
  const details: ReadonlyArray<[string, string]> = [
    ["Reference", booking.reference],
    ["Screening", booking.screening.title],
    ["Starts", ticketTimeFormat.format(new Date(booking.screening.startsAt))],
    [seats.length === 1 ? "Seat" : "Seats", formatSeatList(seats)],
    ["Total paid", formatPaise(booking.amountPaise)],
    ["Confirmed", confirmedFormat.format(new Date(booking.confirmedAt))],
  ];

  return (
    <article aria-labelledby="ticket-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 id="ticket-heading" className="font-display text-4xl font-extrabold tracking-tight text-balance">
            Your ticket
          </h1>
          <p className="mt-2 text-ink-muted print:hidden">
            Booking <span translate="no" className="break-all">{booking.reference}</span> is confirmed.
          </p>
        </div>
        <button type="button" onClick={() => window.print()} className={`${primaryAction} print:hidden`}>
          Print ticket
        </button>
      </div>

      <div className="mt-6 print:hidden">
        <TicketStub booking={booking} />
      </div>

      {/* On paper the photograph goes; the same facts print as plain text. */}
      <dl className="mt-6 hidden divide-y divide-rule border-y border-rule print:block">
        {details.map(([term, value]) => (
          <div key={term} className="grid grid-cols-[10rem_1fr] gap-4 py-2">
            <dt>{term}</dt>
            <dd className="font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-8 font-display text-2xl font-bold">Tickets</h2>
      <table className="mt-3 w-full border-y border-rule text-left text-sm">
        <thead>
          <tr className="border-b border-rule text-ink-muted">
            <th scope="col" className="py-2 pr-4 font-normal">
              Seat
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Ticket code
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              Price
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {booking.tickets.map((ticket) => (
            <tr key={ticket.seatId}>
              <th scope="row" className="py-2 pr-4 font-display text-lg font-bold">
                {ticket.label}
              </th>
              <td translate="no" className="py-2 pr-4 font-mono tabular-nums">
                {ticket.ticketCode}
              </td>
              <td className="py-2 text-right tabular-nums">{formatPaise(ticket.pricePaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-sm text-pretty text-ink-muted">
        SeatRush is a demo. This ticket was paid with a simulated payment and admits nobody.
      </p>
    </article>
  );
}
