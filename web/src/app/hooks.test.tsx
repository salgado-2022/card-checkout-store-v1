import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import { markAppReady, selectAppReady } from './app-slice';
import { useAppDispatch, useAppSelector } from './hooks';
import { createAppStore } from './store';

describe('typed store hooks', () => {
  it('dispatch an action and read the updated state through the typed selector', () => {
    const store = createAppStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(
      () => ({
        dispatch: useAppDispatch(),
        ready: useAppSelector(selectAppReady),
      }),
      { wrapper },
    );

    expect(result.current.ready).toBe(false);

    act(() => {
      result.current.dispatch(markAppReady());
    });

    expect(result.current.ready).toBe(true);
  });
});
