import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { resetSsmParameterCacheForTests, SsmParameterReader } from './ssm-parameter-reader';

const FAKE_PARAMETER = '/test-project/payment/fake-parameter';
const FAKE_OTHER_PARAMETER = '/test-project/payment/other-fake-parameter';
const FAKE_VALUE = 'fake-parameter-value-123';

describe('SsmParameterReader', () => {
  const ssm = mockClient(SSMClient);

  beforeEach(() => {
    ssm.reset();
    resetSsmParameterCacheForTests();
  });

  afterAll(() => {
    ssm.restore();
  });

  it('reads the parameter with decryption and returns its value', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });

    const result = await new SsmParameterReader().load(FAKE_PARAMETER);

    expect(result._unsafeUnwrap()).toBe(FAKE_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({
      Name: FAKE_PARAMETER,
      WithDecryption: true,
    });
  });

  it('caches the value per parameter name across reader instances', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });

    await new SsmParameterReader().load(FAKE_PARAMETER);
    const second = await new SsmParameterReader().load(FAKE_PARAMETER);

    expect(second._unsafeUnwrap()).toBe(FAKE_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('keeps separate cache entries for different parameter names', async () => {
    ssm.on(GetParameterCommand, { Name: FAKE_PARAMETER }).resolves({
      Parameter: { Value: FAKE_VALUE },
    });
    ssm.on(GetParameterCommand, { Name: FAKE_OTHER_PARAMETER }).resolves({
      Parameter: { Value: 'other-fake-value' },
    });

    const reader = new SsmParameterReader();
    const first = await reader.load(FAKE_PARAMETER);
    const other = await reader.load(FAKE_OTHER_PARAMETER);

    expect(first._unsafeUnwrap()).toBe(FAKE_VALUE);
    expect(other._unsafeUnwrap()).toBe('other-fake-value');
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });
    const reader = new SsmParameterReader();

    const results = await Promise.all([
      reader.load(FAKE_PARAMETER),
      reader.load(FAKE_PARAMETER),
      reader.load(FAKE_PARAMETER),
    ]);

    expect(results.map((result) => result._unsafeUnwrap())).toEqual([
      FAKE_VALUE,
      FAKE_VALUE,
      FAKE_VALUE,
    ]);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('does not cache a failure, so the next call asks SSM again', async () => {
    ssm
      .on(GetParameterCommand)
      .rejectsOnce(new Error('transient'))
      .resolves({ Parameter: { Value: FAKE_VALUE } });
    const reader = new SsmParameterReader();

    const first = await reader.load(FAKE_PARAMETER);
    const second = await reader.load(FAKE_PARAMETER);

    expect(first.isErr()).toBe(true);
    expect(second._unsafeUnwrap()).toBe(FAKE_VALUE);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it('returns an Err with the parameter name and exception class only, never the value', async () => {
    const failure = new Error(`denied while reading ${FAKE_VALUE}`);
    failure.name = 'AccessDeniedException';
    ssm.on(GetParameterCommand).rejects(failure);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleSpies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    const error = (await new SsmParameterReader().load(FAKE_PARAMETER))._unsafeUnwrapErr();

    expect(error).toEqual({
      kind: 'SSM_PARAMETER_UNAVAILABLE',
      parameterName: FAKE_PARAMETER,
      reason: 'AccessDeniedException',
    });
    expect(JSON.stringify(error)).not.toContain(FAKE_VALUE);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
    stdout.mockRestore();
    stderr.mockRestore();
    consoleSpies.forEach((spy) => spy.mockRestore());
  });

  it('reports a non-Error rejection as UnknownError', async () => {
    ssm.on(GetParameterCommand).callsFake(() => Promise.reject('plain string'));

    const error = (await new SsmParameterReader().load(FAKE_PARAMETER))._unsafeUnwrapErr();

    expect(error.reason).toBe('UnknownError');
  });

  it.each([
    ['missing Parameter', {}],
    ['missing Value', { Parameter: {} }],
    ['empty Value', { Parameter: { Value: '' } }],
  ])('returns an Err when SSM answers with %s', async (_label, output) => {
    ssm.on(GetParameterCommand).resolves(output);

    const error = (await new SsmParameterReader().load(FAKE_PARAMETER))._unsafeUnwrapErr();

    expect(error.parameterName).toBe(FAKE_PARAMETER);
    expect(error.reason).toBe('EmptyParameter');
  });

  it('uses an injected SSM client when provided', async () => {
    const client = new SSMClient({ region: 'us-east-2' });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });

    const result = await new SsmParameterReader(client).load(FAKE_PARAMETER);

    expect(result._unsafeUnwrap()).toBe(FAKE_VALUE);
  });

  describe('peek', () => {
    it('returns undefined before a load completes', () => {
      expect(new SsmParameterReader().peek(FAKE_PARAMETER)).toBeUndefined();
    });

    it('returns the cached value after a load completes', async () => {
      ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });
      const reader = new SsmParameterReader();

      await reader.load(FAKE_PARAMETER);

      expect(reader.peek(FAKE_PARAMETER)).toBe(FAKE_VALUE);
      expect(reader.peek(FAKE_OTHER_PARAMETER)).toBeUndefined();
    });
  });

  it('clears the cache when reset for tests', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: FAKE_VALUE } });
    const reader = new SsmParameterReader();
    await reader.load(FAKE_PARAMETER);

    resetSsmParameterCacheForTests();

    expect(reader.peek(FAKE_PARAMETER)).toBeUndefined();
    await reader.load(FAKE_PARAMETER);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });
});
