export const EVENT_FALLBACK_LIMITS = Object.freeze({
  heldFetchTimeoutMs: 25_000,
  maximumHeldFetches: 4,
  reconnectWindowMs: 120_000,
  healthyResetMs: 120_000,
  pollBaseMs: 600_000,
  pollJitterFraction: 0.20,
  betaRooms: 100,
  visibleClientsPerRoom: 2,
  conditionalPollsPerDay: 144,
  millisecondsPerDay: 86_400_000,
});

export type EventFallbackState = Readonly<{
  reconnectStartedAtMs: number | null;
  heldFetchesStarted: number;
  heldFetchInFlight: boolean;
  nextPollAtMs: number | null;
  socketHealthySinceMs: number | null;
}>;

export type EventFallbackSignals = Readonly<{
  nowMs: number;
  visible: boolean;
  online: boolean;
  socketHealthy: boolean;
  randomUint32: number;
}>;

export type EventFallbackDecision = Readonly<{
  state: EventFallbackState;
  action:
    | {kind: 'none'}
    | {kind: 'held-fetch'; timeoutMs: number}
    | {kind: 'conditional-state-get'};
}>;

export const initialEventFallbackState = (): EventFallbackState => ({
  reconnectStartedAtMs: null,
  heldFetchesStarted: 0,
  heldFetchInFlight: false,
  nextPollAtMs: null,
  socketHealthySinceMs: null,
});

const assertSignals = (signals: EventFallbackSignals): void => {
  if (!Number.isSafeInteger(signals.nowMs) || signals.nowMs < 0) throw new Error('FALLBACK_NOW_INVALID');
  if (!Number.isSafeInteger(signals.randomUint32) || signals.randomUint32 < 0 || signals.randomUint32 > 0xffff_ffff) {
    throw new Error('FALLBACK_RANDOM_INVALID');
  }
};

export const jitteredPollIntervalMs = (randomUint32: number): number => {
  if (!Number.isSafeInteger(randomUint32) || randomUint32 < 0 || randomUint32 > 0xffff_ffff) throw new Error('FALLBACK_RANDOM_INVALID');
  const unit = randomUint32 / 0xffff_ffff;
  const minimum = 1 - EVENT_FALLBACK_LIMITS.pollJitterFraction;
  const width = EVENT_FALLBACK_LIMITS.pollJitterFraction * 2;
  return Math.round(EVENT_FALLBACK_LIMITS.pollBaseMs * (minimum + width * unit));
};

export const completeHeldFetch = (state: EventFallbackState): EventFallbackState => ({...state, heldFetchInFlight: false});

export const nextEventFallbackDecision = (
  state: EventFallbackState,
  signals: EventFallbackSignals,
): EventFallbackDecision => {
  assertSignals(signals);
  if (signals.socketHealthy) {
    const socketHealthySinceMs = state.socketHealthySinceMs ?? signals.nowMs;
    if (signals.nowMs - socketHealthySinceMs >= EVENT_FALLBACK_LIMITS.healthyResetMs) {
      return {state: {...initialEventFallbackState(), socketHealthySinceMs}, action: {kind: 'none'}};
    }
    return {state: {...state, socketHealthySinceMs}, action: {kind: 'none'}};
  }
  const disconnectedState = state.socketHealthySinceMs === null ? state : {...state, socketHealthySinceMs: null};
  if (!signals.visible || !signals.online) return {state: disconnectedState, action: {kind: 'none'}};

  const reconnectStartedAtMs = disconnectedState.reconnectStartedAtMs ?? signals.nowMs;
  const insideReconnectWindow = signals.nowMs - reconnectStartedAtMs < EVENT_FALLBACK_LIMITS.reconnectWindowMs;
  if (insideReconnectWindow && disconnectedState.heldFetchesStarted < EVENT_FALLBACK_LIMITS.maximumHeldFetches) {
    if (disconnectedState.heldFetchInFlight) return {state: {...disconnectedState, reconnectStartedAtMs}, action: {kind: 'none'}};
    return {
      state: {
        ...disconnectedState,
        reconnectStartedAtMs,
        heldFetchesStarted: disconnectedState.heldFetchesStarted + 1,
        heldFetchInFlight: true,
        nextPollAtMs: null,
      },
      action: {kind: 'held-fetch', timeoutMs: EVENT_FALLBACK_LIMITS.heldFetchTimeoutMs},
    };
  }

  const nextPollAtMs = disconnectedState.nextPollAtMs ?? signals.nowMs + jitteredPollIntervalMs(signals.randomUint32);
  if (signals.nowMs < nextPollAtMs) {
    return {state: {...disconnectedState, reconnectStartedAtMs, heldFetchInFlight: false, nextPollAtMs}, action: {kind: 'none'}};
  }
  return {
    state: {
      ...disconnectedState,
      reconnectStartedAtMs,
      heldFetchInFlight: false,
      nextPollAtMs: signals.nowMs + jitteredPollIntervalMs(signals.randomUint32),
    },
    action: {kind: 'conditional-state-get'},
  };
};

export const steadyFallbackRequestBudgetPerDay = (): number => EVENT_FALLBACK_LIMITS.betaRooms
  * EVENT_FALLBACK_LIMITS.visibleClientsPerRoom
  * EVENT_FALLBACK_LIMITS.conditionalPollsPerDay;

/** Worst-case request count if every jitter sample selects the minimum interval. */
export const worstCaseFallbackRequestBudgetPerDay = (): number => EVENT_FALLBACK_LIMITS.betaRooms
  * EVENT_FALLBACK_LIMITS.visibleClientsPerRoom
  * Math.ceil(EVENT_FALLBACK_LIMITS.millisecondsPerDay / jitteredPollIntervalMs(0));
