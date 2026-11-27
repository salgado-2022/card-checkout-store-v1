import { ApiProperty } from '@nestjs/swagger';
import { CARD_BRANDS, type CardBrand } from '../../../domain/card-brand';

export class TransactionAmountsDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: 24000000 })
  subtotalInCents!: number;

  @ApiProperty({ example: 300000 })
  baseFeeInCents!: number;

  @ApiProperty({ example: 800000 })
  deliveryFeeInCents!: number;

  @ApiProperty({ example: 25100000 })
  totalInCents!: number;
}

export class TransactionCardDto {
  @ApiProperty({ enum: CARD_BRANDS, example: 'VISA' })
  brand!: CardBrand;

  @ApiProperty({ example: '4242' })
  lastFour!: string;
}

// Response of POST /transactions (201, and 200 on replay). Exactly these fields, never the card token.
export class TransactionResponseDto {
  @ApiProperty({ example: '01HZX0000000000000000000EF' })
  id!: string;

  @ApiProperty({ example: 'ORD-01HZX0000000000000000000GH' })
  reference!: string;

  @ApiProperty({
    enum: ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR'],
    example: 'PENDING',
  })
  status!: string;

  @ApiProperty({ type: () => TransactionAmountsDto })
  amounts!: TransactionAmountsDto;

  @ApiProperty({ example: '01HZX0000000000000000000IJ' })
  deliveryId!: string;

  @ApiProperty({ type: () => TransactionCardDto })
  card!: TransactionCardDto;

  @ApiProperty({ example: '2026-05-01T10:00:00.000Z' })
  createdAt!: string;
}
