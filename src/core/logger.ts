/**
 * Minimal leveled logger. Writes to stderr by default because the MCP server
 * speaks JSON-RPC over stdout; a stray log line on stdout would corrupt it.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? parseLevel(process.env.TRIAGEMESH_LOG)];
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + "\n"));

  const log = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < threshold) return;
    sink(fields ? `[${level}] ${msg} ${JSON.stringify(fields)}` : `[${level}] ${msg}`);
  };

  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function parseLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "warn";
}
