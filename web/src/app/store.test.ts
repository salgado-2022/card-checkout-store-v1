import { markAppReady, selectAppReady } from './app-slice';
import { createAppStore } from './store';

describe('app store', () => {
  it('starts with the app not ready', () => {
    const store = createAppStore();
    expect(selectAppReady(store.getState())).toBe(false);
  });

  it('updates the state when an action is dispatched', () => {
    const store = createAppStore();
    store.dispatch(markAppReady());
    expect(selectAppReady(store.getState())).toBe(true);
  });

  it('keeps separate state for each store instance', () => {
    const first = createAppStore();
    const second = createAppStore();
    first.dispatch(markAppReady());
    expect(selectAppReady(second.getState())).toBe(false);
  });
});
