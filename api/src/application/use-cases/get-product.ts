import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import type { ApplicationError } from '../errors';
import type { ProductRepository } from '../ports/product-repository';
import { type CatalogProduct, toCatalogProduct } from './catalog-product';

export class GetProduct {
  constructor(private readonly products: ProductRepository) {}

  execute(id: string): ResultAsync<CatalogProduct, ApplicationError> {
    return this.products
      .findById(id)
      .andThen((product): Result<CatalogProduct, ApplicationError> =>
        product === null ? err({ kind: 'PRODUCT_NOT_FOUND' }) : ok(toCatalogProduct(product)),
      );
  }
}
