/** Logging port. Callers must never pass secrets, card tokens or card data in `fields`. */
export interface ApplicationLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  /** Conditions that need attention, e.g. BACKORDER or AMOUNT_MISMATCH. */
  alert(message: string, fields?: Readonly<Record<string, unknown>>): void;
}
