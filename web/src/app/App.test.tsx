import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { App } from './App';
import { createAppStore } from './store';

describe('App', () => {
  it('renders the Spanish page title inside the store provider', () => {
    render(
      <Provider store={createAppStore()}>
        <App />
      </Provider>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Tienda de productos' })).toBeVisible();
  });
});
