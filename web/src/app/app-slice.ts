import { createSlice } from '@reduxjs/toolkit';

// Placeholder slice. It proves the store wiring until the feature slices exist.
export interface AppState {
  ready: boolean;
}

const initialState: AppState = { ready: false };

export const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    markAppReady(state) {
      state.ready = true;
    },
  },
});

export const { markAppReady } = appSlice.actions;
export const appReducer = appSlice.reducer;

export const selectAppReady = (state: { app: AppState }): boolean => state.app.ready;
