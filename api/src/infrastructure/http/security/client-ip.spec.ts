import { clientIpTracker, deriveClientIp } from './client-ip';

describe('deriveClientIp', () => {
  it('removes the port from an IPv4 value', () => {
    expect(deriveClientIp('203.0.113.7:46532', '10.0.0.1')).toBe('203.0.113.7');
  });

  it('removes only the last segment from an IPv6 value with port', () => {
    expect(deriveClientIp('2001:db8::1:443', '10.0.0.1')).toBe('2001:db8::1');
  });

  it('keeps the brackets of a bracketed IPv6 value with port', () => {
    expect(deriveClientIp('[2001:db8::1]:443', '10.0.0.1')).toBe('[2001:db8::1]');
  });

  it('keeps an IPv6 value without port when the last colon is inside the address', () => {
    expect(deriveClientIp('2001:db8::1:', '10.0.0.1')).toBe('2001:db8::1');
  });

  it('uses the socket address when the header is missing', () => {
    expect(deriveClientIp(undefined, '203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the socket address when the header is empty', () => {
    expect(deriveClientIp('', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the socket address when the header has no colon', () => {
    expect(deriveClientIp('203.0.113.7', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the socket address when the colon is the first character', () => {
    expect(deriveClientIp(':443', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the first element when the header is an array', () => {
    expect(deriveClientIp(['203.0.113.7:1', '198.51.100.2:2'], '10.0.0.1')).toBe('203.0.113.7');
  });

  it('uses the socket address when the header array is empty', () => {
    expect(deriveClientIp([], '203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the socket address when the array first element is empty', () => {
    expect(deriveClientIp([''], '203.0.113.9')).toBe('203.0.113.9');
  });

  it('returns unknown when neither the header nor the socket address is available', () => {
    expect(deriveClientIp(undefined, undefined)).toBe('unknown');
  });

  it('returns unknown when the socket address is empty and the header is absent', () => {
    expect(deriveClientIp(undefined, '')).toBe('unknown');
  });

  it('returns the header value without port when the socket is undefined', () => {
    expect(deriveClientIp('203.0.113.7:1', undefined)).toBe('203.0.113.7');
  });
});

describe('clientIpTracker', () => {
  it('reads CloudFront-Viewer-Address and returns the Client_IP', async () => {
    await expect(
      clientIpTracker({
        headers: { 'cloudfront-viewer-address': '203.0.113.7:46532' },
        socket: { remoteAddress: '10.0.0.1' },
      }),
    ).resolves.toBe('203.0.113.7');
  });

  it('falls back to the socket address when the viewer header is absent', async () => {
    await expect(
      clientIpTracker({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }),
    ).resolves.toBe('203.0.113.9');
  });

  it('returns unknown when there is no socket object and no header', async () => {
    await expect(clientIpTracker({ headers: {} })).resolves.toBe('unknown');
  });
  it('returns unknown when the request carries neither headers nor a socket', async () => {
    await expect(clientIpTracker({})).resolves.toBe('unknown');
  });

  it('ignores a client-sent X-Forwarded-For header', async () => {
    await expect(
      clientIpTracker({
        headers: {
          'cloudfront-viewer-address': '203.0.113.7:46532',
          'x-forwarded-for': '198.51.100.99',
        },
        socket: { remoteAddress: '10.0.0.1' },
      }),
    ).resolves.toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For when the viewer header is absent', async () => {
    await expect(
      clientIpTracker({
        headers: { 'x-forwarded-for': '198.51.100.99' },
        socket: { remoteAddress: '203.0.113.9' },
      }),
    ).resolves.toBe('203.0.113.9');
  });
});
