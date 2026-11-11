// pino `redact` paths shared by the API and worker. Logs never include credentials or payment
// details (prd.md §12). Wildcards cover one nesting level.

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "password",
  "card",
  "cardNumber",
  "cvv",
  "cvc",
  "upiId",
  "vpa",
  "paymentDetails",
] as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-seatrush-signature"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]),
];

export const LOG_REDACT_CENSOR = "[Redacted]";
