import type { CardBrand } from '../../domain/card-brand';
import type { Transaction } from '../../domain/entities';

/** Response shape of Requirement 5.14: nothing else is ever exposed. */
export interface TransactionResponseBody {
  readonly id: string;
  readonly reference: string;
  readonly status: Transaction['status'];
  readonly amounts: {
    readonly currency: string;
    readonly subtotalInCents: number;
    readonly baseFeeInCents: number;
    readonly deliveryFeeInCents: number;
    readonly totalInCents: number;
  };
  readonly deliveryId: string;
  readonly card: { readonly brand: CardBrand; readonly lastFour: string };
  readonly createdAt: string;
}

/** Response of `GET /transactions/:id`: the create shape plus the state and the request data. */
export interface TransactionDetailBody extends TransactionResponseBody {
  readonly statusReason?: string;
  readonly productId: string;
  readonly quantity: number;
  readonly installments: number;
  readonly updatedAt: string;
  readonly finalizedAt?: string;
}

/**
 * Shared whitelist mapper for every Transaction response. Only the listed fields leave the
 * application: never the External_Id, the card token, `lastSyncedAt` or any card data other than
 * brand and last four digits. The create response and the stored replay body use this function.
 */
export function toTransactionResponse(transaction: Transaction): TransactionResponseBody {
  return {
    id: transaction.id,
    reference: transaction.reference,
    status: transaction.status,
    amounts: {
      currency: transaction.currency,
      subtotalInCents: transaction.subtotalInCents,
      baseFeeInCents: transaction.baseFeeInCents,
      deliveryFeeInCents: transaction.deliveryFeeInCents,
      totalInCents: transaction.totalInCents,
    },
    deliveryId: transaction.deliveryId,
    card: { brand: transaction.cardBrand, lastFour: transaction.cardLastFour },
    createdAt: transaction.createdAt,
  };
}

/** Adds the state and request fields of `GET /transactions/:id` to the shared shape. */
export function toTransactionDetailResponse(transaction: Transaction): TransactionDetailBody {
  return {
    ...toTransactionResponse(transaction),
    ...(transaction.statusReason === undefined ? {} : { statusReason: transaction.statusReason }),
    productId: transaction.productId,
    quantity: transaction.quantity,
    installments: transaction.installments,
    updatedAt: transaction.updatedAt,
    ...(transaction.finalizedAt === undefined ? {} : { finalizedAt: transaction.finalizedAt }),
  };
}
