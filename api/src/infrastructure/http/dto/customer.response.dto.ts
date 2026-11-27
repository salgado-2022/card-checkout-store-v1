import { ApiProperty } from '@nestjs/swagger';
import type { DocumentType } from '../../../domain/entities';
import { DOCUMENT_TYPES } from './create-customer.dto';

// Response shape of one customer. Mirrors Customer: exactly these eight fields.
export class CustomerResponseDto {
  @ApiProperty({ example: '01J9Z3K5M7N8P0Q2R4S6T8V0W1' })
  id!: string;

  @ApiProperty({ example: 'ana.perez@example.com' })
  email!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  fullName!: string;

  @ApiProperty({ example: '3001234567' })
  phone!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'CC' })
  documentType!: DocumentType;

  @ApiProperty({ example: '1234567890' })
  documentNumber!: string;

  @ApiProperty({ example: '2026-01-15T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-01-15T10:00:00.000Z' })
  updatedAt!: string;
}
