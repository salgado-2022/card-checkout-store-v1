/**
 * @jest-environment node
 */
// msw v2+ needs the Fetch API globals (Request, Response, TextEncoder), which the node test
// environment provides. The jsdom environment does not, so this file runs under node.
import { err, ok } from 'neverthrow';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { apiRequest } from './client';

type ViteEnvGlobal = { __VITE_ENV__?: Record<string, string> };

const API_BASE = 'https://api.test/api/v1';
const server = setupServer();

function setApiBase(value: string | undefined): void {
  (globalThis as ViteEnvGlobal).__VITE_ENV__ =
    value === undefined ? undefined : { VITE_API_BASE: value };
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

beforeEach(() => {
  setApiBase(API_BASE);
});

afterEach(() => {
  server.resetHandlers();
  setApiBase(undefined);
  jest.restoreAllMocks();
});

afterAll(() => server.close());

describe('apiRequest', () => {
  it('builds the URL from VITE_API_BASE and returns the parsed JSON body', async () => {
    let requestedUrl = '';
    server.use(
      http.get(`${API_BASE}/products`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([{ id: 'prod_1' }]);
      }),
    );

    const result = await apiRequest<{ id: string }[]>('/products');

    expect(requestedUrl).toBe(`${API_BASE}/products`);
    expect(result).toEqual(ok([{ id: 'prod_1' }]));
  });

  it('sends a JSON body, the Idempotency-Key header and the JSON content type on POST', async () => {
    server.use(
      http.post(`${API_BASE}/transactions`, async ({ request }) => {
        const received = await request.json();
        return HttpResponse.json({
          received,
          contentType: request.headers.get('content-type'),
          idempotencyKey: request.headers.get('idempotency-key'),
        });
      }),
    );

    const result = await apiRequest<unknown>('/transactions', {
      method: 'POST',
      body: { quantity: 2 },
      headers: { 'Idempotency-Key': 'key-1' },
    });

    expect(result).toEqual(
      ok({
        received: { quantity: 2 },
        contentType: 'application/json',
        idempotencyKey: 'key-1',
      }),
    );
  });

  it('sends no body and no content type on GET', async () => {
    let contentType: string | null = 'unset';
    server.use(
      http.get(`${API_BASE}/fees`, ({ request }) => {
        contentType = request.headers.get('content-type');
        return HttpResponse.json({ baseFeeInCents: 300000 });
      }),
    );

    await apiRequest('/fees');

    expect(contentType).toBeNull();
  });

  it('returns an http Err with the parsed error body for a 4xx JSON response', async () => {
    const errorBody = {
      statusCode: 404,
      code: 'PRODUCT_NOT_FOUND',
      message: 'Product not found',
      details: [],
    };
    server.use(
      http.get(`${API_BASE}/products/missing`, () => HttpResponse.json(errorBody, { status: 404 })),
    );

    const result = await apiRequest('/products/missing');

    expect(result).toEqual(err({ kind: 'http', status: 404, body: errorBody }));
  });

  it('returns an http Err with the raw text when the error body is not JSON', async () => {
    server.use(
      http.get(
        `${API_BASE}/acceptance-tokens`,
        () =>
          new HttpResponse('<html>Bad gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    const result = await apiRequest('/acceptance-tokens');

    expect(result).toEqual(err({ kind: 'http', status: 502, body: '<html>Bad gateway</html>' }));
  });

  it('returns an invalid-json Err when a successful response is not JSON', async () => {
    server.use(http.get(`${API_BASE}/health`, () => new HttpResponse('ok', { status: 200 })));

    const result = await apiRequest('/health');

    expect(result).toEqual(err({ kind: 'invalid-json', status: 200 }));
  });

  it('returns a network Err when the request fails before a response arrives', async () => {
    server.use(http.get(`${API_BASE}/products`, () => HttpResponse.error()));

    const result = await apiRequest('/products');

    expect(result).toEqual(err({ kind: 'network' }));
  });

  it('falls back to /api/v1 when VITE_API_BASE is not set', async () => {
    setApiBase(undefined);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(HttpResponse.json({ status: 'ok' }));

    const result = await apiRequest('/health');

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual(ok({ status: 'ok' }));
  });
});
