import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CreateTransaction } from '../../../application/use-cases/create-transaction';
import { toHttpException } from '../error-catalog';
import { CreateTransactionDto } from '../dto/create-transaction.dto';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';
import { TransactionResponseDto } from '../dto/transaction.response.dto';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// Controllers only validate the DTO (done by the global pipe), call the use case and translate
// its Result. No business logic lives here.
@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly createTransaction: CreateTransaction) {}

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 characters from letters, digits, ".", "_" and "-".',
  })
  @ApiCreatedResponse({ type: TransactionResponseDto, description: 'Transaction created.' })
  @ApiOkResponse({
    type: TransactionResponseDto,
    description: 'Idempotent replay of a finished request, or current state of a stale attempt.',
  })
  @ApiBadRequestResponse({
    type: ErrorEnvelopeDto,
    description: 'VALIDATION_ERROR or MISSING_IDEMPOTENCY_KEY',
  })
  @ApiNotFoundResponse({
    type: ErrorEnvelopeDto,
    description: 'PRODUCT_NOT_FOUND or CUSTOMER_NOT_FOUND',
  })
  @ApiConflictResponse({
    type: ErrorEnvelopeDto,
    description: 'INSUFFICIENT_STOCK or IDEMPOTENCY_KEY_IN_PROGRESS',
  })
  @ApiResponse({ status: 415, type: ErrorEnvelopeDto, description: 'UNSUPPORTED_MEDIA_TYPE' })
  @ApiUnprocessableEntityResponse({
    type: ErrorEnvelopeDto,
    description: 'IDEMPOTENCY_KEY_REUSED',
  })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: 'TOO_MANY_REQUESTS' })
  @ApiResponse({
    status: 502,
    type: ErrorEnvelopeDto,
    description: 'PAYMENT_PROVIDER_ERROR. The payment provider rejected the request.',
  })
  async create(
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body() body: CreateTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.createTransaction.execute({ idempotencyKey, request: body });
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    response.status(result.value.statusCode);
    return result.value.body;
  }
}
