import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransactionAmountsDto, TransactionCardDto } from './transaction.response.dto';

// Response of GET /transactions/:id. Exactly these fields: never the External_Id, the card token,
// `lastSyncedAt` or card data other than brand and last four digits.
export class TransactionDetailResponseDto {
  @ApiProperty({ example: '01HZX0000000000000000000EF' })
  id!: string;

  @ApiProperty({ example: 'ORD-01HZX0000000000000000000GH' })
  reference!: string;

  @ApiProperty({
    enum: ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR'],
    example: 'PENDING',
  })
  status!: string;

  @ApiPropertyOptional({
    example: 'Fondos insuficientes',
    description: 'Only for final statuses that carry a reason.',
  })
  statusReason?: string;

  @ApiProperty({ type: () => TransactionAmountsDto })
  amounts!: TransactionAmountsDto;

  @ApiProperty({ example: '01HZX0000000000000000000JN' })
  deliveryId!: string;

  @ApiProperty({ type: () => TransactionCardDto })
  card!: TransactionCardDto;

  @ApiProperty({ example: '01HZX0000000000000000000KM' })
  productId!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 3 })
  installments!: number;

  @ApiProperty({ example: '2026-05-01T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-05-01T10:00:02.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ example: '2026-05-01T10:00:02.000Z' })
  finalizedAt?: string;
}
