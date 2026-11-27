import { Controller, Get } from '@nestjs/common';
import { ApiTooManyRequestsResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetFees } from '../../../application/use-cases/get-fees';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';
import { FeesResponseDto } from '../dto/fees.response.dto';

@ApiTags('fees')
@Controller('fees')
export class FeesController {
  constructor(private readonly getFees: GetFees) {}

  @Get()
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, description: 'TOO_MANY_REQUESTS' })
  @ApiOkResponse({ type: FeesResponseDto })
  fees(): FeesResponseDto {
    // GetFees cannot fail (its error type is `never`), so the Result is unwrapped directly.
    return this.getFees.execute()._unsafeUnwrap();
  }
}
