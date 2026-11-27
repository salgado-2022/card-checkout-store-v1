import { createReference, isValidReference } from './reference';

describe('Reference', () => {
  it('accepts ORD- followed by a 26-character uppercase ULID', () => {
    expect(isValidReference('ORD-01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['missing prefix', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['wrong prefix', 'TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['lowercase prefix', 'ord-01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['ULID too short', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FA'],
    ['ULID too long', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FAVX'],
    ['lowercase ULID', 'ORD-01arz3ndektsv4rrffq69g5fav'],
    ['ULID first char above 7', 'ORD-81ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['excluded letter I', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FAI'],
    ['excluded letter U', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FAU'],
    ['trailing whitespace', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FAV '],
  ])('rejects a malformed value (%s)', (_label, value) => {
    expect(isValidReference(value)).toBe(false);
  });

  describe('createReference', () => {
    it('prefixes a valid ULID with ORD-', () => {
      const result = createReference('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(result.isOk() && result.value).toBe('ORD-01ARZ3NDEKTSV4RRFFQ69G5FAV');
    });
    it.each([
      ['empty', ''],
      ['too short', '01ARZ3NDEKTSV4RRFFQ69G5FA'],
      ['too long', '01ARZ3NDEKTSV4RRFFQ69G5FAVX'],
      ['lowercase', '01arz3ndektsv4rrffq69g5fav'],
      ['already prefixed', 'ORD-01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['first char above 7', '81ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ])('fails with INVALID_REFERENCE (%s)', (_label, ulid) => {
      const result = createReference(ulid);
      expect(result.isErr() && result.error).toEqual({ kind: 'INVALID_REFERENCE' });
    });
  });
});
