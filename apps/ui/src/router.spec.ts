import { describe, expect, it } from 'vitest';
import { href, parseHash } from './router';

describe('the labels route', () => {
  it('reads the set, the batch, a chosen list and calibrate from the address', () => {
    expect(parseHash('#/labels')).toEqual({ name: 'labels', set: null, experiment: null, items: null, calibrate: false });
    expect(parseHash('#/labels?set=heldout&experiment=exp_heldout&calibrate=1')).toEqual({ name: 'labels', set: 'heldout', experiment: 'exp_heldout', items: null, calibrate: true });
    expect(parseHash('#/labels?set=tuning&items=t_a,t_b')).toEqual({ name: 'labels', set: 'tuning', experiment: null, items: 't_a,t_b', calibrate: false });
    // Only calibrate=1 calibrates; an unknown set is no set.
    expect(parseHash('#/labels?set=nope&calibrate=yes')).toEqual({ name: 'labels', set: null, experiment: null, items: null, calibrate: false });
  });

  it('builds the calibrate link that the comparison and the judge page open, and the plain one', () => {
    expect(href.labels()).toBe('#/labels');
    const calibrate = href.labels({ set: 'heldout', experiment: 'exp_heldout', calibrate: true });
    expect(calibrate).toBe('#/labels?set=heldout&experiment=exp_heldout&calibrate=1');
    expect(parseHash(calibrate)).toEqual({ name: 'labels', set: 'heldout', experiment: 'exp_heldout', items: null, calibrate: true });
    expect(href.labels({ set: 'tuning', experiment: 'e 1' })).toBe('#/labels?set=tuning&experiment=e+1');
    expect(parseHash(href.labels({ set: 'tuning', experiment: 'e 1' }))).toMatchObject({ experiment: 'e 1' });
  });
});
