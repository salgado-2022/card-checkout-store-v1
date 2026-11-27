import type { ServerResponse } from 'node:http';
import { noStoreMiddleware } from './no-store.middleware';
describe('noStoreMiddleware', () => {
  it('sets Cache-Control: no-store and calls next', () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    noStoreMiddleware({}, { setHeader } as unknown as ServerResponse, next);
    expect(setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
