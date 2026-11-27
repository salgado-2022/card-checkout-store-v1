import { preserveBodyParseFailure } from './body-parser-error.middleware';
describe('preserveBodyParseFailure', () => {
  it('re-emits a parse failure as a plain Error that keeps the type and drops the message', () => {
    const next = jest.fn();
    const original = Object.assign(new SyntaxError('Unexpected token in {"card":"hunter2"'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    preserveBodyParseFailure(original, {}, {}, next);
    const forwarded = next.mock.calls[0]?.[0] as Error & { type?: string };
    expect(forwarded).not.toBeInstanceOf(SyntaxError);
    expect(forwarded.type).toBe('entity.parse.failed');
    expect(forwarded.message).not.toContain('hunter2');
  });
  it.each([
    [
      'another body-parser error',
      Object.assign(new Error('too big'), { type: 'entity.too.large' }),
    ],
    ['an error without type', new Error('boom')],
    ['null', null],
  ])('forwards %s unchanged', (_label, error) => {
    const next = jest.fn();
    preserveBodyParseFailure(error, {}, {}, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
