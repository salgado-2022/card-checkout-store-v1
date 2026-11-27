import { ApiProperty } from '@nestjs/swagger';

// Response shape of GET /fees. The values come from the validated config (BASE_FEE_IN_CENTS,
// DELIVERY_FEE_IN_CENTS), never from the request.
export class FeesResponseDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ description: 'Base fee in cents.', example: 300000 })
  baseFeeInCents!: number;

  @ApiProperty({ description: 'Delivery fee in cents.', example: 800000 })
  deliveryFeeInCents!: number;
}
