import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiTooManyRequestsResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Delivery } from '../../../domain/entities';
import { isUlid } from '../../../domain/ulid';
import { GetDelivery } from '../../../application/use-cases/get-delivery';
import { toHttpException } from '../error-catalog';
import { DeliveryResponseDto } from '../dto/delivery.response.dto';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';

// Whitelist: the Delivery is exposed field by field, never spread.
function toDeliveryResponse(delivery: Delivery): DeliveryResponseDto {
  return {
    id: delivery.id,
    transactionId: delivery.transactionId,
    productId: delivery.productId,
    quantity: delivery.quantity,
    recipientName: delivery.recipientName,
    phone: delivery.phone,
    addressLine1: delivery.addressLine1,
    ...(delivery.addressLine2 === undefined ? {} : { addressLine2: delivery.addressLine2 }),
    city: delivery.city,
    department: delivery.department,
    ...(delivery.postalCode === undefined ? {} : { postalCode: delivery.postalCode }),
    status: delivery.status,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

// Controllers only check the path id, call the use case and translate its Result.
@ApiTags('deliveries')
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly getDelivery: GetDelivery) {}

  @Get(':id')
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, description: 'TOO_MANY_REQUESTS' })
  @ApiOkResponse({ type: DeliveryResponseDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto, description: 'DELIVERY_NOT_FOUND' })
  async detail(@Param('id') id: string): Promise<DeliveryResponseDto> {
    // A malformed id can never be stored, so it gets the same answer as an unknown one.
    if (!isUlid(id)) {
      throw toHttpException({ kind: 'DELIVERY_NOT_FOUND' });
    }
    const result = await this.getDelivery.execute(id);
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    return toDeliveryResponse(result.value);
  }
}
