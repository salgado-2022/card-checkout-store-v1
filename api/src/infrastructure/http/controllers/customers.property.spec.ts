import type { INestApplication } from '@nestjs/common';
import * as fc from 'fast-check';
import request from 'supertest';
import { createCustomersHttpApp } from '../../../../test/support/customers-http-app';
import { FakeClock } from '../../../../test/support/fake-clock';
import { InMemoryCustomerRepository } from '../../../../test/support/in-memory-customer-repository';
import {
  customerArbitrary,
  emailArbitrary,
} from '../../../../test/support/customer-payload-arbitraries';

const NUM_RUNS = 25;
const PROPERTY_TIMEOUT_MS = 60_000;
const CLOCK_STEP_MS = 60_000;
const CUSTOMERS_PATH = '/api/v1/customers';

// Equivalent email variants of one address: random casing per character and up to three spaces
// or tabs on each side. Every variant stays well under the 120 character limit.
function equivalentEmailArbitrary(email: string): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }),
      fc.stringMatching(/^[ \t]{0,3}$/),
      fc.stringMatching(/^[ \t]{0,3}$/),
    )
    .map(([upperMask, leading, trailing]) => {
      const cased = [...email]
        .map((char, index) =>
          upperMask[index % upperMask.length] ? char.toUpperCase() : char.toLowerCase(),
        )
        .join('');
      return `${leading}${cased}${trailing}`;
    });
}

// Feature: payments-api, Property 6: Customer upsert is a normalized-email round trip
describe('Feature: payments-api, Property 6: Customer upsert is a normalized-email round trip', () => {
  it(
    'updates the same record for an equivalent email and creates a record for an unseen email',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          customerArbitrary.chain((created) =>
            fc.tuple(
              fc.constant(created),
              equivalentEmailArbitrary(created.email),
              customerArbitrary,
              emailArbitrary,
            ),
          ),
          async ([created, variant, update, otherEmail]) => {
            const normalizedEmail = created.email.toLowerCase();
            fc.pre(otherEmail !== normalizedEmail);

            // A fresh repository and app per run keep runs from contaminating each other.
            const customers = new InMemoryCustomerRepository();
            const clock = new FakeClock('2026-01-15T10:00:00.000Z');
            const app: INestApplication = await createCustomersHttpApp({ customers, clock });

            try {
              const server = app.getHttpServer();

              const first = await request(server).post(CUSTOMERS_PATH).send(created);
              expect(first.status).toBe(201);
              const firstBody = first.body as Record<string, string>;
              expect(firstBody['email']).toBe(normalizedEmail);

              clock.advance(CLOCK_STEP_MS);
              const second = await request(server)
                .post(CUSTOMERS_PATH)
                .send({ ...update, email: variant });
              expect(second.status).toBe(200);
              const secondBody = second.body as Record<string, string>;
              expect(secondBody['id']).toBe(firstBody['id']);
              expect(secondBody['createdAt']).toBe(firstBody['createdAt']);
              expect(secondBody['updatedAt']).toBe(clock.now().toISOString());
              expect(secondBody['email']).toBe(normalizedEmail);
              expect(secondBody['fullName']).toBe(update.fullName);
              expect(secondBody['phone']).toBe(update.phone);
              expect(customers.count()).toBe(1);

              const detail = await request(server).get(`${CUSTOMERS_PATH}/${firstBody['id']}`);
              expect(detail.status).toBe(200);
              expect(detail.body).toEqual(secondBody);

              const unseen = await request(server)
                .post(CUSTOMERS_PATH)
                .send({ ...created, email: otherEmail });
              expect(unseen.status).toBe(201);
              expect((unseen.body as Record<string, string>)['id']).not.toBe(firstBody['id']);
              expect(customers.count()).toBe(2);
            } finally {
              await app.close();
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
