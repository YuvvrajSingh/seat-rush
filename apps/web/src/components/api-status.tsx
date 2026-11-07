import { connection } from "next/server";
import type { ReactNode } from "react";
import { env } from "../env.js";
import { checkApiHealth, type ApiHealth } from "../lib/api-health.js";

type Tone = "ok" | "warn" | "down" | "pending";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "text-signal-ok",
  warn: "text-signal-warn",
  down: "text-signal-down",
  pending: "text-ink-muted",
};

const TONE_GLYPHS: Record<Tone, ReactNode> = {
  ok: <circle cx="8" cy="8" r="5" fill="currentColor" />,
  warn: <path d="M8 2.5 14 13.5H2Z" fill="currentColor" />,
  down: (
    <>
      <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="m5.25 10.75 5.5-5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </>
  ),
  pending: <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray="3 2.5" />,
};

function StatusLine({ tone, title, children }: { tone: Tone; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <svg viewBox="0 0 16 16" className={`mt-1 size-4 shrink-0 ${TONE_CLASSES[tone]}`} aria-hidden="true" focusable="false">
        {TONE_GLYPHS[tone]}
      </svg>
      <div className="min-w-0">
        <p className={`font-bold ${TONE_CLASSES[tone]}`}>{title}</p>
        <div className="mt-1 text-sm text-ink-muted">{children}</div>
      </div>
    </div>
  );
}

function Endpoint({ url }: { url: string }) {
  return (
    <span translate="no" className="break-all text-ink">
      {url}
    </span>
  );
}

function HealthView({ health }: { health: ApiHealth }) {
  switch (health.kind) {
    case "online":
      return (
        <StatusLine tone="ok" title="API online">
          <p>
            <Endpoint url={health.url} /> answered in {health.latencyMs} ms.
          </p>
        </StatusLine>
      );
    case "unhealthy":
      return (
        <StatusLine tone="warn" title="API not healthy">
          <p>
            <Endpoint url={health.url} /> is reachable. {health.detail} Check the API logs, then{" "}
            <CheckAgain />.
          </p>
        </StatusLine>
      );
    case "unreachable":
      return (
        <StatusLine tone="down" title="API unreachable">
          <p>
            Nothing answered at <Endpoint url={health.url} />. {health.detail}
          </p>
          <p className="mt-2">
            Start it with{" "}
            <code
              translate="no"
              className="rounded border border-rule bg-paper-raised px-1.5 py-0.5 text-[0.8125rem] whitespace-nowrap text-ink"
            >
              pnpm --filter @seatrush/api dev
            </code>
            , then <CheckAgain />.
          </p>
        </StatusLine>
      );
  }
}

function CheckAgain() {
  return (
    <a href="/" className="font-bold text-accent underline decoration-1 underline-offset-3 hover:decoration-2">
      check again
    </a>
  );
}

/** Streams in after the static shell: the probe runs per request, never at build time. */
export async function ApiStatus() {
  await connection();
  const health = await checkApiHealth(env.NEXT_PUBLIC_API_URL);
  return <HealthView health={health} />;
}

export function ApiStatusPending() {
  return (
    <StatusLine tone="pending" title="Checking the API…">
      <p>
        Asking <Endpoint url={`${env.NEXT_PUBLIC_API_URL}/healthz`} /> whether it is up.
      </p>
    </StatusLine>
  );
}
