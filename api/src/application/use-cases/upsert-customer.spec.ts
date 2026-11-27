import { FakeApplicationLogger } from '../../../test/support/fake-application-logger';
import { FakeClock, DEFAULT_FAKE_START } from '../../../test/support/fake-clock';
import { FakeIdGenerator } from '../../../test/support/fake-id-generator';
import { InMemoryCustomerRepository } from '../../../test/support/in-memory-customer-repository';
import { type UpsertCustomerCommand, UpsertCustomer, normalizeEmail } from './upsert-customer';

const ANA: UpsertCustomerCommand = {
  email: 'Ana.Perez@Example.com',
  fullName: 'Ana Pérez',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1234567890',
};

function setup() {
  const repository = new InMemoryCustomerRepository();
  const clock = new FakeClock();
  const logger = new FakeApplicationLogger();
  const useCase = new UpsertCustomer(repository, new FakeIdGenerator(), clock, logger);
  return { repository, clock, logger, useCase };
}

describe('normalizeEmail', () => {
  it.each([
    ['  Ana@Example.COM ', 'ana@example.com'],
    ['\tjohn.doe@example.com\n', 'john.doe@example.com'],
    ['already@normal.co', 'already@normal.co'],
  ])('turns %j into %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('UpsertCustomer', () => {
  it('creates a customer for a new email and reports created true', async () => {
    const { repository, useCase } = setup();

    const result = await useCase.execute(ANA);

    const { customer, created } = result._unsafeUnwrap();
    expect(created).toBe(true);
    expect(customer).toMatchObject({
      email: 'ana.perez@example.com',
      fullName: 'Ana Pérez',
      phone: '3001234567',
      documentType: 'CC',
      documentNumber: '1234567890',
    });
    expect(customer.id).not.toBe('');
    expect(repository.count()).toBe(1);
  });

  it('stamps createdAt and updatedAt with the clock instant on create', async () => {
    const { useCase } = setup();

    const { customer } = (await useCase.execute(ANA))._unsafeUnwrap();

    expect(customer.createdAt).toBe(DEFAULT_FAKE_START);
    expect(customer.updatedAt).toBe(DEFAULT_FAKE_START);
  });

  it('stores the normalized email, not the raw input', async () => {
    const { useCase } = setup();

    const { customer } = (
      await useCase.execute({ ...ANA, email: '  MIXED.Case@Example.org  ' })
    )._unsafeUnwrap();

    expect(customer.email).toBe('mixed.case@example.org');
  });

  it('updates the same record when the email differs only in case and spaces', async () => {
    const { repository, clock, useCase } = setup();
    const first = (await useCase.execute(ANA))._unsafeUnwrap();
    clock.advance(60_000);

    const second = (
      await useCase.execute({
        ...ANA,
        email: '  ana.perez@EXAMPLE.com ',
        fullName: 'Ana Pérez Gómez',
        phone: '3109876543',
        documentType: 'NIT',
        documentNumber: '900123456',
      })
    )._unsafeUnwrap();

    expect(second.created).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);
    expect(second.customer.createdAt).toBe(first.customer.createdAt);
    expect(second.customer.updatedAt).toBe(new Date(clock.now()).toISOString());
    expect(second.customer).toMatchObject({
      fullName: 'Ana Pérez Gómez',
      phone: '3109876543',
      documentType: 'NIT',
      documentNumber: '900123456',
    });
    expect(repository.count()).toBe(1);
  });

  it('creates a second record for a different email', async () => {
    const { repository, useCase } = setup();
    await useCase.execute(ANA);

    const other = (await useCase.execute({ ...ANA, email: 'otra@example.com' }))._unsafeUnwrap();

    expect(other.created).toBe(true);
    expect(repository.count()).toBe(2);
  });

  it('writes one info log with the customer id and the normalized email', async () => {
    const { logger, useCase } = setup();

    const { customer, created } = (await useCase.execute(ANA))._unsafeUnwrap();

    expect(logger.at('info')).toEqual([
      {
        level: 'info',
        message: 'customer upserted',
        fields: { customerId: customer.id, email: 'ana.perez@example.com', created },
      },
    ]);
    expect(logger.at('warn')).toHaveLength(0);
    expect(logger.at('alert')).toHaveLength(0);
  });

  it('propagates a repository error as Err and writes no log', async () => {
    const { repository, logger, useCase } = setup();
    repository.failure = { kind: 'REPOSITORY_ERROR', reason: 'ConditionalCheckFailedException' };

    const result = await useCase.execute(ANA);

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'ConditionalCheckFailedException',
    });
    expect(logger.entries).toHaveLength(0);
  });
});
