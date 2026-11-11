"use client";

import type { PaymentAttempt, PaymentScenario, RefundStatus } from "@seatrush/shared";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { TrackedPayment } from "../../lib/booking-state.js";
import { refundMessage } from "../../lib/messages.js";
import { formatPaise } from "../../lib/money.js";
import { DEFAULT_SCENARIO, SCENARIO_OPTIONS, paymentPhase, scenarioOption } from "../../lib/payment.js";
import { primaryAction, secondaryAction } from "../actions.js";
import { TicketStub } from "../ticket-stub.js";

/** A small turning ring beside "waiting" text. Static when reduced motion is preferred; the text carries the state. */
function WaitingRing() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 rounded-full border-2 border-rule border-t-ink motion-safe:animate-spin"
    />
  );
}

/**
 * The payment step inside a held hold (FR-04): a demo control for how the simulated provider
 * answers, then Pay. While the provider has the payment the hold timer keeps running above.
 */
export function PaymentStep({
  amountPaise,
  attempt,
  starting,
  releasing,
  onPay,
  onRelease,
}: {
  amountPaise: number;
  /** The latest attempt for this hold, if any. */
  attempt: PaymentAttempt | null;
  starting: boolean;
  releasing: boolean;
  onPay: (scenario: PaymentScenario) => void;
  onRelease: () => void;
}) {
  const [scenario, setScenario] = useState<PaymentScenario>(attempt?.scenario ?? DEFAULT_SCENARIO);
  const phase = attempt ? paymentPhase(attempt).kind : null;
  const busy = starting || releasing;

  const release = (
    <button
      type="button"
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onRelease}
      className={`${secondaryAction} w-full sm:w-auto`}
    >
      {releasing ? "Releasing…" : "Release seats"}
    </button>
  );

  if (attempt && phase === "waiting") {
    return (
      <div className="mt-5">
        <p className="flex items-center gap-3 text-lg font-semibold">
          <WaitingRing />
          Waiting for the payment provider…
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          {formatPaise(attempt.amountPaise)}, provider set to “{scenarioOption(attempt.scenario).label}”.
        </p>
        <p className="mt-4 text-sm text-pretty">
          Paying does not extend your hold. If the timer runs out before the provider answers, the seats are not
          booked and an approved payment is refunded.
        </p>
        <div className="mt-5">{release}</div>
      </div>
    );
  }

  return (
    <div className="mt-5">
      {phase === "declined" ? (
        <p className="mb-4 border-l-2 border-signal-warn pl-3 text-sm text-pretty">
          The provider declined your last payment. Nothing was taken.
        </p>
      ) : null}
      <fieldset className="rounded-lg border border-dashed border-rule px-4 pt-1 pb-3">
        <legend className="px-1 text-sm font-semibold">Payment provider (demo)</legend>
        <p className="text-sm text-pretty text-ink-muted">
          No real money moves. Choose how the simulated provider answers.
        </p>
        <div className="mt-2 flex flex-col">
          {SCENARIO_OPTIONS.map((option) => (
            <div key={option.scenario} className="flex gap-3 py-1">
              <input
                type="radio"
                id={`scenario-${option.scenario}`}
                name="payment-scenario"
                value={option.scenario}
                checked={scenario === option.scenario}
                onChange={() => setScenario(option.scenario)}
                aria-describedby={`scenario-${option.scenario}-explanation`}
                className="mt-0.5 size-4 shrink-0 accent-accent"
              />
              <p className="text-sm text-pretty">
                <label htmlFor={`scenario-${option.scenario}`} className="cursor-pointer font-semibold">
                  {option.label}
                </label>{" "}
                <span id={`scenario-${option.scenario}-explanation`} className="text-ink-muted">
                  {option.explanation}
                </span>
              </p>
            </div>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-sm text-pretty text-ink-muted">Paying does not extend your hold.</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : () => onPay(scenario)}
          className={`${primaryAction} w-full sm:w-auto`}
        >
          {starting
            ? "Starting payment…"
            : phase === "declined"
              ? `Try again, pay ${formatPaise(amountPaise)}`
              : `Pay ${formatPaise(amountPaise)}`}
        </button>
        {release}
      </div>
    </div>
  );
}

/** The hold ended while the provider still had the payment (FR-05). */
export function PayingAfterHold({ attempt }: { attempt: PaymentAttempt }) {
  return (
    <>
      <p className="mt-4 flex items-center gap-3 text-lg font-semibold">
        <WaitingRing />
        Waiting for the payment provider…
      </p>
      <p className="mt-3 text-pretty">
        The seats are no longer yours. If the provider approves the payment of {formatPaise(attempt.amountPaise)}, it
        will be refunded; if it declines, nothing is taken.
      </p>
    </>
  );
}

/** FR-07: the confirmed booking, its ticket codes and the way to the printable ticket. */
export function BookedResult({
  payment,
  bookingId,
  onDismiss,
}: {
  payment: TrackedPayment;
  bookingId: string;
  onDismiss: () => void;
}) {
  const { booking } = payment;
  return (
    <>
      <p className="mt-1 text-pretty text-ink-muted">Paid {formatPaise(payment.attempt.amountPaise)}. These seats are yours.</p>
      {booking ? (
        <>
          <div className="mt-5">
            <TicketStub booking={booking} />
          </div>
          <h3 className="mt-6 text-sm font-semibold">Ticket codes</h3>
          <dl className="mt-2 divide-y divide-rule border-y border-rule">
            {booking.tickets.map((ticket) => (
              <div key={ticket.seatId} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm whitespace-nowrap text-ink-muted">Seat {ticket.label}</dt>
                <dd translate="no" className="text-right font-mono text-sm break-all tabular-nums">
                  {ticket.ticketCode}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : payment.bookingUnavailable ? (
        <p className="mt-5 border-l-2 border-signal-warn pl-3 text-pretty">
          The box office could not show the tickets for this booking here. The payment and booking stand; try the
          printable ticket, or reload this page.
        </p>
      ) : (
        <p className="mt-5 flex items-center gap-3">
          <WaitingRing />
          Fetching your tickets from the box office…
        </p>
      )}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <Link href={`/bookings/${bookingId}`} className={`${primaryAction} w-full sm:w-auto`}>
          Printable ticket
        </Link>
        <button type="button" onClick={onDismiss} className={`${secondaryAction} w-full sm:w-auto`}>
          Choose seats again
        </button>
      </div>
    </>
  );
}

const REFUND_STEPS: ReadonlyArray<{ status: RefundStatus; label: string }> = [
  { status: "required", label: "Refund recorded" },
  { status: "processing", label: "Refund processing" },
  { status: "refunded", label: "Refunded" },
];

/** FR-05: a success that arrived after the hold ended. The seats were not booked; the money goes back. */
export function RefundResult({ payment, onDismiss }: { payment: TrackedPayment; onDismiss: () => void }) {
  const phase = paymentPhase(payment.attempt);
  if (phase.kind !== "refund") return null;
  const current = REFUND_STEPS.findIndex((step) => step.status === phase.status);
  return (
    <>
      <div className="mt-4 flex items-start gap-4">
        <Image
          src="/images/hold-expired.webp"
          alt=""
          width={88}
          height={88}
          className="size-22 shrink-0 rounded-xl border border-hall-edge"
        />
        <p className="text-pretty">{refundMessage(phase.status, phase.amountPaise, phase.reason)}</p>
      </div>
      <ol className="mt-5 divide-y divide-rule border-y border-rule">
        {REFUND_STEPS.map((step, index) => (
          <li
            key={step.status}
            aria-current={index === current ? "step" : undefined}
            className={`flex items-baseline justify-between gap-4 py-2 text-sm ${index > current ? "text-ink-muted" : ""} ${index === current ? "font-semibold" : ""}`}
          >
            <span>{step.label}</span>
            <span className="tabular-nums">
              {index < current ? "Done" : index === current ? (step.status === "refunded" ? formatPaise(phase.amountPaise) : "Now") : ""}
            </span>
          </li>
        ))}
      </ol>
      {phase.status !== "refunded" ? (
        <p className="mt-3 flex items-center gap-3 text-sm text-ink-muted">
          <WaitingRing />
          Checking the refund every few seconds.
        </p>
      ) : null}
      <button type="button" onClick={onDismiss} className={`${secondaryAction} mt-5 w-full sm:w-auto`}>
        Choose seats again
      </button>
    </>
  );
}
