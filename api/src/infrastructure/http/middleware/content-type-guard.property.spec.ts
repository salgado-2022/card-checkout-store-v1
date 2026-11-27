import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import {
  createHttpPipelineApp,
  TEST_ORIGIN_SECRET,
} from '../../../../test/support/http-pipeline-app';
import { ERROR_CATALOG } from '../error-catalog';

const NUM_RUNS = 25;
const PATH = '/api/v1/probe/echo';
const VALID_JSON = '{"name":"ok"}';
// Not valid JSON. If the parser ran, the answer would be 400, not 415.
const UNPARSEABLE_JSON = '{"name": ';

const handled = jest.fn();

@Controller('probe')
class EchoController {
  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: unknown): unknown {
    handled();
    return body;
  }
}

// Random casing of a fixed word, one flag per character.
const casedWord = (word: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((flags) =>
    word
      .split('')
      .map((char, index) => (flags[index] === true ? char.toUpperCase() : char.toLowerCase()))
      .join(''),
  );

const optionalSpaces = fc.constantFrom('', ' ', '  ');

// application/json in any casing, optional spaces around ';' and '=', and an optional
// charset=utf-8 in any casing, optionally quoted.
const acceptedContentType: fc.Arbitrary<string> = fc
  .record({
    media: casedWord('application/json'),
    beforeSemicolon: optionalSpaces,
    afterSemicolon: optionalSpaces,
    charsetName: casedWord('charset'),
    beforeEquals: optionalSpaces,
    afterEquals: optionalSpaces,
    quoted: fc.boolean(),
    charset: fc.option(casedWord('utf-8'), { nil: undefined }),
  })
  .map(
    ({
      media,
      beforeSemicolon,
      afterSemicolon,
      charsetName,
      beforeEquals,
      afterEquals,
      quoted,
      charset,
    }) => {
      if (charset === undefined) {
        return media;
      }
      const value = quoted ? `"${charset}"` : charset;
      return `${media}${beforeSemicolon};${afterSemicolon}${charsetName}${beforeEquals}=${afterEquals}${value}`;
    },
  );

// Every value the guard must reject. `undefined` stands for a missing Content-Type header.
const rejectedContentType: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constantFrom<string | undefined>(
    undefined,
    'text/plain',
    'application/xml',
    'multipart/form-data; boundary=x',
    'application/x-json',
    'text/json',
    'application/jsonp',
    'application/json-patch+json',
    'application/json; charset=latin1',
    'application/json; charset=utf-16',
    'application/json; charset=',
    'application/json; charset=utf8',
    'application/json; charset=utf-8; charset=latin1',
    'application/json; charset="latin1"',
  ),
  casedWord('application/json').map((media) => `${media}x`),
  fc
    .constantFrom('latin1', 'utf-16', 'ascii', 'utf-8x', 'utf8')
    .map((charset) => `application/json; charset=${charset}`),
);

describe('Feature: payments-api, Property 37: The media-type guard accepts exactly application/json with an absent or utf-8 charset, case-insensitively, and rejects everything else before any body parsing', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createHttpPipelineApp({ controllers: [EchoController] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    handled.mockClear();
  });

  const server = (): Server => app.getHttpServer();

  it('lets every accepted Content-Type reach the handler', async () => {
    await fc.assert(
      fc.asyncProperty(acceptedContentType, async (contentType) => {
        handled.mockClear();

        const response = await request(server())
          .post(PATH)
          .set('X-Origin-Verify', TEST_ORIGIN_SECRET)
          .set('Content-Type', contentType)
          .send(VALID_JSON);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ name: 'ok' });
        expect(handled).toHaveBeenCalledTimes(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('answers 415 UNSUPPORTED_MEDIA_TYPE before the parser runs for every rejected Content-Type', async () => {
    const expected = ERROR_CATALOG.UNSUPPORTED_MEDIA_TYPE;

    await fc.assert(
      fc.asyncProperty(rejectedContentType, async (contentType) => {
        handled.mockClear();

        const base = request(server()).post(PATH).set('X-Origin-Verify', TEST_ORIGIN_SECRET);
        // Without a Content-Type, a body must still be present for the guard to apply.
        const response =
          contentType === undefined
            ? await base
                .unset('Content-Type')
                .set('Content-Length', String(Buffer.byteLength(UNPARSEABLE_JSON)))
                .send(Buffer.from(UNPARSEABLE_JSON))
                .buffer(true)
            : await base.set('Content-Type', contentType).send(UNPARSEABLE_JSON);

        expect(response.status).toBe(expected.status);
        expect(response.body).toEqual({
          statusCode: expected.status,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: expected.message,
          details: [],
        });
        expect(handled).not.toHaveBeenCalled();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
