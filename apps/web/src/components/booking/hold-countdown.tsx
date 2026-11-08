"use client";

import type { Hold } from "@seatrush/shared";
import { useEffect, useEffectEvent, useState } from "react";
import { countdownState, describeRemaining, formatRemaining } from "../../lib/countdown.js";

/**
 * Time left on a hold by the estimated server clock. At zero it waits for the box office instead
 * of declaring the hold over: only the server decides expiry (prd §6, §9).
 * Its own component so the once-a-second tick re-renders nothing else.
 */
export function HoldCountdown({
  hold,
  clockOffsetMs,
  onZero,
}: {
  hold: Pick<Hold, "status" | "expiresAt">;
  clockOffsetMs: number;
  onZero: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const countdown = countdownState(hold, now, clockOffsetMs);
  const counting = countdown.phase === "counting";
  const remaining = counting ? countdown.remainingMs : 0;

  // Tick on whole-second boundaries of the remaining time so the display never skips a second.
  useEffect(() => {
    if (!counting) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining % 1000 || 1000);
    return () => window.clearTimeout(timer);
  }, [counting, remaining]);

  const reachedZero = useEffectEvent(onZero);
  useEffect(() => {
    if (!counting) reachedZero();
  }, [counting]);

  if (!counting) {
    return <p className="text-base font-semibold">Checking with the box office…</p>;
  }
  return (
    <p className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-ink-muted">Time left to pay</span>
      <span role="timer" className="font-display text-4xl font-bold tabular-nums">
        <span aria-hidden="true">{formatRemaining(remaining)}</span>
        <span className="sr-only">{describeRemaining(remaining)}</span>
      </span>
    </p>
  );
}
