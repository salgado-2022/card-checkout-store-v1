import type { ApplicationLogger } from '../../src/application/ports/application-logger';

export type LogLevel = 'info' | 'warn' | 'alert';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Records every entry so tests can assert the warning and alert logs. */
export class FakeApplicationLogger implements ApplicationLogger {
  readonly entries: LogEntry[] = [];

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.record('info', message, fields);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.record('warn', message, fields);
  }

  alert(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.record('alert', message, fields);
  }

  at(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  private record(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>) {
    this.entries.push({ level, message, fields: fields ?? {} });
  }
}
