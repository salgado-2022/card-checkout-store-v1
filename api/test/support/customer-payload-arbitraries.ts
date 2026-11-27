import * as fc from 'fast-check';

export interface CustomerPayload {
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly documentType: 'CC' | 'CE' | 'NIT' | 'PP';
  readonly documentNumber: string;
}

export const documentArbitrary = fc.oneof(
  fc.tuple(fc.constant('CC' as const), fc.stringMatching(/^\d{6,10}$/)),
  fc.tuple(fc.constant('CE' as const), fc.stringMatching(/^\d{6,10}$/)),
  fc.tuple(fc.constant('NIT' as const), fc.stringMatching(/^\d{9,10}$/)),
  fc.tuple(fc.constant('PP' as const), fc.stringMatching(/^[A-Za-z0-9]{6,12}$/)),
);

const localPartArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{2,20}$/);
const domainArbitrary = fc.constantFrom('example.com', 'mail.example.org', 'buyers.example.net');

export const emailArbitrary = fc
  .tuple(localPartArbitrary, domainArbitrary)
  .map(([local, domain]) => `${local}@${domain}`);

// Valid customer payloads only: name 3-80, Colombian mobile phone, document rule per type.
export const customerArbitrary: fc.Arbitrary<CustomerPayload> = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z][A-Za-z ]{1,78}[A-Za-z]$/),
    emailArbitrary,
    fc.stringMatching(/^3\d{9}$/),
    documentArbitrary,
  )
  .map(([fullName, email, phone, [documentType, documentNumber]]) => ({
    fullName,
    email,
    phone,
    documentType,
    documentNumber,
  }));
