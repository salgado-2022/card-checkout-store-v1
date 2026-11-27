import { ApiProperty } from '@nestjs/swagger';
import { ERROR_CATALOG, type ErrorCode } from '../error-catalog';

// Documents the fixed error body that every 4xx and 5xx response uses (see error-catalog.ts).
export class ErrorEnvelopeDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ enum: Object.keys(ERROR_CATALOG) as ErrorCode[], example: 'PRODUCT_NOT_FOUND' })
  code!: ErrorCode;

  @ApiProperty({ example: 'Product not found.' })
  message!: string;

  @ApiProperty({ type: [String], example: [] })
  details!: string[];
}
