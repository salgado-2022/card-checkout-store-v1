import type { ResultAsync } from 'neverthrow';
import type { Customer, DocumentType } from '../../domain/entities';
import type { RepositoryError } from '../errors';

export interface UpsertCustomerInput {
  /** Id used only when the email is new; an existing customer keeps its id. */
  readonly id: string;
  /** Already normalized (trimmed, lower-cased). */
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  /** ISO-8601 instant used for `createdAt` (on insert) and `updatedAt`. */
  readonly at: string;
}

export interface UpsertCustomerResult {
  readonly customer: Customer;
  /** True when the email was new and a customer was inserted; false when an existing one was updated. */
  readonly created: boolean;
}
export interface CustomerRepository {
  findByEmail(normalizedEmail: string): ResultAsync<Customer | null, RepositoryError>;
  findById(id: string): ResultAsync<Customer | null, RepositoryError>;
  upsert(input: UpsertCustomerInput): ResultAsync<UpsertCustomerResult, RepositoryError>;
}
