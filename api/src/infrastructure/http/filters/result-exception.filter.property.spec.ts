import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import { Controller, Get, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fc from 'fast-check';
import request from 'supertest';
import { JsonLogger, type LogOutput } from '../logging/json-logger';
import { ResultExceptionFilter } from './result-exception.filter';

const CONFIGURED_SECRET = 'fake-configured-secret-0001';
const NUM_RUNS = 100;
const PROPERTY_TIMEOUT_MS = 60_000;
const ENVELOPE_KEYS = ['code', 'details', 'message', 'statusCode'];

// A stack frame line: newline, indentation, "at", then a function or path token.
const FRAME_LINE = /\n\s+at\s+\S+/;
// The "(file:line:column)" suffix that V8 appends to every frame.
const SOURCE_POSITION = /\(\S+:\d+:\d+\)/;

// Generated messages and identifiers use letters, digits and spaces only. The configured secret and
// env values contain a hyphen and frames contain parentheses, so generated text cannot contain them by chance.
const WORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');
const SAFE_CHARS = [...WORD_CHARS, ' '];

const safeText = fc.string({ unit: fc.constantFrom(...SAFE_CHARS), minLength: 1, maxLength: 60 });
const word = fc.string({ unit: fc.constantFrom(...WORD_CHARS), minLength: 3, maxLength: 12 });

const envValue = fc
  .string({ unit: fc.constantFrom(...WORD_CHARS), minLength: 16, maxLength: 32 })
  .map((value) => `env-${value}`);

const frameText = fc
  .record({
    fn: word,
    dir: word,
    file: word,
    line: fc.integer({ min: 1, max: 9999 }),
    column: fc.integer({ min: 1, max: 200 }),
  })
  .map(({ fn, dir, file, line, column }) => `at ${fn} (${dir}/${file}.ts:${line}:${column})`);

interface Leaks {
  env: string[];
  frame: string;
}

interface Scenario {
  exception: unknown;
  status: number;
  sensitive: string[];
}

class DomainFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainFailure';
  }
}

const ERROR_CLASSES: ReadonlyArray<new (message: string) => Error> = [
  Error,
  TypeError,
  RangeError,
  DomainFailure,
];

const leaksArb: fc.Arbitrary<Leaks> = fc.record({
  env: fc.array(envValue, { minLength: 1, maxLength: 3 }),
  frame: frameText,
});

function sensitiveOf(leaks: Leaks): string[] {
  return [CONFIGURED_SECRET, ...leaks.env, leaks.frame];
}

function envRecord(env: string[]): Record<string, string> {
  return Object.fromEntries(env.map((value, index) => [`TEST_ENV_${index}`, value]));
}

function fakeStack(error: Error, frame: string): string {
  return [
    `${error.name}: ${error.message}`,
    `    ${frame}`,
    '    at Object.<anonymous> (/app/dist/main.js:1:1)',
  ].join('\n');
}

const plainErrorScenario: fc.Arbitrary<Scenario> = fc
  .tuple(fc.constantFrom(...ERROR_CLASSES), safeText, fc.boolean(), leaksArb)
  .map(([ErrorClass, message, leakInMessage, leaks]) => {
    const sensitive = sensitiveOf(leaks);
    const error = new ErrorClass(leakInMessage ? `${message} ${sensitive.join(' ')}` : message);
    error.stack = fakeStack(error, leaks.frame);
    Object.assign(error, { env: envRecord(leaks.env), cause: new Error(sensitive.join(' ')) });
    return { exception: error, status: 500, sensitive };
  });

