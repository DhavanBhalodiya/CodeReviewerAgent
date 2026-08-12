/**
 * Lightweight structured logger.
 *
 * - In CI environments (CI=true) emits JSON-lines for log aggregators.
 * - Locally emits human-readable coloured output.
 * - Respects LOG_LEVEL env var (debug | info | warn | error). Default: info.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const IS_CI = process.env.CI === "true";
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

const COLOURS = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
};

function timestamp() {
  return new Date().toISOString();
}

function log(level, message, context = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  if (IS_CI) {
    // Structured JSON line — compatible with Datadog, GCP, GitHub Actions logs
    const entry = { ts: timestamp(), level, message, ...context };
    const output = JSON.stringify(entry);
    level === "error" ? process.stderr.write(output + "\n") : process.stdout.write(output + "\n");
  } else {
    const colour = COLOURS[level] ?? "";
    const reset = COLOURS.reset;
    const prefix = `${colour}[${level.toUpperCase()}]${reset}`;
    const ts = `\x1b[90m${timestamp()}\x1b[0m`;
    const ctxStr = Object.keys(context).length
      ? " " + JSON.stringify(context)
      : "";
    const line = `${ts} ${prefix} ${message}${ctxStr}\n`;
    level === "error" ? process.stderr.write(line) : process.stdout.write(line);
  }
}

export const logger = {
  debug: (msg, ctx) => log("debug", msg, ctx),
  info:  (msg, ctx) => log("info",  msg, ctx),
  warn:  (msg, ctx) => log("warn",  msg, ctx),
  error: (msg, ctx) => log("error", msg, ctx),
};
