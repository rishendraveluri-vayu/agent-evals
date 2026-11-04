import { DEFAULT_CONFLICT_CHECK_ALLOWANCE_USD, readAppConfig } from './app-config';

describe('readAppConfig: the conflict-check allowance (D38)', () => {
  it('defaults to $2 and takes a number from EVALS_CONFLICT_CHECK_ALLOWANCE_USD', () => {
    expect(DEFAULT_CONFLICT_CHECK_ALLOWANCE_USD).toBe(2);
    expect(readAppConfig({}).conflictCheckAllowanceUsd).toBe(2);
    expect(readAppConfig({ EVALS_CONFLICT_CHECK_ALLOWANCE_USD: ' ' }).conflictCheckAllowanceUsd).toBe(2);
    expect(readAppConfig({ EVALS_CONFLICT_CHECK_ALLOWANCE_USD: '0.5' }).conflictCheckAllowanceUsd).toBe(0.5);
    expect(readAppConfig({ EVALS_CONFLICT_CHECK_ALLOWANCE_USD: '0' }).conflictCheckAllowanceUsd).toBe(0);
  });

  it('refuses a value that is not a non-negative number, rather than spending on a guess', () => {
    expect(() => readAppConfig({ EVALS_CONFLICT_CHECK_ALLOWANCE_USD: 'two' })).toThrow('EVALS_CONFLICT_CHECK_ALLOWANCE_USD');
    expect(() => readAppConfig({ EVALS_CONFLICT_CHECK_ALLOWANCE_USD: '-1' })).toThrow('non-negative');
  });
});
