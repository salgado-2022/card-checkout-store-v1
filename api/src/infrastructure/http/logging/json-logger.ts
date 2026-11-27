import { maskSensitiveFields } from './mask';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFieldValue = string | number | boolean | null;

// Only primitive values are accepted, so callers cannot serialize whole objects (headers, bodies) by accident.
export type LogFields = Readonly<Record<string, LogFieldValue | undefined>>;

export interface LogOutput {
  write(chunk: string): unknown;
}

export interface JsonLoggerOutputs {
  stdout: LogOutput;
  stderr: LogOutput;
}

// Writes one JSON object per line. `info` and `warn` go to stdout, `error` goes to stderr.
export class JsonLogger {
  constructor(
    private readonly outputs: JsonLoggerOutputs = {
      stdout: process.stdout,
      stderr: process.stderr,
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    // Masking runs first so email and document fields never reach the output raw.
    // Base keys are spread last so a caller cannot override level, time or message.
    const line = JSON.stringify({
      ...maskSensitiveFields(fields),
      level,
      time: this.now().toISOString(),
      message,
    });
    const target = level === 'error' ? this.outputs.stderr : this.outputs.stdout;
    target.write(`${line}\n`);
  }
}
