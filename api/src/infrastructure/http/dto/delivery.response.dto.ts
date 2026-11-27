import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DELIVERY_STATUSES } from '../../../domain/delivery-status';

// Response of GET /deliveries/:id. Exactly these fields.
export class DeliveryResponseDto {
  @ApiProperty({ example: '01HZX0000000000000000000JN' })
  id!: string;

  @ApiProperty({ example: '01HZX0000000000000000000EF' })
  transactionId!: string;

  @ApiProperty({ example: '01HZX0000000000000000000KM' })
  productId!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 'Ana Perez' })
  recipientName!: string;

  @ApiProperty({ example: '3001234567' })
  phone!: string;

  @ApiProperty({ example: 'Calle 1 # 2-3' })
  addressLine1!: string;

  @ApiPropertyOptional({ example: 'Apto 401' })
  addressLine2?: string;

  @ApiProperty({ example: 'Bogotá' })
  city!: string;

  @ApiProperty({ example: 'Bogotá D.C.' })
  department!: string;

  @ApiPropertyOptional({ example: '110111' })
  postalCode?: string;

  @ApiProperty({ enum: DELIVERY_STATUSES, example: 'PENDING' })
  status!: string;

  @ApiProperty({ example: '2026-05-01T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-05-01T10:00:00.000Z' })
  updatedAt!: string;
}
