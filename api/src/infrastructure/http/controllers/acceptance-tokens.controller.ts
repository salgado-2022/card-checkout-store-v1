import { Controller, Get } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AcceptanceTokens } from '../../../application/ports/payment-gateway';
import { GetAcceptanceTokens } from '../../../application/use-cases/get-acceptance-tokens';
import { toHttpException } from '../error-catalog';
import { AcceptanceTokensResponseDto } from '../dto/acceptance-tokens.response.dto';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';

const HTTP_BAD_GATEWAY = 502;

// Builds the response from named fields so no extra property from the provider reaches the client.
function toAcceptanceTokensResponse(tokens: AcceptanceTokens): AcceptanceTokensResponseDto {
  return {
    acceptanceToken: {
      token: tokens.acceptanceToken.token,
      permalink: tokens.acceptanceToken.permalink,
    },
    acceptPersonalAuth: {
      token: tokens.acceptPersonalAuth.token,
      permalink: tokens.acceptPersonalAuth.permalink,
    },
  };
}

// Controllers only call the use case and translate its Result. No business logic lives here.
@ApiTags('acceptance-tokens')
@Controller('acceptance-tokens')
export class AcceptanceTokensController {
  constructor(private readonly getAcceptanceTokens: GetAcceptanceTokens) {}

  @Get()
  @ApiOkResponse({ type: AcceptanceTokensResponseDto })
  @ApiResponse({
    status: HTTP_BAD_GATEWAY,
    type: ErrorEnvelopeDto,
    description: 'PAYMENT_PROVIDER_ERROR',
  })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'FORBIDDEN_ORIGIN' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto, description: 'INTERNAL_ERROR' })
  async detail(): Promise<AcceptanceTokensResponseDto> {
    const result = await this.getAcceptanceTokens.execute();
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    return toAcceptanceTokensResponse(result.value);
  }
}
