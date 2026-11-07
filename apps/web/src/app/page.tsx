import {
  HOLD_TTL_SECONDS,
  MAX_SEATS_PER_HOLD,
  MIN_SEATS_PER_HOLD,
  SCREENING_DURATION_MINUTES,
  SEAT_PRICE_PAISE,
  SEAT_ROWS,
  SEATS_PER_ROW,
  TOTAL_SEATS,
} from "@seatrush/shared";
import { Suspense } from "react";
import { ApiStatus, ApiStatusPending } from "../components/api-status.js";
import { HallPreview } from "../components/hall-preview.js";

const rupees = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const HOUSE_RULES: ReadonlyArray<{ term: string; detail: string }> = [
  {
    term: "Seats per booking",
    detail: `${MIN_SEATS_PER_HOLD} to ${MAX_SEATS_PER_HOLD}, held together or not at all`,
  },
  {
    term: "Time to pay",
    detail: `${HOLD_TTL_SECONDS / 60} minutes, timed by the database clock`,
  },
  { term: "Price", detail: `${rupees.format(SEAT_PRICE_PAISE / 100)} a seat` },
  {
    term: "The show",
    detail: `One ${SCREENING_DURATION_MINUTES / 60}-hour screening, ${SEAT_ROWS.length} rows of ${SEATS_PER_ROW}`,
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[90rem] flex-col px-gutter">
      <header className="flex items-baseline justify-between gap-4 border-b border-rule py-4">
        <p translate="no" className="font-display text-2xl leading-none font-extrabold tracking-tight">
          SeatRush
        </p>
        <p className="text-sm text-ink-muted">Cinema booking under load</p>
      </header>

      {/* Small screens read intro, hall, details; wide screens put the hall beside both. */}
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] content-center gap-x-[clamp(2rem,5vw,5rem)] gap-y-8 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:grid-rows-[auto_auto] lg:gap-y-0 lg:py-6">
        <div className="max-w-[38rem] lg:col-start-1 lg:row-start-1 lg:self-end">
          <h1 className="font-display text-display font-extrabold tracking-tight lg:text-display-split">
            <span className="block">1,000 customers.</span>
            <span className="block">{TOTAL_SEATS} seats.</span>
            <span className="block">Every seat sold once.</span>
          </h1>
          <p className="mt-5 max-w-[60ch] text-pretty text-ink-muted xl:text-lg">
            SeatRush is a cinema box office built to be rushed. Simulated customers grab seats at the same
            moment, holds expire, payments fail and retry, and a live dashboard shows each outcome as it
            happens. Through all of it, no seat ever has two owners.
          </p>
        </div>

        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
          <HallPreview />
        </div>

        <div className="max-w-[38rem] lg:col-start-1 lg:row-start-2 lg:self-start">
          <section aria-labelledby="house-rules" className="lg:mt-7">
            <h2 id="house-rules" className="font-display text-xl font-bold">
              House rules
            </h2>
            <dl className="mt-3 divide-y divide-rule border-y border-rule">
              {HOUSE_RULES.map(({ term, detail }) => (
                <div key={term} className="grid items-baseline gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[10rem_1fr]">
                  <dt className="text-sm text-ink-muted">{term}</dt>
                  <dd className="text-sm font-bold sm:text-base sm:font-normal">{detail}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="api-status" className="mt-6" aria-live="polite">
            <h2 id="api-status" className="sr-only">
              API status
            </h2>
            <Suspense fallback={<ApiStatusPending />}>
              <ApiStatus />
            </Suspense>
          </section>
        </div>
      </main>
    </div>
  );
}
