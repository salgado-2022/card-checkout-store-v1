import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CARD_BRANDS, type CardBrand } from '../../../domain/card-brand';

// The 32 departments of Colombia plus Bogotá D.C.: a closed list.
export const COLOMBIAN_DEPARTMENTS: readonly string[] = [
  'Amazonas',
  'Antioquia',
  'Arauca',
  'Atlántico',
  'Bolívar',
  'Boyacá',
  'Caldas',
  'Caquetá',
  'Casanare',
  'Cauca',
  'Cesar',
  'Chocó',
  'Córdoba',
  'Cundinamarca',
  'Guainía',
  'Guaviare',
  'Huila',
  'La Guajira',
  'Magdalena',
  'Meta',
  'Nariño',
  'Norte de Santander',
  'Putumayo',
  'Quindío',
  'Risaralda',
  'San Andrés y Providencia',
  'Santander',
  'Sucre',
  'Tolima',
  'Valle del Cauca',
  'Vaupés',
  'Vichada',
  'Bogotá D.C.',
];

// Optional fields may be omitted but never sent as null: `undefined` skips the rule, anything else is checked.
const IsOptionalNotNull = (): PropertyDecorator =>
  ValidateIf((_object: object, value: unknown) => value !== undefined);

export class DeliveryDto {
  @ApiProperty({ minLength: 3, maxLength: 80, example: 'Ana Pérez' })
  @IsString()
  @Length(3, 80)
  recipientName!: string;

  @ApiProperty({
    description: 'Colombian mobile number: 10 digits starting with 3.',
    example: '3001234567',
  })
  @IsString()
  @Matches(/^3\d{9}$/)
  phone!: string;

  @ApiProperty({ minLength: 5, maxLength: 120, example: 'Calle 1 # 2-3' })
  @IsString()
  @Length(5, 120)
  addressLine1!: string;

  @ApiProperty({ required: false, maxLength: 60, example: 'Apto 401' })
  @IsOptionalNotNull()
  @IsString()
  @MaxLength(60)
  addressLine2?: string;

  @ApiProperty({ minLength: 2, maxLength: 60, example: 'Bogotá' })
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ enum: COLOMBIAN_DEPARTMENTS, example: 'Bogotá D.C.' })
  @IsIn(COLOMBIAN_DEPARTMENTS)
  department!: string;

  @ApiProperty({ required: false, description: '6 digits.', example: '110111' })
  @IsOptionalNotNull()
  @IsString()
  @Matches(/^\d{6}$/)
  postalCode?: string;
}

export class PaymentDto {
  @ApiProperty({
    description: 'Token issued by the payment provider. Sent to the provider only, never stored.',
    example: 'tok_test_fake',
  })
  @IsString()
  @Length(1, 256)
  // Token charset only. A bare 13 to 19 digit value looks like a card number (PAN) and is rejected,
  // so a raw card number can never reach the API by mistake.
  @Matches(/^(?!\d{13,19}$)[A-Za-z0-9_.-]+$/)
  cardToken!: string;

  @ApiProperty({ minimum: 1, maximum: 36, example: 1 })
  @IsInt()
  @Min(1)
  @Max(36)
  installments!: number;

  @ApiProperty({ enum: CARD_BRANDS, example: 'VISA' })
  @IsIn(CARD_BRANDS)
  brand!: CardBrand;

  @ApiProperty({ description: 'Last four digits of the card.', example: '4242' })
  @IsString()
  @Matches(/^\d{4}$/)
  lastFour!: string;
}

// Request body of POST /transactions. The global ValidationPipe rejects unknown properties at every
// level, including amount properties, which the server always computes itself.
export class CreateTransactionDto {
  @ApiProperty({ minLength: 1, maxLength: 64, example: '01HZX0000000000000000000AB' })
  @IsString()
  @Length(1, 64)
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: 5, example: 2 })
  @IsInt()
  @Min(1)
  @Max(5)
  quantity!: number;

  @ApiProperty({ minLength: 1, maxLength: 64, example: '01HZX0000000000000000000CD' })
  @IsString()
  @Length(1, 64)
  customerId!: string;

  @ApiProperty({ type: DeliveryDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeliveryDto)
  delivery!: DeliveryDto;

  @ApiProperty({ type: PaymentDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentDto)
  payment!: PaymentDto;

  @ApiProperty({
    description: 'Acceptance token of the current terms, from GET /acceptance-tokens.',
    maxLength: 512,
    example: 'acc_test_fake',
  })
  @IsString()
  @Length(1, 512)
  acceptanceToken!: string;

  @ApiProperty({
    description: 'Personal data authorization token, from GET /acceptance-tokens.',
    maxLength: 512,
    example: 'auth_test_fake',
  })
  @IsString()
  @Length(1, 512)
  acceptPersonalAuth!: string;
}
