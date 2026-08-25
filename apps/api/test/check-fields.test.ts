import { describe, expect, it } from 'vitest';
import {
  amountToWords,
  buildMicrLine,
  isValidRoutingNumber,
  padLegalLine,
} from '../src/modules/forms/check-fields.js';

describe('amountToWords', () => {
  it('writes the legal amount the way a bank expects', () => {
    expect(amountToWords('1234.5600')).toBe('One Thousand Two Hundred Thirty-Four and 56/100');
    expect(amountToWords('0.0000')).toBe('Zero and 00/100');
    expect(amountToWords('1.0000')).toBe('One and 00/100');
    expect(amountToWords('100.0000')).toBe('One Hundred and 00/100');
    expect(amountToWords('115.0000')).toBe('One Hundred Fifteen and 00/100');
    expect(amountToWords('1000000.0000')).toBe('One Million and 00/100');
    expect(amountToWords('650.0000')).toBe('Six Hundred Fifty and 00/100');
  });

  it('hyphenates compound tens, which is the convention on a check', () => {
    expect(amountToWords('21.0000')).toBe('Twenty-One and 00/100');
    expect(amountToWords('99.9900')).toBe('Ninety-Nine and 99/100');
  });

  it('carries a rounding half-cent into dollars instead of printing 100/100', () => {
    // 9.9950 rounds to 10.00; the naive version writes "Nine and 100/100".
    expect(amountToWords('9.9950')).toBe('Ten and 00/100');
    expect(amountToWords('0.9990')).toBe('One and 00/100');
  });

  it('skips empty scale groups rather than writing "Zero Thousand"', () => {
    expect(amountToWords('1000005.0000')).toBe('One Million Five and 00/100');
    expect(amountToWords('2000000.5000')).toBe('Two Million and 50/100');
  });

  it('marks a negative amount instead of quietly writing a positive check', () => {
    expect(amountToWords('-50.0000')).toMatch(/^MINUS /);
  });

  it('refuses an amount too large to write', () => {
    expect(() => amountToWords('1000000000000.0000')).toThrow(/too large/);
  });
});

describe('padLegalLine', () => {
  it('fills the remainder so words cannot be appended', () => {
    const line = padLegalLine('One and 00/100', 30);
    expect(line.startsWith('One and 00/100 ')).toBe(true);
    expect(line.length).toBe(30);
    expect(line.endsWith('*')).toBe(true);
  });

  it('never truncates the amount itself when it overruns the target', () => {
    const words = amountToWords('123456789.9900');
    expect(padLegalLine(words, 10)).toContain(words);
  });
});

describe('isValidRoutingNumber', () => {
  it('accepts real routing numbers', () => {
    // Known-valid ABA checksums.
    expect(isValidRoutingNumber('021000021')).toBe(true); // JPMorgan Chase
    expect(isValidRoutingNumber('011401533')).toBe(true); // Evolve
  });

  it('rejects a transposition that would silently misroute the check', () => {
    expect(isValidRoutingNumber('021000012')).toBe(false);
    expect(isValidRoutingNumber('123456789')).toBe(false);
    expect(isValidRoutingNumber('01140153')).toBe(false); // 8 digits
    expect(isValidRoutingNumber('0114015333')).toBe(false); // 10 digits
    expect(isValidRoutingNumber('01140153a')).toBe(false);
  });
});

describe('buildMicrLine', () => {
  it('lays out check number, routing and account in the standard order', () => {
    const line = buildMicrLine({
      routingNumber: '021000021',
      accountNumber: '1234567890',
      checkNumber: 1001,
    });
    expect(line).toBe('A1001A T021000021T 1234567890O');
  });

  it('pads short check numbers to four digits', () => {
    expect(buildMicrLine({ routingNumber: '021000021', accountNumber: '12345678', checkNumber: 7 }))
      .toContain('A0007A');
  });

  it('refuses a routing number that fails the ABA checksum', () => {
    expect(() =>
      buildMicrLine({ routingNumber: '123456789', accountNumber: '12345678', checkNumber: 1 }),
    ).toThrow(/checksum/);
  });

  it('refuses malformed account and check numbers rather than printing them', () => {
    expect(() =>
      buildMicrLine({ routingNumber: '021000021', accountNumber: '12-3456', checkNumber: 1 }),
    ).toThrow(/account number/);
    expect(() =>
      buildMicrLine({ routingNumber: '021000021', accountNumber: '12345678', checkNumber: 0 }),
    ).toThrow(/check number/);
  });
});
