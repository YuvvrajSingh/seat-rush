import type { Booking } from "@seatrush/shared";
import Image from "next/image";
import { formatPaise } from "../lib/money.js";

export const ticketTimeFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
export const confirmedFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/*
  The photographed stub (public/images/ticket-stub.webp, 1200×800) is cropped to x 40–1160, y 139–654
  so the ticket fills the frame. Inside that frame the paper spans 3.57%–96.25% across and
  7.77%–92.23% down; the crimson band ends at 10.98% and the perforation sits at 71.96%.
  The frame's ground matches the photo's backdrop (#1d0f21) so the crop has no visible edge.
*/

/**
 * The confirmed booking drawn as a cinema ticket: real HTML text laid over the photographed stub.
 * Sizes follow the ticket's own width (container units), so it reads the same at any width.
 */
export function TicketStub({ booking }: { booking: Booking }) {
  const seats = booking.tickets.map((ticket) => ticket.label);
  return (
    <div className="@container relative isolate aspect-[1120/515] w-full overflow-hidden rounded-xl bg-[#1d0f21] text-[#1f1229]">
      <Image
        src="/images/ticket-stub.webp"
        alt=""
        width={1200}
        height={800}
        sizes="(min-width: 64rem) 40rem, 100vw"
        className="absolute top-[-26.99%] left-[-3.571%] -z-10 h-auto w-[107.143%] max-w-none"
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-[7.77%] left-[3.571%] flex w-[7.41%] items-center justify-center"
      >
        <p className="rotate-180 font-display text-[clamp(0.75rem,3.2cqi,1.25rem)] font-extrabold tracking-wide text-white [writing-mode:vertical-rl]">
          SeatRush
        </p>
      </div>
      <div className="absolute inset-y-[7.77%] right-[28.04%] left-[10.98%] flex flex-col justify-between px-[4cqi] py-[3.4cqi]">
        <div>
          <p className="font-display text-[clamp(1rem,5cqi,2rem)] leading-none font-bold text-balance">
            {booking.screening.title}
          </p>
          <p className="mt-[1.2cqi] text-[clamp(0.75rem,2.5cqi,1rem)] leading-tight font-semibold">
            {ticketTimeFormat.format(new Date(booking.screening.startsAt))}
          </p>
          <p className="text-[clamp(0.75rem,2.2cqi,0.875rem)] leading-tight text-[#54465f]">
            Confirmed {confirmedFormat.format(new Date(booking.confirmedAt))}
          </p>
        </div>
        <dl className="text-[clamp(0.75rem,2.2cqi,0.875rem)] leading-tight">
          <dt className="text-[#54465f]">Reference</dt>
          <dd
            translate="no"
            className="font-display text-[clamp(0.75rem,2.9cqi,1.25rem)] leading-tight font-bold break-all tabular-nums"
          >
            {booking.reference}
          </dd>
        </dl>
      </div>
      <dl className="absolute inset-y-[7.77%] right-[5.5%] left-[71.96%] flex flex-col justify-between px-[3cqi] py-[3.4cqi] text-[clamp(0.75rem,2.2cqi,0.875rem)] leading-tight">
        <div>
          <dt className="text-[#54465f]">{seats.length === 1 ? "Seat" : "Seats"}</dt>
          <dd className="mt-[0.6cqi] flex flex-wrap gap-x-[2.4cqi] font-display text-[clamp(1rem,5.2cqi,2.25rem)] leading-[1.05] font-extrabold tabular-nums">
            {seats.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-[#54465f]">Total</dt>
          <dd className="font-display text-[clamp(0.875rem,3.4cqi,1.5rem)] font-bold tabular-nums">
            {formatPaise(booking.amountPaise)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
