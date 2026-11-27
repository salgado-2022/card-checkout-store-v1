import { ApiProperty } from '@nestjs/swagger';

// Response shape of one catalog product. Mirrors CatalogProduct: exactly these eight fields.
export class ProductResponseDto {
  @ApiProperty({ example: '01J9Z3K5M7N8P0Q2R4S6T8V0W1' })
  id!: string;

  @ApiProperty({ example: 'SKU-0001' })
  sku!: string;

  @ApiProperty({ example: 'Auriculares inalámbricos' })
  name!: string;

  @ApiProperty({ example: 'Auriculares con cancelación de ruido y 30 horas de batería.' })
  description!: string;

  @ApiProperty({ example: '/images/auriculares.webp' })
  imageUrl!: string;

  @ApiProperty({ description: 'Integer amount in cents of the currency.', example: 12000000 })
  priceInCents!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: 5 })
  stock!: number;
}
