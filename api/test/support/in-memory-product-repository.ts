import { ok } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type { ProductRepository } from '../../src/application/ports/product-repository';
import type { Product } from '../../src/domain/entities';
import { respond } from './repository-result';

export class InMemoryProductRepository implements ProductRepository {
  /** When set, every port method fails with this error. */
  failure: RepositoryError | null = null;
  private readonly products = new Map<string, Product>();

  constructor(initial: readonly Product[] = []) {
    initial.forEach((product) => this.products.set(product.id, product));
  }

  findAll() {
    return respond(this.failure, () => ok([...this.products.values()]));
  }

  findById(id: string) {
    return respond(this.failure, () => ok(this.products.get(id) ?? null));
  }

  /** Test helper: stock currently stored, `undefined` for an unknown product. */
  stockOf(id: string): number | undefined {
    return this.products.get(id)?.stock;
  }

  /** Used by the in-memory finalize only: decrements when `stock >= quantity`. */
  decrementIfAvailable(id: string, quantity: number): boolean {
    const product = this.products.get(id);
    if (!product || product.stock < quantity) {
      return false;
    }
    this.products.set(id, { ...product, stock: product.stock - quantity });
    return true;
  }

  hasStockFor(id: string, quantity: number): boolean {
    const product = this.products.get(id);
    return product !== undefined && product.stock >= quantity;
  }
}
