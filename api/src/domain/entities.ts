import type { CardBrand } from './card-brand';
import type { DeliveryStatus } from './delivery-status';
import type { TransactionStatus } from './transaction-status';

export type DocumentType = 'CC' | 'CE' | 'NIT' | 'PP';

export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly priceInCents: number;
  readonly currency: string;
  readonly stock: number;
}

export interface Customer {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Transaction {
  readonly id: string;
  readonly reference: string;
  readonly status: TransactionStatus;
  readonly statusReason?: string;
  readonly productId: string;
  readonly quantity: number;
  readonly customerId: string;
  readonly deliveryId: string;
  readonly unitPriceInCents: number;
  readonly subtotalInCents: number;
  readonly baseFeeInCents: number;
  readonly deliveryFeeInCents: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly installments: number;
  readonly cardBrand: CardBrand;
  readonly cardLastFour: string;
  readonly externalId?: string;
  readonly lastSyncedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt?: string;
}

export interface Delivery {
  readonly id: string;
  readonly transactionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly recipientName: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly department: string;
  readonly postalCode?: string;
  readonly status: DeliveryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
