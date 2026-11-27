import type { ResultAsync } from 'neverthrow';
import type { DocumentType } from '../../domain/entities';
import type { ApplicationError } from '../errors';
import type { ApplicationLogger } from '../ports/application-logger';
import type { Clock } from '../ports/clock';
import type { CustomerRepository, UpsertCustomerResult } from '../ports/customer-repository';
import type { IdGenerator } from '../ports/id-generator';

export interface UpsertCustomerCommand {
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
}

/** Trims surrounding whitespace and lower-cases the address, so one buyer maps to one record. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class UpsertCustomer {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: ApplicationLogger,
  ) {}

  execute(command: UpsertCustomerCommand): ResultAsync<UpsertCustomerResult, ApplicationError> {
    const email = normalizeEmail(command.email);
    const at = this.clock.now().toISOString();

    return this.customers
      .upsert({
        id: this.ids.ulid(),
        email,
        fullName: command.fullName,
        phone: command.phone,
        documentType: command.documentType,
        documentNumber: command.documentNumber,
        at,
      })
      .map((result) => {
        this.logger.info('customer upserted', {
          customerId: result.customer.id,
          email: result.customer.email,
          created: result.created,
        });
        return result;
      });
  }
}
