import { ok } from 'neverthrow';
import type { RepositoryError } from '../../src/application/errors';
import type {
  DeliveryRepository,
  NewDelivery,
} from '../../src/application/ports/delivery-repository';
import type { DeliveryStatus } from '../../src/domain/delivery-status';
import type { Delivery } from '../../src/domain/entities';
import { respond } from './repository-result';

export class InMemoryDeliveryRepository implements DeliveryRepository {
  failure: RepositoryError | null = null;
  private readonly deliveries = new Map<string, Delivery>();

  findById(id: string) {
    return respond(this.failure, () => ok(this.deliveries.get(id) ?? null));
  }

  create(input: NewDelivery) {
    return respond(this.failure, () => {
      const delivery: Delivery = { ...input, status: 'PENDING', updatedAt: input.createdAt };
      this.deliveries.set(delivery.id, delivery);
      return ok(delivery);
    });
  }

  count(): number {
    return this.deliveries.size;
  }

  /** Used by the in-memory finalize only. Returns false when the delivery does not exist. */
  updateStatus(id: string, status: DeliveryStatus, at: string): boolean {
    const delivery = this.deliveries.get(id);
    if (!delivery) {
      return false;
    }
    this.deliveries.set(id, { ...delivery, status, updatedAt: at });
    return true;
  }

  /** Same as `findById` but as a plain value, for assertions. */
  get(id: string): Delivery | undefined {
    return this.deliveries.get(id);
  }
}
