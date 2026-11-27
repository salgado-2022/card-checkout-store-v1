import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import { FakeClock } from '../../../../test/support/fake-clock';

const VALID_BODY = {
  fullName: 'Ana Pérez',
  email: 'ana.perez@example.com',
  phone: '3001234567',
  documentType: 'CC',
  documentNumber: '1234567890',
};

const EXPECTED_FIELDS = [
  'createdAt',
  'documentNumber',
  'documentType',
  'email',
  'fullName',
  'id',
  'phone',
  'updatedAt',
];

const CUSTOMER_NOT_FOUND_BODY = {
  statusCode: 404,
  code: 'CUSTOMER_NOT_FOUND',
  message: 'Customer not found.',
  details: [],
};

// Each request needs an email that no earlier request in the same app has used.
let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter += 1;
  return `buyer${emailCounter}@example.com`;
}

describe('CustomersController (HTTP)', () => {
  let app: INestApplication;
  let customers: InMemoryCustomerRepository;
  let clock: FakeClock;

  beforeEach(async () => {
    customers = new InMemoryCustomerRepository();
    clock = new FakeClock('2026-01-15T10:00:00.000Z');
    app = await createCustomersHttpApp({ customers, clock });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/v1/customers', () => {
    it('returns 201 with exactly the customer fields when the email is new', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email: uniqueEmail() });

      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual(EXPECTED_FIELDS);
      expect(response.body).toEqual({
        id: expect.any(String),
        email: expect.stringMatching(/^buyer\d+@example\.com$/),
        fullName: 'Ana Pérez',
        phone: '3001234567',
        documentType: 'CC',
        documentNumber: '1234567890',
        createdAt: '2026-01-15T10:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z',
      });
      expect(customers.count()).toBe(1);
    });

    it('returns 200 and keeps id and createdAt when the normalized email already exists', async () => {
      const email = uniqueEmail();
      const created = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email });
      clock.advance(60_000);

      const updated = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({
          ...VALID_BODY,
          email: `  ${email.toUpperCase()}  `,
          fullName: 'Ana María Pérez',
          phone: '3109876543',
          documentType: 'NIT',
          documentNumber: '900123456',
        });

      expect(updated.status).toBe(200);
      expect(Object.keys(updated.body).sort()).toEqual(EXPECTED_FIELDS);
      expect(updated.body).toEqual({
        id: created.body.id,
        email,
        fullName: 'Ana María Pérez',
        phone: '3109876543',
        documentType: 'NIT',
        documentNumber: '900123456',
        createdAt: created.body.createdAt,
        updatedAt: '2026-01-15T10:01:00.000Z',
      });
      expect(customers.count()).toBe(1);
    });

    it('returns 500 INTERNAL_ERROR without leaking the repository failure', async () => {
      customers.failure = { kind: 'REPOSITORY_ERROR', reason: 'ConditionalCheckFailedException' };

      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send(VALID_BODY);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: [],
      });
      expect(JSON.stringify(response.body)).not.toContain('Conditional');
    });

    it.each([
      ['fullName too short', { fullName: 'AB' }, 'fullName: isLength'],
      ['fullName too long', { fullName: 'A'.repeat(81) }, 'fullName: isLength'],
      ['fullName not a string', { fullName: 123456 }, 'fullName: isString'],
      ['email not an address', { email: 'not-an-email' }, 'email: isEmail'],
      ['email not a string', { email: 12345 }, 'email: isString'],
      [
        'email longer than 120',
        { email: `${'a'.repeat(64)}@${'b'.repeat(50)}.example.com` },
        'email: maxLength',
      ],
      ['phone with 9 digits', { phone: '300123456' }, 'phone: matches'],
      ['phone not starting with 3', { phone: '2001234567' }, 'phone: matches'],
      ['phone with letters', { phone: '300123456a' }, 'phone: matches'],
      ['phone not a string', { phone: 3001234567 }, 'phone: isString'],
      ['documentType not allowed', { documentType: 'DNI' }, 'documentType: isIn'],
    ])('returns 400 VALIDATION_ERROR when %s', async (_label, override, expectedDetail) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email: uniqueEmail(), ...override });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContain(expectedDetail);
      expect(customers.count()).toBe(0);
    });

    it('rejects an email longer than 120 characters with only the length rule', async () => {
      const email = `${'a'.repeat(64)}@${'b'.repeat(50)}.example.com`;

      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email });

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(['email: maxLength']);
    });

    it.each([
      // CC and CE: 6 to 10 digits.
      ['CC', '12345', false],
      ['CC', '123456', true],
      ['CC', '1234567890', true],
      ['CC', '12345678901', false],
      ['CC', 'ABC123', false],
      ['CE', '12345', false],
      ['CE', '123456', true],
      ['CE', '1234567890', true],
      ['CE', '12345678901', false],
      ['CE', '12345a', false],
      // NIT: 9 to 10 digits.
      ['NIT', '12345678', false],
      ['NIT', '123456789', true],
      ['NIT', '1234567890', true],
      ['NIT', '12345678901', false],
      ['NIT', '12345678A', false],
      // PP: 6 to 12 letters or digits.
      ['PP', '12345', false],
      ['PP', 'ABC123', true],
      ['PP', 'ABCDEFGHIJKL', true],
      ['PP', 'ABCDEFGHIJKLM', false],
      ['PP', 'AB-12345', false],
    ])(
      'checks documentNumber for %s "%s" (valid: %s)',
      async (documentType, documentNumber, valid) => {
        const response = await request(app.getHttpServer())
          .post('/api/v1/customers')
          .send({ ...VALID_BODY, email: uniqueEmail(), documentType, documentNumber });

        if (valid) {
          expect(response.status).toBe(201);
          return;
        }
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(response.body.details).toEqual(['documentNumber: isDocumentNumberForType']);
        expect(customers.count()).toBe(0);
      },
    );

    it('rejects a non-string documentNumber for a valid documentType', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email: uniqueEmail(), documentNumber: 1234567890 });

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(['documentNumber: isDocumentNumberForType']);
    });

    it('reports only documentType when documentType is invalid, not documentNumber', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email: uniqueEmail(), documentType: 'DNI', documentNumber: 'x' });

      expect(response.status).toBe(400);
      expect(response.body.details).toEqual(['documentType: isIn']);
    });

    it('rejects a body missing required fields and names each one', async () => {
      const response = await request(app.getHttpServer()).post('/api/v1/customers').send({});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          'fullName: isString',
          'email: isString',
          'phone: isString',
          'documentType: isIn',
        ]),
      );
      expect(response.body.details).not.toContain('documentNumber: isDocumentNumberForType');
    });

    it('rejects an undeclared property with 400 and writes nothing', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email: uniqueEmail(), amount: 1 });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toContain('amount: whitelistValidation');
      expect(customers.count()).toBe(0);
    });
  });

  describe('GET /api/v1/customers/:id', () => {
    it('returns 200 with the customer for an existing id', async () => {
      const email = uniqueEmail();
      const created = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .send({ ...VALID_BODY, email });

      const response = await request(app.getHttpServer()).get(
        `/api/v1/customers/${created.body.id}`,
      );

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(EXPECTED_FIELDS);
      expect(response.body).toEqual(created.body);
    });

    it('returns 404 CUSTOMER_NOT_FOUND for an id that matches no customer', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/customers/01J9Z3K5M7N8P0Q2R4S6T8V0W9',
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual(CUSTOMER_NOT_FOUND_BODY);
    });

    it('returns 500 INTERNAL_ERROR when the repository fails', async () => {
      customers.failure = {
        kind: 'REPOSITORY_ERROR',
        reason: 'ProvisionedThroughputExceededException',
      };

      const response = await request(app.getHttpServer()).get(
        '/api/v1/customers/01J9Z3K5M7N8P0Q2R4S6T8V0W9',
      );

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('Provisioned');
    });
  });
});
