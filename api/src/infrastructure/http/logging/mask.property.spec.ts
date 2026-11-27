import * as fc from 'fast-check';
import { maskDocumentNumber, maskEmail } from './mask';

// Feature: payments-api, Property 39: Log masking is a pure, lossy function of its input
describe('Feature: payments-api, Property 39: Log masking is a pure, lossy function of its input', () => {
  const NUM_RUNS = 100;
  const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const LOCAL_CHARS = `${ALNUM}._+-`;
  const DOMAIN_CHARS = `${ALNUM}.-`;

  const fromChars = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
    fc.array(fc.constantFrom(...chars), { minLength, maxLength }).map((parts) => parts.join(''));

  // Local parts never contain '*' or '@', so the masked output is unambiguous.
  const localPart = fromChars(LOCAL_CHARS, 2, 30);
  const domainPart = fromChars(DOMAIN_CHARS, 1, 30).map((domain) => `${domain}.com`);
  const email = fc
    .tuple(localPart, domainPart)
    .map(([local, domain]) => ({ local, domain, value: `${local}@${domain}` }));

  const documentNumber = fromChars(ALNUM, 4, 30);

  describe('maskEmail', () => {
    it('keeps the first local character, then ***, then the unchanged domain', () => {
      fc.assert(
        fc.property(email, ({ local, domain }) => {
          expect(maskEmail(`${local}@${domain}`)).toBe(`${local.charAt(0)}***@${domain}`);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('never leaks the full local part', () => {
      fc.assert(
        fc.property(email, ({ local, domain, value }) => {
          const masked = maskEmail(value);
          const maskedLocal = masked.slice(0, masked.lastIndexOf('@'));
          expect(maskedLocal).not.toContain(local);
          expect(masked).not.toBe(value);
          expect(masked.endsWith(`@${domain}`)).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('maskDocumentNumber', () => {
    it('keeps the length and the last three characters, and replaces every other character with *', () => {
      fc.assert(
        fc.property(documentNumber, (document) => {
          const masked = maskDocumentNumber(document);
          const hidden = document.length - 3;
          expect(masked.length).toBe(document.length);
          expect(masked.slice(-3)).toBe(document.slice(-3));
          expect(masked.slice(0, hidden)).toBe('*'.repeat(hidden));
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('never leaks the full document value', () => {
      fc.assert(
        fc.property(documentNumber, (document) => {
          expect(maskDocumentNumber(document)).not.toBe(document);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  it('is pure: the same input always produces the same output', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, other) => {
        expect(maskEmail(text)).toBe(maskEmail(text));
        expect(maskDocumentNumber(text)).toBe(maskDocumentNumber(text));
        expect(maskEmail(other)).toBe(maskEmail(other));
        expect(maskDocumentNumber(other)).toBe(maskDocumentNumber(other));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: payments-api, Property 39: Log masking is a pure, lossy function of its input (documented edge cases)
describe('Feature: payments-api, Property 39: Log masking is a pure, lossy function of its input (documented edge cases)', () => {
  const NUM_RUNS = 100;
  const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  it('masks a one-character local part as *, keeping the domain unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALNUM),
        fc.constantFrom('example.com', 'mail.co', 'a.b.c.d'),
        (localChar, domain) => {
          expect(maskEmail(`${localChar}@${domain}`)).toBe(`*@${domain}`);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('masks a document of 1 to 3 characters entirely, keeping its length', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 3 }), (chars) => {
        const document = chars.join('');
        expect(maskDocumentNumber(document)).toBe('*'.repeat(document.length));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('masks a value without @ entirely, and returns an empty email unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((text) => !text.includes('@')),
        (text) => {
          expect(maskEmail(text)).toBe('***');
        },
      ),
      { numRuns: NUM_RUNS },
    );
    expect(maskEmail('')).toBe('');
  });

  it('returns an empty document unchanged', () => {
    expect(maskDocumentNumber('')).toBe('');
  });
});
