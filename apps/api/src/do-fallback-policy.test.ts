import {describe, expect, it} from 'vitest';
import {
  EVENT_FALLBACK_LIMITS,
  completeHeldFetch,
  initialEventFallbackState,
  jitteredPollIntervalMs,
  nextEventFallbackDecision,
  steadyFallbackRequestBudgetPerDay,
  worstCaseFallbackRequestBudgetPerDay,
} from './do-fallback-policy.js';

describe('budgeted event fallback policy', () => {
  it('allows exactly four sequential held fetches in the reconnect window', () => {
    let state = initialEventFallbackState();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const decision = nextEventFallbackDecision(state, {
        nowMs: attempt * EVENT_FALLBACK_LIMITS.heldFetchTimeoutMs,
        visible: true,
        online: true,
        socketHealthy: false,
        randomUint32: 0,
      });
      expect(decision.action).toEqual({kind: 'held-fetch', timeoutMs: 25_000});
      state = completeHeldFetch(decision.state);
    }
    const fifth = nextEventFallbackDecision(state, {
      nowMs: 100_000,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0,
    });
    expect(fifth.action).toEqual({kind: 'none'});
    expect(fifth.state.heldFetchesStarted).toBe(4);
    expect(fifth.state.nextPollAtMs).toBe(580_000);
  });

  it('never overlaps a held fetch and only resets after a stable healthy socket', () => {
    const first = nextEventFallbackDecision(initialEventFallbackState(), {
      nowMs: 1,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0,
    });
    const overlap = nextEventFallbackDecision(first.state, {
      nowMs: 2,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0,
    });
    expect(overlap.action).toEqual({kind: 'none'});
    const briefHealthy = nextEventFallbackDecision(first.state, {
      nowMs: 3,
      visible: true,
      online: true,
      socketHealthy: true,
      randomUint32: 0,
    });
    expect(briefHealthy.state.heldFetchesStarted).toBe(1);
    const flap = nextEventFallbackDecision(briefHealthy.state, {
      nowMs: 4,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0,
    });
    expect(flap.state.heldFetchesStarted).toBe(1);
    const stableStart = nextEventFallbackDecision(flap.state, {
      nowMs: 10,
      visible: true,
      online: true,
      socketHealthy: true,
      randomUint32: 0,
    });
    const reset = nextEventFallbackDecision(stableStart.state, {
      nowMs: 10 + EVENT_FALLBACK_LIMITS.healthyResetMs,
      visible: true,
      online: true,
      socketHealthy: true,
      randomUint32: 0,
    });
    expect(reset.state).toEqual({...initialEventFallbackState(), socketHealthySinceMs: 10});
  });

  it('performs no transport while hidden or offline', () => {
    const state = initialEventFallbackState();
    for (const signals of [
      {visible: false, online: true},
      {visible: true, online: false},
      {visible: false, online: false},
    ]) {
      const decision = nextEventFallbackDecision(state, {
        nowMs: 0,
        socketHealthy: false,
        randomUint32: 0,
        ...signals,
      });
      expect(decision).toEqual({state, action: {kind: 'none'}});
    }
  });

  it('bounds steady polling to ten minutes plus or minus twenty percent', () => {
    expect(jitteredPollIntervalMs(0)).toBe(480_000);
    expect(jitteredPollIntervalMs(0x7fff_ffff)).toBe(600_000);
    expect(jitteredPollIntervalMs(0xffff_ffff)).toBe(720_000);
    expect(steadyFallbackRequestBudgetPerDay()).toBe(28_800);
    expect(worstCaseFallbackRequestBudgetPerDay()).toBe(36_000);
  });

  it('issues one conditional GET only when the deterministic poll deadline arrives', () => {
    let state = {
      reconnectStartedAtMs: 0,
      heldFetchesStarted: 4,
      heldFetchInFlight: false,
      nextPollAtMs: 600_000,
      socketHealthySinceMs: null,
    } as const;
    const early = nextEventFallbackDecision(state, {
      nowMs: 599_999,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0x7fff_ffff,
    });
    expect(early.action).toEqual({kind: 'none'});
    const due = nextEventFallbackDecision(early.state, {
      nowMs: 600_000,
      visible: true,
      online: true,
      socketHealthy: false,
      randomUint32: 0x7fff_ffff,
    });
    expect(due.action).toEqual({kind: 'conditional-state-get'});
    expect(due.state.nextPollAtMs).toBe(1_200_000);
  });
});
