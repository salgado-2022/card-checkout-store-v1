import { ApplicationLoggerAdapter, sanitizeLogFields } from './application-logger.adapter';
import { JsonLogger, type LogOutput } from './json-logger';

class MemoryOutput implements LogOutput {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const FIXED_DATE = new Date('2026-01-02T03:04:05.000Z');

function createAdapter(): {
  adapter: ApplicationLoggerAdapter;
  stdout: MemoryOutput;
  stderr: MemoryOutput;
} {
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const logger = new JsonLogger({ stdout, stderr }, () => FIXED_DATE);
  return { adapter: new ApplicationLoggerAdapter(logger), stdout, stderr };
}

function parseSingleLine(output: MemoryOutput): Record<string, unknown> {
  expect(output.chunks).toHaveLength(1);
  const line = output.chunks[0] ?? '';
  expect(line.indexOf('\n')).toBe(line.length - 1);
  return JSON.parse(line) as Record<string, unknown>;
}

describe('ApplicationLoggerAdapter', () => {
  it('writes one info JSON line with requestId and reference when given', () => {
    const { adapter, stdout, stderr } = createAdapter();

    adapter.info('transaction created', { requestId: 'req-1', reference: 'ORD-01ABC' });

    expect(parseSingleLine(stdout)).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'transaction created',
      requestId: 'req-1',
      reference: 'ORD-01ABC',
    });
    expect(stderr.chunks).toHaveLength(0);
  });

  it('writes warn to stdout', () => {
    const { adapter, stdout } = createAdapter();

    adapter.warn('provider slow', { statusCode: 504 });

    expect(parseSingleLine(stdout)).toMatchObject({ level: 'warn', statusCode: 504 });
  });

  it('writes alert at error level to stderr', () => {
    const { adapter, stdout, stderr } = createAdapter();

    adapter.alert('AMOUNT_MISMATCH', { reference: 'ORD-01ABC' });

    expect(parseSingleLine(stderr)).toMatchObject({
      level: 'error',
      message: 'AMOUNT_MISMATCH',
      reference: 'ORD-01ABC',
    });
    expect(stdout.chunks).toHaveLength(0);
  });

  it('writes a line without fields when none are given', () => {
    const { adapter, stdout } = createAdapter();

    adapter.info('started');

    expect(parseSingleLine(stdout)).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'started',
    });
  });

  it('never writes keys named like secrets, even with a primitive value', () => {
    const { adapter, stdout } = createAdapter();

    adapter.info('request received', {
      requestId: 'req-2',
      key: 'k',
      secret: 's',
      token: 't',
      password: 'p',
      authorization: 'a',
      Authorization: 'A',
      cvc: '123',
      cardNumber: '4242424242424242',
      card_number: '4242',
      'Idempotency-Key': 'idem',
      'X-Origin-Verify': 'origin',
      privateKey: 'prv',
      cookie: 'c',
      credentialId: 'cr',
      cvv: '999',
    });

    const line = parseSingleLine(stdout);
    expect(line).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'request received',
      requestId: 'req-2',
    });
    expect(stdoutText(stdout)).not.toMatch(/4242|prv|origin|idem/);
  });

  it('drops objects, arrays, functions and undefined values', () => {
    const { adapter, stdout } = createAdapter();

    adapter.info('body', {
      body: { cardToken: 'tok' },
      headers: ['x'],
      callback: () => 1,
      missing: undefined,
      statusCode: 201,
      ok: true,
      nothing: null,
    });

    expect(parseSingleLine(stdout)).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'body',
      statusCode: 201,
      ok: true,
      nothing: null,
    });
  });

  it('keeps the message even if a caller passes a message field', () => {
    const { adapter, stdout } = createAdapter();

    adapter.info('real message', { message: 'spoofed', level: 'error' });

    expect(parseSingleLine(stdout)).toMatchObject({ level: 'info', message: 'real message' });
  });
});

describe('sanitizeLogFields', () => {
  it('returns an empty object when no fields are given', () => {
    expect(sanitizeLogFields()).toEqual({});
  });

  it('keeps safe primitive fields unchanged', () => {
    expect(sanitizeLogFields({ requestId: 'r', count: 2 })).toEqual({ requestId: 'r', count: 2 });
  });
});

function stdoutText(output: MemoryOutput): string {
  return output.chunks.join('');
}
