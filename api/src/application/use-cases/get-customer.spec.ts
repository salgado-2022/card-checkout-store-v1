import type { Customer } from '../../../src/domain/entities';
import { InMemoryCustomerRepository } from '../../../test/support/in-memory-customer-repository';
import { GetCustomer } from './get-customer';

const ANA: Customer = {
  id: '01HZCUSTOMERANA000000000001',
  email: 'ana.perez@example.com',
  fullName: 'Ana Pérez',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1234567890',
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
};

describe('GetCustomer', () => {
  it('returns the stored customer for an existing id', async () => {
    const repository = new InMemoryCustomerRepository([ANA]);

    const result = await new GetCustomer(repository).execute(ANA.id);

    expect(result._unsafeUnwrap()).toEqual(ANA);
  });

  it.each([
    ['an unknown well-formed id', '01HZCUSTOMERMISSING0000000001'],
    ['an empty id', ''],
    ['an id with spaces and symbols', 'not a valid id!/../x'],
    ['an id longer than any key', 'x'.repeat(5000)],
  ])('returns CUSTOMER_NOT_FOUND for %s', async (_label, id) => {
    const repository = new InMemoryCustomerRepository([ANA]);

    const result = await new GetCustomer(repository).execute(id);

    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'CUSTOMER_NOT_FOUND' });
  });

  it('propagates a repository error as Err without turning it into not found', async () => {
    const repository = new InMemoryCustomerRepository([ANA]);
    repository.failure = { kind: 'REPOSITORY_ERROR', reason: 'ResourceNotFoundException' };

    const result = await new GetCustomer(repository).execute(ANA.id);

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'ResourceNotFoundException',
    });
  });
});
