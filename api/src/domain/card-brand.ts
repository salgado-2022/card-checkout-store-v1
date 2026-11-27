export const CARD_BRANDS = ['VISA', 'MASTERCARD'] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export function isCardBrand(value: unknown): value is CardBrand {
  return typeof value === 'string' && (CARD_BRANDS as readonly string[]).includes(value);
}
