import type { ResultAsync } from 'neverthrow';
import type { ApplicationError } from '../errors';
import type { ProductRepository } from '../ports/product-repository';
import { type CatalogProduct, toCatalogProduct } from './catalog-product';

function byNameAscending(a: CatalogProduct, b: CatalogProduct): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

export class GetProducts {
  constructor(private readonly products: ProductRepository) {}

  execute(): ResultAsync<readonly CatalogProduct[], ApplicationError> {
    return this.products
      .findAll()
      .map((products) => products.map(toCatalogProduct).sort(byNameAscending));
  }
}
