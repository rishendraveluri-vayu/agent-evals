import { armIndex } from './experiments.service';
import { armOf } from './export.service';

// G8: the export names arms by the same rule as every other screen (armIndex), so an A/A
// calibration run's arm B is read from the calibration flag, not inferred from a repeated hash.
describe('export arm letters', () => {
  it('ordinary run: by the config place', () => {
    const e = { config_hashes: ['ha', 'hb'], n: 3, calibration: false };
    expect(armOf(e, 'ha', 2)).toBe('A');
    expect(armOf(e, 'hb', 0)).toBe('B');
    expect(armOf(e, 'hz', 0)).toBe('');
  });

  it('A/A calibration run: arm B is repeats n to 2n - 1', () => {
    const e = { config_hashes: ['ha', 'ha'], n: 3, calibration: true };
    expect([0, 2, 3, 5].map((r) => armOf(e, 'ha', r))).toEqual(['A', 'A', 'B', 'B']);
  });

  it('agrees with armIndex for every row', () => {
    for (const e of [
      { config_hashes: ['ha', 'hb'], n: 2, calibration: false },
      { config_hashes: ['ha', 'ha'], n: 2, calibration: true },
    ]) {
      for (const h of ['ha', 'hb']) for (const r of [0, 1, 2, 3]) {
        expect(armOf(e, h, r)).toBe(armIndex(e, h, r) < 0 ? '' : 'AB'[armIndex(e, h, r)]);
      }
    }
  });
});
