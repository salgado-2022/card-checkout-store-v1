import {
  canTransitionTransaction,
  FINAL_STATUSES,
  isFinalStatus,
  TRANSACTION_STATUSES,
  type TransactionStatus,
} from './transaction-status';

describe('TransactionStatus', () => {
  it('lists the five statuses and the four final ones', () => {
    expect(TRANSACTION_STATUSES).toEqual(['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR']);
    expect(FINAL_STATUSES).toEqual(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']);
  });

  it('identifies final statuses', () => {
    expect(isFinalStatus('PENDING')).toBe(false);
    expect(isFinalStatus('APPROVED')).toBe(true);
    expect(isFinalStatus('ERROR')).toBe(true);
  });

  it.each(FINAL_STATUSES)('allows PENDING to %s', (to) => {
    expect(canTransitionTransaction('PENDING', to)).toBe(true);
  });

  it('rejects a transition back to PENDING', () => {
    expect(canTransitionTransaction('PENDING', 'PENDING')).toBe(false);
  });

  it.each(FINAL_STATUSES)('rejects leaving the final status %s', (from) => {
    for (const to of TRANSACTION_STATUSES) {
      expect(canTransitionTransaction(from, to)).toBe(false);
    }
  });

  it('allows exactly the PENDING-to-final moves', () => {
    const allowed: Array<[TransactionStatus, TransactionStatus]> = [];
    for (const from of TRANSACTION_STATUSES) {
      for (const to of TRANSACTION_STATUSES) {
        if (canTransitionTransaction(from, to)) allowed.push([from, to]);
      }
    }
    expect(allowed).toHaveLength(FINAL_STATUSES.length);
    expect(allowed.every(([from]) => from === 'PENDING')).toBe(true);
  });
});
