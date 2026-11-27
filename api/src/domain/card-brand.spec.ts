import { CARD_BRANDS, isCardBrand } from './card-brand';

describe('CardBrand', () => {
  it('lists VISA and MASTERCARD', () => {
    expect(CARD_BRANDS).toEqual(['VISA', 'MASTERCARD']);
  });

  it.each(['VISA', 'MASTERCARD'])('accepts %s', (value) => {
    expect(isCardBrand(value)).toBe(true);
  });

  it.each(['AMEX', 'visa', '', 'DISCOVER'])('rejects the unsupported brand %p', (value) => {
    expect(isCardBrand(value)).toBe(false);
  });

  it.each([undefined, null, 4242, { brand: 'VISA' }])(
    'rejects the non-string value %p',
    (value) => {
      expect(isCardBrand(value)).toBe(false);
    },
  );
});