// Http messages come from the client side of the contract, so the secret goes only into extra body
// properties, cause and stack. Nest echoes `message`, which is expected behavior.
// Only statuses that have a catalog code keep their status. Any other HttpException status maps to
// 500 INTERNAL_ERROR, which the example tests cover.
const httpErrorScenario: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.constantFrom(400, 404, 413, 415, 429),
    fc.constantFrom('string', 'object', 'array'),
    safeText,
    fc.array(safeText, { maxLength: 3 }),
    leaksArb,
  )
  .map(([status, shape, message, details, leaks]) => {
    const sensitive = sensitiveOf(leaks);
    const extras = { ...envRecord(leaks.env), secret: CONFIGURED_SECRET, cause: sensitive[0] };
    let exception: HttpException;
    if (shape === 'string') {
      exception = new HttpException(message, status);
    } else if (shape === 'object') {
      exception = new HttpException({ message, ...extras }, status);
    } else {
      exception = new HttpException({ message: details, ...extras }, status);
    }
    exception.stack = fakeStack(exception, leaks.frame);
    Object.assign(exception, { env: envRecord(leaks.env) });
    return { exception, status, sensitive };
  });

const nonErrorScenario: fc.Arbitrary<Scenario> = fc
  .tuple(fc.constantFrom('string', 'object', 'null', 'undefined', 'number'), leaksArb)
  .map(([kind, leaks]) => {
    const sensitive = sensitiveOf(leaks);
    const exceptions: Record<string, unknown> = {
      string: sensitive.join(' '),
      object: {
        message: sensitive.join(' '),
        stack: leaks.frame,
        env: envRecord(leaks.env),
        secret: CONFIGURED_SECRET,
      },
      null: null,
      undefined: undefined,
      number: 42,
    };
    return { exception: exceptions[kind], status: 500, sensitive };
  });

const scenario: fc.Arbitrary<Scenario> = fc.oneof(
  plainErrorScenario,
  httpErrorScenario,
  nonErrorScenario,
);

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function expectNoInternals(body: unknown, text: string, sensitive: string[]): void {
  expect(Object.keys(body as object).sort()).toEqual(ENVELOPE_KEYS);
  for (const value of sensitive) {
    expect(text).not.toContain(value);
  }
  for (const value of collectStrings(body)) {
    expect(value).not.toMatch(FRAME_LINE);
    expect(value).not.toMatch(SOURCE_POSITION);
  }
}

function respond(exception: unknown): {
  responseStatus: unknown;
  json: jest.Mock;
  body: unknown;
} {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'req-property' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  new ResultExceptionFilter(logger).catch(exception, host);
  return { responseStatus: status.mock.calls[0]?.[0], json, body: json.mock.calls[0]?.[0] };
}

// The error thrown by the probe route is swapped per run, so each run exercises the full Nest pipeline.
let pendingException: unknown;

@Controller('leak-probe')
class LeakProbeController {
  @Get()
  probe(): never {
    throw pendingException;
  }
}

const silentOutput: LogOutput = { write: () => true };

describe('Feature: platform-foundation, Property 5: Error responses never leak internals', () => {
  it(
    'keeps stacks, secrets and env values out of filter responses',
    () => {
      fc.assert(
        fc.property(scenario, ({ exception, status, sensitive }) => {
          const { responseStatus, json, body } = respond(exception);
          expect(json).toHaveBeenCalledTimes(1);
          expect(responseStatus).toBe(status);
          expect(body).toMatchObject({ statusCode: status });
          expectNoInternals(body, JSON.stringify(body), sensitive);
        }),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  describe('over HTTP', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [LeakProbeController],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.useGlobalFilters(
        new ResultExceptionFilter(new JsonLogger({ stdout: silentOutput, stderr: silentOutput })),
      );
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it(
      'keeps stacks, secrets and env values out of the HTTP response body',
      async () => {
        await fc.assert(
          fc.asyncProperty(scenario, async ({ exception, status, sensitive }) => {
            pendingException = exception;
            const response = await request(app.getHttpServer()).get('/leak-probe');
            expect(response.status).toBe(status);
            expectNoInternals(response.body, response.text, sensitive);
          }),
          { numRuns: NUM_RUNS },
        );
      },
      PROPERTY_TIMEOUT_MS,
    );
  });
});
