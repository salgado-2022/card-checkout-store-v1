import type { Product } from '../../../src/domain/entities';
import { InMemoryProductRepository } from '../../../test/support/in-memory-product-repository';
import { GetProduct } from './get-product';

const LAMP: Product = {
  id: 'prod-lamp',
  sku: 'SKU-LAMP',
  name: 'Lamp',
  description: 'Desk lamp',
  imageUrl: '/images/lamp.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 5,
};

describe('GetProduct', () => {
  it('returns the existing product with the catalog field set', async () => {
    const repository = new InMemoryProductRepository([LAMP]);

    const result = await new GetProduct(repository).execute('prod-lamp');

    expect(result._unsafeUnwrap()).toEqual(LAMP);
  });

  it('returns a product whose stock is 0', async () => {
    const repository = new InMemoryProductRepository([{ ...LAMP, stock: 0 }]);

    const result = await new GetProduct(repository).execute('prod-lamp');

    expect(result._unsafeUnwrap().stock).toBe(0);
  });

  it.each([
    ['an unknown well-formed id', 'prod-missing'],
    ['an empty id', ''],
    ['an id with spaces and symbols', 'not a valid id!/../x'],
    ['an id longer than any key', 'x'.repeat(5000)],
  ])('returns PRODUCT_NOT_FOUND for %s', async (_label, id) => {
    const repository = new InMemoryProductRepository([LAMP]);

    const result = await new GetProduct(repository).execute(id);

    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'PRODUCT_NOT_FOUND' });
  });

  it('propagates a repository error as Err without turning it into not found', async () => {
    const repository = new InMemoryProductRepository([LAMP]);
    repository.failure = { kind: 'REPOSITORY_ERROR', reason: 'ResourceNotFoundException' };

    const result = await new GetProduct(repository).execute('prod-lamp');

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'ResourceNotFoundException',
    });
  });
});
