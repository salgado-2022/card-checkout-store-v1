import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { Customer } from '../../../domain/entities';
import { GetCustomer } from '../../../application/use-cases/get-customer';
import { UpsertCustomer } from '../../../application/use-cases/upsert-customer';
import { toHttpException } from '../error-catalog';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { CustomerResponseDto } from '../dto/customer.response.dto';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';

const HTTP_CREATED = 201;
const HTTP_OK = 200;

function toCustomerResponse(customer: Customer): CustomerResponseDto {
  return {
    id: customer.id,
    email: customer.email,
    fullName: customer.fullName,
    phone: customer.phone,
    documentType: customer.documentType,
    documentNumber: customer.documentNumber,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

// Controllers only validate the DTO (done by the global pipe), call the use case and translate
// its Result. No business logic lives here.
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly upsertCustomer: UpsertCustomer,
    private readonly getCustomer: GetCustomer,
  ) {}

  @Post()
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, description: 'TOO_MANY_REQUESTS' })
  @ApiCreatedResponse({ type: CustomerResponseDto, description: 'Customer created.' })
  @ApiOkResponse({ type: CustomerResponseDto, description: 'Existing customer updated.' })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 415, type: ErrorEnvelopeDto, description: 'UNSUPPORTED_MEDIA_TYPE' })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'FORBIDDEN_ORIGIN' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto, description: 'INTERNAL_ERROR' })
  async upsert(
    @Body() body: CreateCustomerDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerResponseDto> {
    const result = await this.upsertCustomer.execute(body);
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    response.status(result.value.created ? HTTP_CREATED : HTTP_OK);
    return toCustomerResponse(result.value.customer);
  }

  @Get(':id')
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, description: 'TOO_MANY_REQUESTS' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto, description: 'CUSTOMER_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'FORBIDDEN_ORIGIN' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto, description: 'INTERNAL_ERROR' })
  async detail(@Param('id') id: string): Promise<CustomerResponseDto> {
    const result = await this.getCustomer.execute(id);
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    return toCustomerResponse(result.value);
  }
}
