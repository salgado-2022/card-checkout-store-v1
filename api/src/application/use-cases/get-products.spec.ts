import type { Product } from '../../../src/domain/entities';
import { InMemoryProductRepository } from '../../../test/support/in-memory-product-repository';
import { GetProducts } from './get-products';

const CATALOG_FIELDS = [
  'currency',
  'description',
  'id',
  'imageUrl',
  'name',
  'priceInCents',
  'sku',
  'stock',
];

const product = (overrides: Partial<Product> & Pick<Product, 'id' | 'name'>): Product => ({
  sku: `SKU-${overrides.id}`,
  description: 'Description',
  imageUrl: '/images/item.webp',
  priceInCents: 12_000_000,
  currency: 'COP',
  stock: 3,
  ...overrides,
});

describe('GetProducts', () => {
  it('keeps products with the same name in a stable order', async () => {
    const repository = new InMemoryProductRepository([
      product({ id: 'p-2', name: 'Lamp' }),
      product({ id: 'p-1', name: 'Lamp' }),
    ]);

    const result = await new GetProducts(repository).execute();

    expect(result._unsafeUnwrap().map((item) => item.name)).toEqual(['Lamp', 'Lamp']);
  });

  it('returns the products sorted by name ascending', async () => {
    const repository = new InMemoryProductRepository([
      product({ id: 'p-3', name: 'Chair' }),
      product({ id: 'p-1', name: 'Apple' }),
      product({ id: 'p-2', name: 'Lamp' }),
    ]);

    const result = await new GetProducts(repository).execute();

    expect(result._unsafeUnwrap().map((item) => item.name)).toEqual(['Apple', 'Chair', 'Lamp']);
  });

  it('maps every product to exactly the catalog field set', async () => {
    const leaked = { ...product({ id: 'p-1', name: 'Lamp' }), internalNote: 'never exposed' };
    const repository = new InMemoryProductRepository([leaked as Product]);

    const [item] = (await new GetProducts(repository).execute())._unsafeUnwrap();

    expect(Object.keys(item ?? {}).sort()).toEqual(CATALOG_FIELDS);
    expect(item).toEqual({
      id: 'p-1',
      sku: 'SKU-p-1',
      name: 'Lamp',
      description: 'Description',
      imageUrl: '/images/item.webp',
      priceInCents: 12_000_000,
      currency: 'COP',
      stock: 3,
    });
  });

  it('includes products whose stock is 0', async () => {
    const repository = new InMemoryProductRepository([
      product({ id: 'p-1', name: 'Lamp', stock: 0 }),
    ]);

    const result = await new GetProducts(repository).execute();

    expect(result._unsafeUnwrap()).toEqual([expect.objectContaining({ id: 'p-1', stock: 0 })]);
  });

  it('returns an empty list when the catalog is empty', async () => {
    const result = await new GetProducts(new InMemoryProductRepository()).execute();

    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('does not reorder the repository array in place', async () => {
    const products = [product({ id: 'p-2', name: 'Lamp' }), product({ id: 'p-1', name: 'Apple' })];
    const repository = new InMemoryProductRepository(products);

    await new GetProducts(repository).execute();

    expect(products.map((item) => item.id)).toEqual(['p-2', 'p-1']);
  });

  it('propagates a repository error as Err without throwing', async () => {
    const repository = new InMemoryProductRepository();
    repository.failure = { kind: 'REPOSITORY_ERROR', reason: 'ThrottlingException' };

    const result = await new GetProducts(repository).execute();

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'REPOSITORY_ERROR',
      reason: 'ThrottlingException',
    });
  });
});
