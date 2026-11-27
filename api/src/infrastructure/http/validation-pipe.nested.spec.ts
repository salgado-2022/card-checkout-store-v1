import type { ArgumentMetadata } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsObject, IsString, ValidateNested } from 'class-validator';
import { CatalogHttpException } from './error-catalog';
import { createValidationPipe } from './validation-pipe';

class ItemDto {
  @IsString()
  sku!: string;
}

class OrderDto {
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];

  @ValidateNested()
  @Type(() => ItemDto)
  single!: ItemDto;

  // Declared, but without @Type: class-transformer keeps the value as a plain object.
  @IsObject()
  notTyped!: Record<string, unknown>;
}

const BODY_METADATA: ArgumentMetadata = { type: 'body', metatype: OrderDto, data: undefined };

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

// JSON text is parsed like express.json does, so `__proto__` stays an own property.
function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('createValidationPipe: nested objects and arrays', () => {
  it('reports an undeclared key inside every element of a nested array with its path', async () => {
    const pipe = createValidationPipe();
    const body = parse(
      '{"items":[{"sku":"a","extra":1},{"sku":"b","__proto__":2}],"single":{"sku":"c"},"notTyped":{}}',
    );

    const error = await rejectionOf(pipe.transform(body, BODY_METADATA));

    expect(error.envelope.details).toEqual([
      'items.extra: whitelistValidation',
      'items.__proto__: whitelistValidation',
    ]);
  });

  it('reports an undeclared key inside a nested single object', async () => {
    const pipe = createValidationPipe();
    const body = parse('{"items":[],"single":{"sku":"c","toString":1},"notTyped":{}}');

    const error = await rejectionOf(pipe.transform(body, BODY_METADATA));

    expect(error.envelope.details).toEqual(['single.toString: whitelistValidation']);
  });

  it('does not reject keys of a nested value that has no DTO type', async () => {
    const pipe = createValidationPipe();
    const body = parse('{"items":[],"single":{"sku":"c"},"notTyped":{"anything":true}}');

    const result = await pipe.transform(body, BODY_METADATA);

    expect(result).toMatchObject({ notTyped: { anything: true } });
  });

  it('skips a nested array element that is not an object, leaving it to class-validator', async () => {
    const pipe = createValidationPipe();
    const body = parse('{"items":[42],"single":{"sku":"c"},"notTyped":{}}');

    const error = await rejectionOf(pipe.transform(body, BODY_METADATA));

    expect(error.envelope.details.some((detail) => detail.includes('whitelistValidation'))).toBe(
      false,
    );
    expect(error.envelope.details.length).toBeGreaterThan(0);
  });
});
