import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import {
  createOriginSecretProvider,
  describeOriginSecretError,
  ORIGIN_SECRET_PROVIDER,
  OriginSecretProvider,
  resetOriginSecretCacheForTests,
} from './origin-secret.provider';

const PARAM = '/test-project/origin/verify-secret';
const SECRET_VALUE = 'fake-origin-secret-value-123';

describe('OriginSecretProvider', () => {
  const ssm = mockClient(SSMClient);

  beforeEach(() => {
    ssm.reset();
    resetOriginSecretCacheForTests();
  });

  afterAll(() => {
    ssm.restore();
  });

  it('reads the parameter from SSM with decryption on the first call', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });

    const result = await new OriginSecretProvider(PARAM).load();

    expect(result._unsafeUnwrap()).toBe(SECRET_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({
      Name: PARAM,
      WithDecryption: true,
    });
  });

  it('reuses the cached value on later calls and across provider instances', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });

    await new OriginSecretProvider(PARAM).load();
    const second = await new OriginSecretProvider(PARAM).load();
    const third = await new OriginSecretProvider(PARAM).load();

    expect(second._unsafeUnwrap()).toBe(SECRET_VALUE);
    expect(third._unsafeUnwrap()).toBe(SECRET_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });
    const provider = new OriginSecretProvider(PARAM);

    const results = await Promise.all([provider.load(), provider.load(), provider.load()]);

    expect(results.map((r) => r._unsafeUnwrap())).toEqual([
      SECRET_VALUE,
      SECRET_VALUE,
      SECRET_VALUE,
    ]);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('returns an Err naming the parameter, without the value, when SSM fails', async () => {
    const failure = new Error(`boom ${SECRET_VALUE}`);
    failure.name = 'AccessDeniedException';
    ssm.on(GetParameterCommand).rejects(failure);

    const result = await new OriginSecretProvider(PARAM).load();

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe('ORIGIN_SECRET_UNAVAILABLE');
    expect(error.parameterName).toBe(PARAM);
    expect(error.reason).toBe('AccessDeniedException');
    const logged = describeOriginSecretError(error);
    expect(logged).toContain(PARAM);
    expect(logged).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(error)).not.toContain(SECRET_VALUE);
  });

  it('does not cache a failure, so a later call retries SSM', async () => {
    ssm
      .on(GetParameterCommand)
      .rejectsOnce(new Error('transient'))
      .resolves({ Parameter: { Value: SECRET_VALUE } });
    const provider = new OriginSecretProvider(PARAM);

    const first = await provider.load();
    const second = await provider.load();

    expect(first.isErr()).toBe(true);
    expect(second._unsafeUnwrap()).toBe(SECRET_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('reports a non-Error rejection as UnknownError', async () => {
    ssm.on(GetParameterCommand).callsFake(() => Promise.reject('plain string'));

    const result = await new OriginSecretProvider(PARAM).load();

    expect(result._unsafeUnwrapErr().reason).toBe('UnknownError');
  });

  it.each([
    ['missing Parameter', {}],
    ['missing Value', { Parameter: {} }],
    ['empty Value', { Parameter: { Value: '' } }],
  ])('returns an Err when SSM answers with %s', async (_label, output) => {
    ssm.on(GetParameterCommand).resolves(output);

    const result = await new OriginSecretProvider(PARAM).load();

    const error = result._unsafeUnwrapErr();
    expect(error.parameterName).toBe(PARAM);
    expect(error.reason).toBe('EmptyParameter');
  });

  describe('get', () => {
    it('returns Err naming the parameter before load completes', () => {
      const result = new OriginSecretProvider(PARAM).get();

      const error = result._unsafeUnwrapErr();
      expect(error.kind).toBe('ORIGIN_SECRET_NOT_LOADED');
      expect(error.parameterName).toBe(PARAM);
    });

    it('returns the cached value after load', async () => {
      ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });
      const provider = new OriginSecretProvider(PARAM);

      await provider.load();

      expect(provider.get()._unsafeUnwrap()).toBe(SECRET_VALUE);
    });
  });

  it('uses an injected SSM client when provided', async () => {
    const client = new SSMClient({ region: 'us-east-1' });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });

    const result = await new OriginSecretProvider(PARAM, client).load();

    expect(result._unsafeUnwrap()).toBe(SECRET_VALUE);
  });

  it('builds the provider from the app config and exposes a DI token', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET_VALUE } });

    const provider = createOriginSecretProvider({ originVerifySecretParam: PARAM });

    expect((await provider.load())._unsafeUnwrap()).toBe(SECRET_VALUE);
    expect(typeof ORIGIN_SECRET_PROVIDER).toBe('symbol');
  });
});
