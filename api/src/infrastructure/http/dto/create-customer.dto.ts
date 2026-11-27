import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateBy,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import type { DocumentType } from '../../../domain/entities';

export const DOCUMENT_TYPES: readonly DocumentType[] = ['CC', 'CE', 'NIT', 'PP'];

// Digit and alphanumeric rules per document type. Lengths are checked by the regex itself.
const DOCUMENT_NUMBER_RULES: Readonly<Record<DocumentType, RegExp>> = {
  CC: /^\d{6,10}$/,
  CE: /^\d{6,10}$/,
  NIT: /^\d{9,10}$/,
  PP: /^[A-Za-z0-9]{6,12}$/,
};

function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

// Custom rule: documentNumber must match the rule of the documentType sent in the same body.
// When documentType is invalid, its own `isIn` error is reported and this rule passes, so the
// client sees one error per cause.
function IsDocumentNumberForType(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDocumentNumberForType',
      validator: {
        validate: (value: unknown, args?: ValidationArguments): boolean => {
          const documentType = (args?.object as { documentType?: unknown } | undefined)
            ?.documentType;
          if (!isDocumentType(documentType)) {
            return true;
          }
          return typeof value === 'string' && DOCUMENT_NUMBER_RULES[documentType].test(value);
        },
        defaultMessage: (): string => 'documentNumber does not match the rule of its documentType',
      },
    },
    validationOptions,
  );
}

// Request body of POST /customers. The global ValidationPipe rejects unknown properties.
export class CreateCustomerDto {
  @ApiProperty({
    description: 'Buyer full name.',
    minLength: 3,
    maxLength: 80,
    example: 'Ana Pérez',
  })
  @IsString()
  @Length(3, 80)
  fullName!: string;

  @ApiProperty({
    description: 'Buyer email. Surrounding spaces are removed before validation.',
    maxLength: 120,
    example: 'ana.perez@example.com',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsEmail()
  @MaxLength(120)
  email!: string;

  @ApiProperty({
    description: 'Colombian mobile number: 10 digits starting with 3.',
    example: '3001234567',
  })
  @IsString()
  @Matches(/^3\d{9}$/)
  phone!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'CC' })
  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;

  @ApiProperty({
    description:
      'Document number. CC and CE: 6 to 10 digits. NIT: 9 to 10 digits. PP: 6 to 12 letters or digits.',
    example: '1234567890',
  })
  @IsDocumentNumberForType()
  documentNumber!: string;
}
