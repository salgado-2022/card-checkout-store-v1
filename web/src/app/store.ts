import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { appReducer } from './app-slice';

const rootReducer = combineReducers({
  app: appReducer,
});

// A factory keeps each test on its own store. The app uses the shared `store` instance below.
export function createAppStore() {
  return configureStore({ reducer: rootReducer });
}

export const store = createAppStore();

export type RootState = ReturnType<typeof rootReducer>;
export type AppStore = ReturnType<typeof createAppStore>;
export type AppDispatch = AppStore['dispatch'];
