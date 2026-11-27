import { type ArgumentMetadata, type Type, ValidationPipe } from '@nestjs/common';
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
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
// Names declared on the DTO through class-validator metadata (decorators such as @IsString).
function declaredPropertyNames(metatype: Type<unknown>): Set<string> {
  const metadatas = getMetadataStorage().getTargetValidationMetadatas(metatype, '', true, false);
  return new Set(metadatas.map((metadata) => metadata.propertyName));
}
// Own keys of the raw body that the DTO does not declare. Checked before transformation because
// class-transformer drops `__proto__` and `constructor`, and class-validator's whitelist lets
// inherited Object.prototype names such as `toString` pass. JSON.parse creates `__proto__` as an
// own property, so `getOwnPropertyNames` sees it.
function undeclaredBodyKeys(body: Record<string, unknown>, metatype: Type<unknown>): string[] {
  const declared = declaredPropertyNames(metatype);
  return Object.getOwnPropertyNames(body).filter((name) => !declared.has(name));
}
// Global pipe: unknown properties are rejected, DTOs are transformed, and every failure becomes
// the 400 VALIDATION_ERROR envelope through the catalog (no Nest default body).
class CatalogValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (metadata.type === 'body' && isPlainObject(value) && this.toValidate(metadata)) {
      const extraKeys = undeclaredBodyKeys(value, metadata.metatype as Type<unknown>);
      if (extraKeys.length > 0) {
        const errors: ValidationError[] = extraKeys.map((property) => ({
          property,
          children: [],
          constraints: { whitelistValidation: `${property} should not exist` },
        }));
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
