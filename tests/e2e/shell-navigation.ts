import type {Page} from '@playwright/test';

// Only counts/status/flags survive. Never retain URLs, query/fragment, bodies,
// exception text, console messages, invitations or room state.
export const observeShellNavigation = (page: Page, clock = Date.now) => {
  const started = clock();
  const elapsed = (): number => Math.max(0, clock() - started);
  const counters = {requests: 0, responses: 0, finished: 0, failed: 0,
    commits: 0, responseStatus: 0, fromServiceWorker: false, crashed: false, closed: false,
    firstRequestMs: null as number | null, firstResponseMs: null as number | null,
    firstFinishedMs: null as number | null, firstCommitMs: null as number | null};
  const isShell = (url: string, navigation: boolean): boolean => {
    try { return navigation && new URL(url).pathname === '/'; } catch { return false; }
  };
  page.on('request', (req) => { if (isShell(req.url(), req.isNavigationRequest())) {
    if (counters.requests === 0) counters.firstRequestMs = elapsed();
    counters.requests += 1;
  } });
  page.on('response', (res) => {
    if (isShell(res.url(), res.request().isNavigationRequest())) {
      if (counters.responses === 0) counters.firstResponseMs = elapsed();
      counters.responses += 1;
      counters.responseStatus = res.status();
      counters.fromServiceWorker = res.fromServiceWorker();
    }
  });
  page.on('requestfinished', (req) => { if (isShell(req.url(), req.isNavigationRequest())) {
    if (counters.finished === 0) counters.firstFinishedMs = elapsed();
    counters.finished += 1;
  } });
  page.on('requestfailed', (req) => { if (isShell(req.url(), req.isNavigationRequest())) counters.failed += 1; });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) {
    if (counters.commits === 0) counters.firstCommitMs = elapsed();
    counters.commits += 1;
  } });
  page.on('crash', () => { counters.crashed = true; });
  page.on('close', () => { counters.closed = true; });
  return counters;
};

export const safeNavigationServerCounters = (input: unknown): Record<string, number | boolean | null> | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const output: Record<string, number | boolean | null> = {};
  for (const field of ['received', 'finished', 'closedEarly', 'aborted', 'lastDurationMs', 'lastStatus']) {
    const count = value[field];
    if (count === null && ['lastDurationMs', 'lastStatus'].includes(field)) output[field] = null;
    else if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) output[field] = count;
    else return null;
  }
  if (typeof value.controllerListening !== 'boolean') return null;
  output.controllerListening = value.controllerListening;
  return output;
};

export const safeNavigationDocumentState = (input: unknown): Record<string, string | boolean> | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!['loading', 'interactive', 'complete'].includes(value.readyState as string)) return null;
  const output: Record<string, string | boolean> = {readyState: value.readyState as string};
  for (const field of ['controllerOrigin', 'rootDocument', 'appHostPresent', 'serviceWorkerControlled']) {
    if (typeof value[field] !== 'boolean') return null;
    output[field] = value[field];
  }
  return output;
};

export const readNavigationDocumentState = async (page: Page): Promise<Record<string, string | boolean> | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (page.isClosed()) return null;
    const input = await Promise.race([page.evaluate(() => ({readyState: document.readyState,
      controllerOrigin: location.origin === 'http://app.localhost:4173', rootDocument: location.pathname === '/',
      appHostPresent: Boolean(document.querySelector('#app-host')), serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller)})),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_000); })]);
    return safeNavigationDocumentState(input);
  } catch { return null; } finally { clearTimeout(timer); }
};
