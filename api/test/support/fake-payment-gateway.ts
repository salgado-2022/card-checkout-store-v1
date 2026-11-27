import { err, type Result, ResultAsync } from 'neverthrow';
import type { PaymentGatewayError } from '../../src/application/errors';
import type {
  AcceptanceTokens,
  PaymentCreateRequest,
  PaymentCreateResponse,
  PaymentGateway,
  ProviderStatusReport,
  ReconciliationOutcome,
} from '../../src/application/ports/payment-gateway';

export type GatewayMethod = 'getAcceptanceTokens' | 'create' | 'getStatus' | 'findByReference';

/** Scripted responses and recorded arguments for one gateway method. */
export class MethodScript<TArgs extends readonly unknown[], TValue> {
  /** Arguments of every call to this method, in order. */
  readonly calls: TArgs[] = [];
  private readonly queue: Result<TValue, PaymentGatewayError>[] = [];
  private fallback: Result<TValue, PaymentGatewayError> | null = null;

  /** Responses are consumed one per call, in order. */
  enqueue(...responses: Result<TValue, PaymentGatewayError>[]): this {
    this.queue.push(...responses);
    return this;
  }

  /** Response used for every call once the queue is empty. */
  always(response: Result<TValue, PaymentGatewayError>): this {
    this.fallback = response;
    return this;
  }

  next(args: TArgs): Result<TValue, PaymentGatewayError> {
    this.calls.push(args);
    return (
      this.queue.shift() ??
      this.fallback ??
      err({ kind: 'INVALID_RESPONSE', reason: 'unscripted_call' })
    );
  }
}

/**
 * Payment gateway with scriptable answers per method. Every call is recorded, both per method
 * (`script.<method>.calls`) and in global order (`callLog`), so tests can assert that
 * `findByReference` or `create` were never called. A call with nothing scripted answers
 * `INVALID_RESPONSE` / `unscripted_call`.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly script = {
    getAcceptanceTokens: new MethodScript<[], AcceptanceTokens>(),
    create: new MethodScript<[PaymentCreateRequest], PaymentCreateResponse>(),
    getStatus: new MethodScript<[string], ProviderStatusReport>(),
    findByReference: new MethodScript<[string], ReconciliationOutcome>(),
  };
  readonly callLog: GatewayMethod[] = [];

  getAcceptanceTokens() {
    this.callLog.push('getAcceptanceTokens');
    return this.answer(this.script.getAcceptanceTokens.next([]));
  }

  create(request: PaymentCreateRequest) {
    this.callLog.push('create');
    return this.answer(this.script.create.next([request]));
  }

  getStatus(externalId: string) {
    this.callLog.push('getStatus');
    return this.answer(this.script.getStatus.next([externalId]));
  }

  findByReference(reference: string) {
    this.callLog.push('findByReference');
    return this.answer(this.script.findByReference.next([reference]));
  }

  callCount(method: GatewayMethod): number {
    return this.callLog.filter((called) => called === method).length;
  }

  private answer<T>(result: Result<T, PaymentGatewayError>): ResultAsync<T, PaymentGatewayError> {
    return new ResultAsync(Promise.resolve(result));
  }
}
