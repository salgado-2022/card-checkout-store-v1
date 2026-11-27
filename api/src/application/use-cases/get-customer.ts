import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import type { Customer } from '../../domain/entities';
import type { ApplicationError } from '../errors';
import type { CustomerRepository } from '../ports/customer-repository';

export class GetCustomer {
  constructor(private readonly customers: CustomerRepository) {}

  execute(id: string): ResultAsync<Customer, ApplicationError> {
    return this.customers
      .findById(id)
      .andThen((customer): Result<Customer, ApplicationError> =>
        customer === null ? err({ kind: 'CUSTOMER_NOT_FOUND' }) : ok(customer),
      );
  }
}
