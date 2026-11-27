import type { ResultAsync } from 'neverthrow';
import type { ApplicationError, PaymentGatewayError } from '../errors';
import type { ApplicationLogger } from '../ports/application-logger';
import type { AcceptanceTokens, PaymentGateway } from '../ports/payment-gateway';

export type AcceptanceTokensSource = Pick<PaymentGateway, 'getAcceptanceTokens'>;

// Log fields describe the failure only. Tokens and the provider's own message never reach the log.
const describeFailure = (error: PaymentGatewayError): Record<string, string | boolean> =>
  error.kind === 'REJECTED'
    ? { kind: error.kind, afterTransientFailure: error.afterTransientFailure }
    : { kind: error.kind, reason: error.reason };

export class GetAcceptanceTokens {
  constructor(
    private readonly gateway: AcceptanceTokensSource,
    private readonly logger: ApplicationLogger,
  ) {}

  execute(): ResultAsync<AcceptanceTokens, ApplicationError> {
    return this.gateway.getAcceptanceTokens().mapErr((error): ApplicationError => {
      this.logger.warn('acceptance tokens unavailable', describeFailure(error));
      return { kind: 'PAYMENT_PROVIDER_ERROR' };
    });
  }
}
