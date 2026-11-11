import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { TicketView } from "../../../components/ticket-view.js";

export const metadata: Metadata = {
  title: "Your ticket",
  description: "A printable SeatRush ticket for a confirmed booking.",
  robots: { index: false },
};

export default function BookingPage({ params }: PageProps<"/bookings/[bookingId]">) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[50rem] flex-col px-gutter print:max-w-none print:px-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule py-4 print:hidden">
        <Link href="/" translate="no" className="font-display text-2xl leading-none font-extrabold tracking-tight">
          SeatRush
        </Link>
        <Link href="/book" className="text-sm font-semibold underline underline-offset-4">
          Back to booking
        </Link>
      </header>
      <main id="main" className="flex-1 py-8 print:py-0">
        <Suspense fallback={<p className="text-ink-muted">Opening your ticket…</p>}>
          {params.then(({ bookingId }) => (
            <TicketView bookingId={bookingId} />
          ))}
        </Suspense>
      </main>
    </div>
  );
}
