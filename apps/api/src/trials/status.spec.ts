import { TRIAL_STATUSES } from '../contract';
import type { TrialStatus } from '../contract';
import { FINISHED, MAX_ATTEMPTS, NEVER_REQUEUED, PAUSES_ARM, canTransition, isLabel, shouldRequeue, statusForLabel } from './status';

describe('trial status machine', () => {
  it.each<[TrialStatus, TrialStatus]>([
    ['queued', 'claimed'],
    ['queued', 'cancelled'],
    ['claimed', 'running'],
    ['claimed', 'done'],
    ['claimed', 'abandoned'],
    ['running', 'done'],
    ['running', 'infra_failed'],
    ['running', 'abandoned'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[TrialStatus, TrialStatus]>([
    ['queued', 'done'],
    ['queued', 'running'],
    ['running', 'queued'],
    ['running', 'cancelled'],
    ['done', 'queued'],
    ['infra_failed', 'queued'],
    ['abandoned', 'claimed'],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('never changes a finished row again: a re-run is a new attempt row', () => {
    for (const from of FINISHED) {
      for (const to of TRIAL_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('maps the agent label to done and every infra label to infra_failed', () => {
    expect(statusForLabel('agent')).toBe('done');
    for (const label of ['infra:provider_error', 'infra:config_error', 'infra:budget_net', 'infra:adapter_crash', 'infra:timeout_kill']) {
      expect(statusForLabel(label)).toBe('infra_failed');
    }
    expect(isLabel('infra:')).toBe(false);
    expect(isLabel('Agent')).toBe(false);
    expect(() => statusForLabel('passed')).toThrow();
  });

  it('re-queues once, never twice (D16), and only while the experiment runs or is paused', () => {
    expect(MAX_ATTEMPTS).toBe(2);
    expect(shouldRequeue(1, 'running')).toBe(true);
    expect(shouldRequeue(2, 'running')).toBe(false);
    expect(shouldRequeue(1, 'paused')).toBe(true); // queued, claimed only after a resume
    expect(shouldRequeue(1, 'cancelled')).toBe(false);
    expect(shouldRequeue(1, 'done')).toBe(false);
  });

  it('never re-queues a config error or a budget stop; re-queues a provider error once (D26)', () => {
    expect(statusForLabel('infra:config_error')).toBe('infra_failed');
    expect(shouldRequeue(1, 'running', 'infra:config_error')).toBe(false);
    expect(shouldRequeue(1, 'running', 'infra:budget_net')).toBe(false);
    expect(shouldRequeue(1, 'running', 'infra:provider_error')).toBe(true);
    expect(shouldRequeue(2, 'running', 'infra:provider_error')).toBe(false);
    expect(shouldRequeue(1, 'running', 'infra:adapter_crash')).toBe(true);
    expect(shouldRequeue(1, 'running', 'infra:timeout_kill')).toBe(true);
    expect(shouldRequeue(1, 'running', null)).toBe(true); // a lapsed lease
    expect(NEVER_REQUEUED).toEqual(['infra:config_error', 'infra:budget_net']);
    expect(PAUSES_ARM).toBe('infra:config_error');
  });
});
