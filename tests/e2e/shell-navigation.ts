import type {Page} from '@playwright/test';

// Only counts/status/flags survive. Never retain URLs, query/fragment, bodies,
// exception text, console messages, invitations or room state.
export const observeShellNavigation = (page: Page) => {
  const counters = {requests: 0, responses: 0, finished: 0, failed: 0,
    commits: 0, responseStatus: 0, fromServiceWorker: false, crashed: false, closed: false};
  const isShell = (url: string, navigation: boolean): boolean => {
    try { return navigation && new URL(url).pathname === '/'; } catch { return false; }
  };
  page.on('request', (req) => { if (isShell(req.url(), req.isNavigationRequest())) counters.requests += 1; });
  page.on('response', (res) => {
    if (isShell(res.url(), res.request().isNavigationRequest())) {
      counters.responses += 1;
      counters.responseStatus = res.status();
      counters.fromServiceWorker = res.fromServiceWorker();
    }
  });
  page.on('requestfinished', (req) => { if (isShell(req.url(), req.isNavigationRequest())) counters.finished += 1; });
  page.on('requestfailed', (req) => { if (isShell(req.url(), req.isNavigationRequest())) counters.failed += 1; });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) counters.commits += 1; });
  page.on('crash', () => { counters.crashed = true; });
  page.on('close', () => { counters.closed = true; });
  return counters;
};
