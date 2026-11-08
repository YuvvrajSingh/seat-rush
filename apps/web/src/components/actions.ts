// Action styles shared by buttons and button-looking links. One primary per screen.

const actionBase =
  "inline-flex h-12 items-center justify-center rounded-lg px-5 font-semibold transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60 motion-safe:not-aria-disabled:active:scale-[0.98]";

export const primaryAction = `${actionBase} bg-accent text-accent-ink hover:bg-[color-mix(in_oklab,var(--accent)_86%,var(--ink))]`;

export const secondaryAction = `${actionBase} border border-rule bg-paper-raised text-ink hover:border-ink-muted`;
