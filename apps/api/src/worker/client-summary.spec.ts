import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { clientSummary, formatInr } from './client-summary';

// The synthetic client file of the engine's test task (an invented person, marked synthetic).
const ENGINE_CLIENT = readFileSync(path.resolve(__dirname, '../../../../tasks/engine-smoke-emi/client.json'));

describe('formatInr', () => {
  it.each([
    [0, '₹0.00'],
    [999, '₹999.00'],
    [4212.5, '₹4,212.50'],
    [92500, '₹92,500.00'],
    [441050, '₹4,41,050.00'],
    [1800000, '₹18,00,000.00'],
    [12345678.9, '₹1,23,45,678.90'],
    [-1500, '-₹1,500.00'],
  ])('writes %p as %s, like the finance tools', (amount, text) => {
    expect(formatInr(amount)).toBe(text);
  });
});

describe('clientSummary (D27)', () => {
  it('summarises the profile as recorded and the debts with the totals list_debts shows', () => {
    const summary = clientSummary(ENGINE_CLIENT)!;
    const lines = summary.split('\n');
    expect(lines.slice(0, 5)).toEqual(['Profile:', '- name: Meera Raghavan', '- age: 34', '- city: Pune', '- occupation: QA engineer at a mid-size IT services firm']);
    expect(lines).toContain('- monthly net income: 92500');
    expect(lines).toContain('- dependents: relation son, age 6; relation mother, age 63');
    expect(lines).toContain("- goals: Clear the credit card balance; Start saving for her son's higher education");
    // The two figures the 4 Nov simulator disowned: take-home and the total balance.
    expect(lines).toContain('Debts (3, total balance ₹4,41,050.00, total minimum payments ₹18,332.50 a month):');
    expect(lines).toContain('- Credit card (credit card, Kaveri Bank (fictional)): balance ₹84,250.00 at 42% a year, minimum payment ₹4,212.50 a month');
    expect(lines).toContain(
      '- Personal loan (personal loan, Sahyadri Finance (fictional)): balance ₹3,10,000.00 at 14.5% a year, minimum payment ₹10,670.00 a month, 36 months left',
    );
    // Transactions are not part of it.
    expect(summary).not.toContain('Salary credit');
    expect(summary).not.toContain('transactions');
  });

  it('says when no debts are recorded, and is null without a usable client file', () => {
    expect(clientSummary('{"schema_version": 1, "profile": {"name": "Test (synthetic)"}}')).toBe('Profile:\n- name: Test (synthetic)\nDebts: none recorded');
    expect(clientSummary(null)).toBeNull();
    expect(clientSummary(undefined)).toBeNull();
    expect(clientSummary('not json')).toBeNull();
    expect(clientSummary('{"name": "no profile block"}')).toBeNull();
    expect(clientSummary('[1, 2]')).toBeNull();
  });
});
