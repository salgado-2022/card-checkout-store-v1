import type { Product } from '../../domain/entities';

/** The exact Product field set returned by the catalog endpoints (Requirement 1.3). */
export interface CatalogProduct {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly priceInCents: number;
  readonly currency: string;
  readonly stock: number;
}

export function toCatalogProduct(product: Product): CatalogProduct {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    imageUrl: product.imageUrl,
    priceInCents: product.priceInCents,
    currency: product.currency,
    stock: product.stock,
  };
}
