import { type ValidationError, ValidationPipe } from '@nestjs/common';
import { CatalogHttpException, envelopeFor } from './error-catalog';

// One `details` entry per failed rule, as "field: rule". Nested failures use the dotted path.
export function validationDetails(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    const rules = Object.keys(error.constraints ?? {}).map((rule) => `${field}: ${rule}`);
    return [...rules, ...validationDetails(error.children ?? [], field)];
  });
}

// Global pipe: unknown properties are rejected, DTOs are transformed, and every failure becomes
// the 400 VALIDATION_ERROR envelope through the catalog (no Nest default body).
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
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
