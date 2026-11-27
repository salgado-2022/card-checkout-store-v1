import type { ResultAsync } from 'neverthrow';
import type { Delivery } from '../../domain/entities';
import type { RepositoryError } from '../errors';

/** A Delivery is always created PENDING; `status` and `updatedAt` are set by the adapter. */
export type NewDelivery = Omit<Delivery, 'status' | 'updatedAt'>;

export interface DeliveryRepository {
  findById(id: string): ResultAsync<Delivery | null, RepositoryError>;
  create(input: NewDelivery): ResultAsync<Delivery, RepositoryError>;
}
