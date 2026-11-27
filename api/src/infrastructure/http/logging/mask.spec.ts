import { maskDocumentNumber, maskEmail, maskSensitiveFields, maskFreeText } from './mask';

describe('maskEmail', () => {
  it('keeps the first character of the local part, then *** and the domain', () => {
    expect(maskEmail('john.doe@example.com')).toBe('j***@example.com');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskEmail('')).toBe('');
  });

  it('fully masks a value without @', () => {
    expect(maskEmail('johndoe')).toBe('***');
  });

  it('keeps no character of a one-character local part', () => {
    expect(maskEmail('a@example.com')).toBe('*@example.com');
  });

  it('keeps the domain unchanged when the local part is empty', () => {
    expect(maskEmail('@example.com')).toBe('@example.com');
  });

  it('uses the last @ as the separator', () => {
    expect(maskEmail('a@b@example.com')).toBe('a***@example.com');
  });

  it('is idempotent', () => {
    for (const email of ['john.doe@example.com', 'a@example.com', '@example.com', 'johndoe']) {
      const once = maskEmail(email);
      expect(maskEmail(once)).toBe(once);
    }
  });
});

describe('maskDocumentNumber', () => {
  it('replaces every character except the last three and keeps the length', () => {
    expect(maskDocumentNumber('1234567890')).toBe('*******890');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskDocumentNumber('')).toBe('');
  });

  it('fully masks values of one to three characters', () => {
    expect(maskDocumentNumber('1')).toBe('*');
    expect(maskDocumentNumber('12')).toBe('**');
    expect(maskDocumentNumber('123')).toBe('***');
  });

  it('reveals only the last three characters of a four-character value', () => {
    expect(maskDocumentNumber('1234')).toBe('*234');
  });

  it('is idempotent', () => {
    for (const value of ['1234567890', 'AB12', '12', 'X']) {
      const once = maskDocumentNumber(value);
      expect(maskDocumentNumber(once)).toBe(once);
    }
  });
});

describe('maskSensitiveFields', () => {
  it('masks email, customerEmail and documentNumber fields', () => {
    expect(
      maskSensitiveFields({
        email: 'john.doe@example.com',
        customerEmail: 'jane@example.com',
        documentNumber: '1234567890',
      }),
    ).toEqual({
      email: 'j***@example.com',
      customerEmail: 'j***@example.com',
      documentNumber: '*******890',
    });
  });

  it('masks a numeric documentNumber through its string form', () => {
    expect(maskSensitiveFields({ documentNumber: 1234567890 })).toEqual({
      documentNumber: '*******890',
    });
  });

  it('leaves other fields and non-string values of masked fields unchanged', () => {
    expect(maskSensitiveFields({ requestId: 'req-1', email: null, statusCode: 200 })).toEqual({
      requestId: 'req-1',
      email: null,
      statusCode: 200,
    });
  });

  it('does not mutate the input', () => {
    const input = { email: 'john.doe@example.com' };

    maskSensitiveFields(input);

    expect(input).toEqual({ email: 'john.doe@example.com' });
  });
});

describe('maskFreeText', () => {
  it('masks every email in a message', () => {
    expect(maskFreeText('duplicate key for john.doe@example.com and ana@test.co')).toBe(
      'duplicate key for j***@example.com and a***@test.co',
    );
  });

  it('masks documents, phones and card numbers, keeping the last three digits', () => {
    expect(maskFreeText('doc 1234567890 phone 300-123-4567 card 4242 4242 4242 4242')).toBe(
      'doc *******890 phone *******567 card *************242',
    );
  });

  it('keeps short numbers such as status codes and counts', () => {
    expect(maskFreeText('HTTP 503 after 2 attempts in 10000 ms')).toBe(
      'HTTP 503 after 2 attempts in 10000 ms',
    );
  });

  it('truncates long messages', () => {
    const masked = maskFreeText('x'.repeat(1000));
    expect(masked).toHaveLength(301);
    expect(masked.endsWith('…')).toBe(true);
  });
});
