import { type ArgumentMetadata, type Type, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, type ValidationError } from 'class-validator';
import { CatalogHttpException, envelopeFor } from './error-catalog';

// One `details` entry per failed rule, as "field: rule". Nested failures use the dotted path.
export function validationDetails(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    const rules = Object.keys(error.constraints ?? {}).map((rule) => `${field}: ${rule}`);
    return [...rules, ...validationDetails(error.children ?? [], field)];
  });
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A class instance produced by class-transformer for a DTO. Nested values without a `@Type`
// stay plain objects, and those carry no DTO metadata to check against.
function isDtoInstance(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return !isPlainObject(value);
}

// Names declared on the DTO through class-validator metadata (decorators such as @IsString).
function declaredPropertyNames(metatype: Type<unknown>): Set<string> {
  const metadatas = getMetadataStorage().getTargetValidationMetadatas(metatype, '', true, false);
  return new Set(metadatas.map((metadata) => metadata.propertyName));
}

// Pairs each raw nested value with the instance class-transformer built for it. Arrays are paired
// by index; a value that is not an array is paired with itself.
function pairsOf(raw: unknown, instance: unknown): [unknown, unknown][] {
  if (Array.isArray(raw) && Array.isArray(instance)) {
    return raw.map((item, index): [unknown, unknown] => [item, instance[index]]);
  }
  return [[raw, instance]];
}

function nestedErrors(property: string, raw: unknown, instance: unknown): ValidationError[] {
  const children = pairsOf(raw, instance).flatMap(([rawItem, instanceItem]) =>
    isPlainObject(rawItem) && isDtoInstance(instanceItem)
      ? undeclaredKeyErrors(rawItem, instanceItem.constructor as Type<unknown>, instanceItem)
      : [],
  );
  return children.length === 0 ? [] : [{ property, children }];
}

// Own keys of the raw body that the DTO does not declare, at every nesting level. Checked before
// transformation because class-transformer drops `__proto__` and `constructor`, and class-validator's
// whitelist lets inherited Object.prototype names such as `toString` pass. JSON.parse creates
// `__proto__` as an own property, so `getOwnPropertyNames` sees it. Nested levels are read from the
// instance class-transformer builds, which says which names each nested DTO declares.
function undeclaredKeyErrors(
  raw: PlainObject,
  metatype: Type<unknown>,
  instance: PlainObject,
): ValidationError[] {
  const declared = declaredPropertyNames(metatype);
  const unknown: ValidationError[] = Object.getOwnPropertyNames(raw)
    .filter((name) => !declared.has(name))
    .map((property) => ({
      property,
      children: [],
      constraints: { whitelistValidation: `${property} should not exist` },
    }));
  const nested = [...declared].flatMap((name) => {
    const rawValue = Object.getOwnPropertyDescriptor(raw, name)?.value;
    return rawValue === undefined ? [] : nestedErrors(name, rawValue, instance[name]);
  });
  return [...unknown, ...nested];
}

// Global pipe: unknown properties are rejected at every level, DTOs are transformed, and every
// failure becomes the 400 VALIDATION_ERROR envelope through the catalog (no Nest default body).
class CatalogValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (metadata.type === 'body' && isPlainObject(value) && this.toValidate(metadata)) {
      const metatype = metadata.metatype as Type<unknown>;
      const instance = plainToInstance(metatype, value) as PlainObject;
      const errors = undeclaredKeyErrors(value, metatype, instance);
      if (errors.length > 0) {
        throw this.exceptionFactory(errors);
      }
    }
    return super.transform(value, metadata);
  }
}

export function createValidationPipe(): ValidationPipe {
  return new CatalogValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new CatalogHttpException(
        envelopeFor('VALIDATION_ERROR', validationDetails(errors)),
        'VALIDATION_ERROR',
      ),
  });
}
