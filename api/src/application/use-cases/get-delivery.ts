import { err, ok, type Result, type ResultAsync } from 'neverthrow';
import type { Delivery } from '../../domain/entities';
import type { ApplicationError } from '../errors';
import type { DeliveryRepository } from '../ports/delivery-repository';

export class GetDelivery {
  constructor(private readonly deliveries: DeliveryRepository) {}

  execute(id: string): ResultAsync<Delivery, ApplicationError> {
    return this.deliveries
      .findById(id)
      .andThen((delivery): Result<Delivery, ApplicationError> =>
        delivery === null ? err({ kind: 'DELIVERY_NOT_FOUND' }) : ok(delivery),
      );
  }
}
