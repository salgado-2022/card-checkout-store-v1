import { ApiProperty } from '@nestjs/swagger';

// One acceptance token and the permalink of the document it accepts. Both values come from the
// payment provider and are public: the browser needs them to build the acceptance step.
export class AcceptanceLinkDto {
  @ApiProperty({ example: 'tok_test_fake_acceptance' })
  token!: string;

  @ApiProperty({ example: 'https://payment.test/docs/acceptance' })
  permalink!: string;
}

// Response shape of GET /acceptance-tokens. Mirrors AcceptanceTokens: exactly these two fields.
export class AcceptanceTokensResponseDto {
  @ApiProperty({ type: AcceptanceLinkDto })
  acceptanceToken!: AcceptanceLinkDto;

  @ApiProperty({ type: AcceptanceLinkDto })
  acceptPersonalAuth!: AcceptanceLinkDto;
}
