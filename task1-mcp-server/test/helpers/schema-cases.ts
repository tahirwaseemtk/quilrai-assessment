// Shared by the Zod tests and the JSON Schema parity tests, so both judge the same inputs.
const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const emoji = char(0x1f600);

export const amountCases = {
  valid: [0.01, 1, 1.5, 19.99, 1.15, 0.29, 1.1, 1e-2, 9999.99, 10_000],
  invalid: [
    0,
    -0,
    -0.01,
    -1,
    10_000.01,
    1e21,
    Number.MAX_VALUE,
    0.001,
    1.005,
    19.999,
    0.009,
    1e-7,
    10.001,
    NaN,
    Infinity,
    -Infinity,
    '10',
    '10.00',
    null,
    true,
    [10],
    {},
  ] as unknown[],
};

export const reasonCases = {
  valid: [
    '0123456789',
    '  0123456789  ',
    'a'.repeat(500),
    emoji.repeat(10),
    emoji.repeat(500),
    `0123${char(0x200b)}456789`,
  ],
  invalid: [
    '012345678',
    '   012345678   ',
    '',
    ' '.repeat(12),
    '\t\n\r          ',
    char(0x3000).repeat(12),
    char(0xfeff).repeat(12),
    char(0x200b).repeat(10),
    char(0xad).repeat(10),
    char(0x200e).repeat(10),
    char(0x202e).repeat(10),
    char(0x2061).repeat(10),
    char(0x3164).repeat(10),
    'a'.repeat(501),
    emoji.repeat(9),
  ] as unknown[],
};
