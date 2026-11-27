import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import { GetProduct } from '../../application/use-cases/get-product';
import { GetProducts } from '../../application/use-cases/get-products';
import { DynamoProductRepository } from './product.repository.dynamodb';

const NUM_RUNS = 100;
const TABLE = 'test-products';

// Marker that every generated SDK failure carries in its message, its stack and its properties.
// A trace of the original failure can then be found by searching for the marker.
const marker = fc.stringMatching(/^SDKFAIL[A-Za-z0-9]{16,32}$/);

// Arbitrary rejections: Error objects (with stack), a custom error class, a plain object and a string.
class ProvisionedThroughputFailure extends Error {}

const arbitraryFailure: fc.Arbitrary<unknown> = marker.chain((text) =>
  fc.oneof(
    fc.constant(new Error(`Requested item ${text} failed`)),
    fc.constant(new ProvisionedThroughputFailure(`Throughput exceeded: ${text}`)),
    fc.constant({ message: text, stack: `at fake (${text}.ts:1:1)` }),
    fc.constant(text),
  ),
);

// Assertions shared by every failure path: the Err holds only the kind and a class name.
function expectNoTrace(error: unknown, text: string): void {
  const serialized = JSON.stringify(error);
  expect(serialized).not.toContain(text);
  expect(serialized).not.toMatch(/\bat\s+\S+\s+\(/);
  expect(error).toEqual({ kind: 'REPOSITORY_ERROR', reason: expect.any(String) });
  expect((error as { reason: string }).reason).not.toContain(text);
}

// The marker is recovered from the failure value so each run checks its own message.
function markerOf(failure: unknown): string {
  if (typeof failure === 'string') {
    return failure;
  }
  if (failure instanceof Error) {
    return /SDKFAIL[A-Za-z0-9]+/.exec(failure.message)?.[0] ?? '';
  }
  return (failure as { message: string }).message;
}

describe('Feature: payments-api, Property 43: Unexpected adapter failures are translated, never leaked', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }));
  const repository = new DynamoProductRepository(client, TABLE);

  beforeEach(() => {
    ddb.reset();
  });

  afterAll(() => {
    ddb.restore();
  });

  it('findAll returns Err REPOSITORY_ERROR without the SDK message or stack', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryFailure, async (failure) => {
        ddb.reset();
        ddb.on(ScanCommand).callsFake(() => Promise.reject(failure));

        const outcome = await repository.findAll();

        expect(outcome.isErr()).toBe(true);
        expectNoTrace(outcome._unsafeUnwrapErr(), markerOf(failure));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('findById returns Err REPOSITORY_ERROR without the SDK message or stack', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryFailure,
        fc.stringMatching(/^[a-z0-9]{1,20}$/),
        async (failure, id) => {
          ddb.reset();
          ddb.on(GetCommand).callsFake(() => Promise.reject(failure));

          const outcome = await repository.findById(id);

          expect(outcome.isErr()).toBe(true);
          expectNoTrace(outcome._unsafeUnwrapErr(), markerOf(failure));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('GetProducts use case propagates the adapter Err without the SDK message or stack', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryFailure, async (failure) => {
        ddb.reset();
        ddb.on(ScanCommand).callsFake(() => Promise.reject(failure));

        const outcome = await new GetProducts(repository).execute();

        expect(outcome.isErr()).toBe(true);
        expectNoTrace(outcome._unsafeUnwrapErr(), markerOf(failure));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('GetProduct use case propagates the adapter Err without the SDK message or stack', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryFailure,
        fc.stringMatching(/^[a-z0-9]{1,20}$/),
        async (failure, id) => {
          ddb.reset();
          ddb.on(GetCommand).callsFake(() => Promise.reject(failure));

          const outcome = await new GetProduct(repository).execute(id);

          expect(outcome.isErr()).toBe(true);
          expectNoTrace(outcome._unsafeUnwrapErr(), markerOf(failure));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
