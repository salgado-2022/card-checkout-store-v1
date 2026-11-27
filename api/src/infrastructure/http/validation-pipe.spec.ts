import type { ArgumentMetadata } from '@nestjs/common';
import { IsString } from 'class-validator';
import { CatalogHttpException } from './error-catalog';
import { createValidationPipe } from './validation-pipe';
import { CreateCustomerDto } from './dto/create-customer.dto';

class SampleDto {
  @IsString()
  name!: string;
}

const BODY_METADATA: ArgumentMetadata = { type: 'body', metatype: SampleDto, data: undefined };

async function rejectionOf(promise: Promise<unknown>): Promise<CatalogHttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CatalogHttpException) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the pipe to reject');
}

// Parses the raw text the way express.json does, so `__proto__` arrives as an own property.
function parseRawBody(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('createValidationPipe', () => {
  describe('undeclared keys of the raw body', () => {
    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
      'rejects an own key named %s with a whitelistValidation detail',
      async (key) => {
        const pipe = createValidationPipe();
        const body = parseRawBody(`{"name":"Ana","${key}":"x"}`);

        const error = await rejectionOf(pipe.transform(body, BODY_METADATA));

        expect(error.getStatus()).toBe(400);
        expect(error.envelope).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: expect.any(String),
          details: [`${key}: whitelistValidation`],
        });
      },
    );

    it('reports every undeclared own key, including non-enumerable ones', async () => {
      const pipe = createValidationPipe();
      const body: Record<string, unknown> = { name: 'Ana' };
      Object.defineProperty(body, 'hidden', { value: 1, enumerable: false });
      body.extra = 2;

      const error = await rejectionOf(pipe.transform(body, BODY_METADATA));

      expect(error.envelope.details).toEqual([
        'hidden: whitelistValidation',
        'extra: whitelistValidation',
      ]);
    });

    it('keeps the class-validator response for valid bodies with declared keys only', async () => {
      const pipe = createValidationPipe();

      const result = await pipe.transform({ name: 'Ana' }, BODY_METADATA);

      expect(result).toBeInstanceOf(SampleDto);
      expect(result).toMatchObject({ name: 'Ana' });
    });

    it('passes a body with a declared key through to class-validator, which still rejects field errors', async () => {
      const pipe = createValidationPipe();

      const error = await rejectionOf(pipe.transform({ name: 42 }, BODY_METADATA));

      expect(error.envelope.details).toEqual(['name: isString']);
    });

    it('does not run the raw-key check for non-body arguments', async () => {
      const pipe = createValidationPipe();
      const queryMetadata: ArgumentMetadata = {
        type: 'query',
        metatype: SampleDto,
        data: undefined,
      };
      // class-transformer drops `__proto__`, so only the raw-key check would reject this query.
      const query = parseRawBody('{"name":"Ana","__proto__":"x"}');

      await expect(pipe.transform(query, queryMetadata)).resolves.toMatchObject({ name: 'Ana' });
    });

    it('does not check keys when the metatype is a primitive or missing', async () => {
      const pipe = createValidationPipe();

      await expect(
        pipe.transform({ extra: 'x' }, { type: 'body', metatype: Object, data: undefined }),
      ).resolves.toEqual({ extra: 'x' });
      await expect(
        pipe.transform({ extra: 'x' }, { type: 'body', metatype: undefined, data: undefined }),
      ).resolves.toEqual({ extra: 'x' });
    });

    it('leaves non-plain bodies such as arrays to the Nest pipeline', async () => {
      const pipe = createValidationPipe();

      await expect(pipe.transform([1], BODY_METADATA)).rejects.toBeInstanceOf(CatalogHttpException);
    });
  });

  describe('HTTP-shaped customers body', () => {
    const VALID_FIELDS =
      '"fullName":"Ana Pérez","email":"ana.perez@example.com","phone":"3001234567","documentType":"CC","documentNumber":"1234567890"';

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
      'rejects a valid customer body with an extra %s key',
      async (key) => {
        const pipe = createValidationPipe();
        const body = parseRawBody(`{${VALID_FIELDS},"${key}":"x"}`);
        const metadata: ArgumentMetadata = {
          type: 'body',
          metatype: CreateCustomerDto,
          data: undefined,
        };

        const error = await rejectionOf(pipe.transform(body, metadata));

        expect(error.envelope.details).toEqual([`${key}: whitelistValidation`]);
      },
    );
  });
});
