import { describe, expect, it } from 'vitest';
import { ruleMatches, type RuleForMatching, type MatchableTxn } from '../src/modules/banking/bank-rules.service.js';

const baseRule: RuleForMatching = {
  id: 'r1',
  bankAccountId: null,
  matchType: 'contains',
  matchValue: 'verizon',
  amountSign: 'any',
  targetAccountId: 'acct-telephone',
  memoTemplate: null,
  priority: 100,
};

const baseTxn: MatchableTxn = {
  id: 't1',
  description: 'VERIZON BILL PAY',
  amount: '-89.99',
  bankAccountId: 'bank-1',
};

describe('ruleMatches', () => {
  it('matches case-insensitive substring with default contains', () => {
    expect(ruleMatches(baseRule, baseTxn)).toBe(true);
  });

  it('does not match when substring is absent', () => {
    expect(ruleMatches(baseRule, { ...baseTxn, description: 'AT&T BILL PAY' })).toBe(false);
  });

  it('respects bankAccountId scope: matching account passes', () => {
    expect(
      ruleMatches({ ...baseRule, bankAccountId: 'bank-1' }, baseTxn),
    ).toBe(true);
  });

  it('respects bankAccountId scope: different account is filtered out', () => {
    expect(
      ruleMatches({ ...baseRule, bankAccountId: 'bank-other' }, baseTxn),
    ).toBe(false);
  });

  it('amountSign=negative matches a withdrawal', () => {
    expect(ruleMatches({ ...baseRule, amountSign: 'negative' }, baseTxn)).toBe(true);
  });

  it('amountSign=negative rejects a deposit', () => {
    expect(
      ruleMatches({ ...baseRule, amountSign: 'negative' }, { ...baseTxn, amount: '100.00' }),
    ).toBe(false);
  });

  it('amountSign=positive rejects a withdrawal', () => {
    expect(ruleMatches({ ...baseRule, amountSign: 'positive' }, baseTxn)).toBe(false);
  });

  it('starts_with matches the prefix only', () => {
    const rule = { ...baseRule, matchType: 'starts_with' as const, matchValue: 'verizon' };
    expect(ruleMatches(rule, { ...baseTxn, description: 'VERIZON FIBER 1234' })).toBe(true);
    expect(ruleMatches(rule, { ...baseTxn, description: 'PAYMENT TO VERIZON' })).toBe(false);
  });

  it('ends_with matches the suffix only', () => {
    const rule = { ...baseRule, matchType: 'ends_with' as const, matchValue: 'PAY' };
    expect(ruleMatches(rule, baseTxn)).toBe(true);
    expect(ruleMatches(rule, { ...baseTxn, description: 'PAY VERIZON' })).toBe(false);
  });

  it('exact requires full-string equality (case-insensitive)', () => {
    const rule = { ...baseRule, matchType: 'exact' as const, matchValue: 'AMAZON' };
    expect(ruleMatches(rule, { ...baseTxn, description: 'amazon' })).toBe(true);
    expect(ruleMatches(rule, { ...baseTxn, description: 'AMAZON.COM' })).toBe(false);
  });

  it('regex matches a flexible pattern', () => {
    const rule = { ...baseRule, matchType: 'regex' as const, matchValue: '^uber\\s+(eats|trip)' };
    expect(ruleMatches(rule, { ...baseTxn, description: 'UBER EATS 8273' })).toBe(true);
    expect(ruleMatches(rule, { ...baseTxn, description: 'UBER TRIP 4421' })).toBe(true);
    expect(ruleMatches(rule, { ...baseTxn, description: 'PAYMENT - UBER' })).toBe(false);
  });

  it('regex with bad syntax fails closed (no match)', () => {
    const rule = { ...baseRule, matchType: 'regex' as const, matchValue: '[unclosed' };
    expect(ruleMatches(rule, baseTxn)).toBe(false);
  });

  it('blank match value never fires', () => {
    expect(ruleMatches({ ...baseRule, matchValue: '   ' }, baseTxn)).toBe(false);
  });
});
