import type { ResultAsync } from 'neverthrow';
import type { Product } from '../../domain/entities';
import type { RepositoryError } from '../errors';

export interface ProductRepository {
  /** Strongly consistent read of the whole catalog (Requirement 1.7). */
  findAll(): ResultAsync<readonly Product[], RepositoryError>;
  /** Strongly consistent read; `null` when the product does not exist. */
  findById(id: string): ResultAsync<Product | null, RepositoryError>;
  // No stock-decrement method: stock only changes inside TransactionRepository.finalize.
}
