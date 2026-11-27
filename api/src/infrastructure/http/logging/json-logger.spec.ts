import { JsonLogger, type LogOutput } from './json-logger';

class MemoryOutput implements LogOutput {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const FIXED_DATE = new Date('2026-01-02T03:04:05.000Z');

function createLogger(): { logger: JsonLogger; stdout: MemoryOutput; stderr: MemoryOutput } {
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const logger = new JsonLogger({ stdout, stderr }, () => FIXED_DATE);
  return { logger, stdout, stderr };
}

function parseSingleLine(output: MemoryOutput): Record<string, unknown> {
  expect(output.chunks).toHaveLength(1);
  const line = output.chunks[0] ?? '';
  expect(line.endsWith('\n')).toBe(true);
  expect(line.indexOf('\n')).toBe(line.length - 1);
  return JSON.parse(line) as Record<string, unknown>;
}

describe('JsonLogger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes info as one JSON line on stdout with level, time, message and fields', () => {
    const { logger, stdout, stderr } = createLogger();

    logger.info('request completed', { requestId: 'req-1', statusCode: 200, durationMs: 12 });

    expect(parseSingleLine(stdout)).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'request completed',
      requestId: 'req-1',
      statusCode: 200,
      durationMs: 12,
    });
    expect(stderr.chunks).toHaveLength(0);
  });

  it('writes warn on stdout with level warn', () => {
    const { logger, stdout, stderr } = createLogger();

    logger.warn('origin rejected', { reason: 'missing_header' });

    expect(parseSingleLine(stdout)).toMatchObject({ level: 'warn', reason: 'missing_header' });
    expect(stderr.chunks).toHaveLength(0);
  });

  it('writes warn without fields when none are given', () => {
    const { logger, stdout } = createLogger();

    logger.warn('no fields');

    expect(parseSingleLine(stdout)).toEqual({
      level: 'warn',
      time: '2026-01-02T03:04:05.000Z',
      message: 'no fields',
    });
  });

  it('writes error on stderr and nothing on stdout', () => {
    const { logger, stdout, stderr } = createLogger();

    logger.error('startup failed', { parameter: '/card-checkout/origin-verify' });

    expect(parseSingleLine(stderr)).toMatchObject({
      level: 'error',
      message: 'startup failed',
      parameter: '/card-checkout/origin-verify',
    });
    expect(stdout.chunks).toHaveLength(0);
  });

  it('keeps level, time and message even when the caller passes the same keys', () => {
    const { logger, stdout } = createLogger();

    logger.info('real message', { level: 'hacked', time: 'yesterday', message: 'fake' });

    expect(parseSingleLine(stdout)).toMatchObject({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'real message',
    });
  });

  it('writes a line with only base keys when no fields are given', () => {
    const { logger, stdout } = createLogger();

    logger.info('started');

    expect(parseSingleLine(stdout)).toEqual({
      level: 'info',
      time: '2026-01-02T03:04:05.000Z',
      message: 'started',
    });
  });

  it('drops fields whose value is undefined', () => {
    const { logger, stdout } = createLogger();

    logger.info('partial', { requestId: 'req-2', missing: undefined });

    expect(parseSingleLine(stdout)).not.toHaveProperty('missing');
  });

  it('masks email and documentNumber fields and never writes the raw values', () => {
    const { logger, stdout, stderr } = createLogger();

    logger.info('customer upserted', {
      email: 'john.doe@example.com',
      customerEmail: 'jane.roe@example.com',
      documentNumber: '1234567890',
    });
    logger.error('customer failed', { documentNumber: '9876543210' });

    expect(parseSingleLine(stdout)).toMatchObject({
      email: 'j***@example.com',
      customerEmail: 'j***@example.com',
      documentNumber: '*******890',
    });
    expect(stdout.chunks.join('')).not.toMatch(/john\.doe|jane\.roe|1234567890/);
    expect(stderr.chunks.join('')).not.toMatch(/9876543210/);
    expect(parseSingleLine(stderr)).toMatchObject({ documentNumber: '*******210' });
  });

  it('masks short email and document values without revealing them', () => {
    const { logger, stdout } = createLogger();

    logger.info('short values', { email: 'a@example.com', documentNumber: '123' });

    expect(parseSingleLine(stdout)).toMatchObject({
      email: '*@example.com',
      documentNumber: '***',
    });
  });

  it('uses process.stdout, process.stderr and the current date when no outputs are given', () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new JsonLogger();
    const before = Date.now();

    logger.info('to stdout');
    logger.error('to stderr');

    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    const stdoutLine = JSON.parse(String(stdoutWrite.mock.calls[0]?.[0])) as { time: string };
    expect(Date.parse(stdoutLine.time)).toBeGreaterThanOrEqual(before);
  });
});
