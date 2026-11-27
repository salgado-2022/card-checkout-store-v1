export const TRANSACTION_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const FINAL_STATUSES = ['APPROVED', 'DECLINED', 'VOIDED', 'ERROR'] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

export function isFinalStatus(status: TransactionStatus): status is FinalStatus {
  return (FINAL_STATUSES as readonly TransactionStatus[]).includes(status);
}

/** A Transaction moves only from PENDING to one Final_Status (Requirement 10.7). */
export function canTransitionTransaction(from: TransactionStatus, to: TransactionStatus): boolean {
  return from === 'PENDING' && isFinalStatus(to);
}
