import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetFees } from '../../../application/use-cases/get-fees';
import { FeesResponseDto } from '../dto/fees.response.dto';

@ApiTags('fees')
@Controller('fees')
export class FeesController {
  constructor(private readonly getFees: GetFees) {}

  @Get()
  @ApiOkResponse({ type: FeesResponseDto })
  fees(): FeesResponseDto {
    // GetFees cannot fail (its error type is `never`), so the Result is unwrapped directly.
    return this.getFees.execute()._unsafeUnwrap();
  }
}
