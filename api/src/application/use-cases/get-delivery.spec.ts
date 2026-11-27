import { InMemoryDeliveryRepository } from '../../../test/support/in-memory-delivery-repository';
import type { NewDelivery } from '../ports/delivery-repository';
import { GetDelivery } from './get-delivery';

const NEW_DELIVERY: NewDelivery = {
  id: '01HZX0000000000000000000IJ',
  transactionId: '01HZX0000000000000000000EF',
  productId: 'prod-1',
  quantity: 2,
  recipientName: 'Ana Perez',
  phone: '3001234567',
  addressLine1: 'Calle 1 # 2-3',
  city: 'Bogotá',
  department: 'Bogotá D.C.',
  createdAt: '2026-05-01T10:00:00.000Z',
};

describe('GetDelivery', () => {
  let deliveries: InMemoryDeliveryRepository;
  let useCase: GetDelivery;

  beforeEach(() => {
    deliveries = new InMemoryDeliveryRepository();
    useCase = new GetDelivery(deliveries);
  });

  it('returns the stored Delivery', async () => {
    await deliveries.create(NEW_DELIVERY);

    const result = await useCase.execute(NEW_DELIVERY.id);

    expect(result._unsafeUnwrap()).toEqual({
      ...NEW_DELIVERY,
      status: 'PENDING',
      updatedAt: NEW_DELIVERY.createdAt,
    });
  });

  it('returns DELIVERY_NOT_FOUND for an unknown id', async () => {
    const result = await useCase.execute('01HZX0000000000000000000ZZ');

    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'DELIVERY_NOT_FOUND' });
  });

  it('passes a repository failure through as REPOSITORY_ERROR', async () => {
    deliveries.failure = { kind: 'REPOSITORY_ERROR', reason: 'ConditionalCheckFailed' };

    const result = await useCase.execute(NEW_DELIVERY.id);

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'ConditionalCheckFailed',
    });
  });
});
