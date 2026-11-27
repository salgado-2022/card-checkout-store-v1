import { ok } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type {
  CustomerRepository,
  UpsertCustomerInput,
} from '../../src/application/ports/customer-repository';
import type { Customer } from '../../src/domain/entities';
import { respond } from './repository-result';

export class InMemoryCustomerRepository implements CustomerRepository {
  failure: RepositoryError | null = null;
  private readonly customers = new Map<string, Customer>();

  constructor(initial: readonly Customer[] = []) {
    initial.forEach((customer) => this.customers.set(customer.id, customer));
  }

  findByEmail(normalizedEmail: string) {
    return respond(this.failure, () => ok(this.byEmail(normalizedEmail) ?? null));
  }

  findById(id: string) {
    return respond(this.failure, () => ok(this.customers.get(id) ?? null));
  }

  upsert(input: UpsertCustomerInput) {
    return respond(this.failure, () => {
      const existing = this.byEmail(input.email);
      const customer: Customer = {
        id: existing?.id ?? input.id,
        email: input.email,
        fullName: input.fullName,
        phone: input.phone,
        documentType: input.documentType,
        documentNumber: input.documentNumber,
        createdAt: existing?.createdAt ?? input.at,
        updatedAt: input.at,
      };
      this.customers.set(customer.id, customer);
      return ok({ customer, created: existing === undefined });
    });
  }

  count(): number {
    return this.customers.size;
  }

  private byEmail(email: string): Customer | undefined {
    return [...this.customers.values()].find((customer) => customer.email === email);
  }
}
