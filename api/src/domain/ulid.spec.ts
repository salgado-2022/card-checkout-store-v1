import { isUlid } from './ulid';

describe('isUlid', () => {
  it.each([
    '01HZX0000000000000000000EF',
    '7ZZZZZZZZZZZZZZZZZZZZZZZZZ',
    '00000000000000000000000000',
  ])('accepts the ULID %s', (value) => {
    expect(isUlid(value)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['too short', '01HZX0000000000000000000E'],
    ['too long', '01HZX0000000000000000000EFA'],
    ['first character above 7', '81HZX0000000000000000000EF'],
    ['lowercase letters', '01hzx0000000000000000000ef'],
    ['excluded letter I', '01HZX000000000000000000IEF'],
    ['excluded letter U', '01HZX00000000000000000000U'],
    ['prefixed reference', 'ORD-01HZX0000000000000000000EF'],
    ['unicode digit lookalike', '01HZX000000000000000000０EF'],
    ['path traversal', '../../../../etc/passwd'],
    ['newline suffix', '01HZX0000000000000000000EF\n'],
  ])('rejects %s', (_label, value) => {
    expect(isUlid(value)).toBe(false);
  });
});
