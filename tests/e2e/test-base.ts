import {test as base} from '@playwright/test';
import {observeShellNavigation, safeNavigationServerCounters, readNavigationDocumentState} from './shell-navigation.js';

export {expect, chromium, firefox, webkit} from '@playwright/test';
export type {Page, APIRequestContext} from '@playwright/test';

// Keep navigation deadlines/assertions/retry policy unchanged. An automatic
// fixture captures the same failure-only counters in every suite so a timeout
// moving between files cannot evade diagnostics. No trace/body/URL is emitted.
export const test = base.extend<{navigationDiagnostics: void}>({
  navigationDiagnostics: [async ({page, request, browser}, use, info) => {
    const observedAt = Date.now();
    const counters = observeShellNavigation(page);
    let serverReset = false;
    try {
      serverReset = (await request.post('http://127.0.0.1:8787/__test__/navigation-diagnostics', {timeout: 4_000})).status() === 204;
    } catch { /* Diagnostic availability must not replace the original failure. */ }
    await use();
    if (info.status === info.expectedStatus) return;
    console.error('BROWSER_NAVIGATION_DIAGNOSTICS', JSON.stringify({...counters,
      browserConnected: browser.isConnected(), pageClosed: page.isClosed(), serverReset,
      observedDurationMs: Date.now() - observedAt, testDurationMs: info.duration,
      nodeVersion: process.version, platform: process.platform, architecture: process.arch}));
    console.error('DOCUMENT_NAVIGATION_DIAGNOSTICS', JSON.stringify(await readNavigationDocumentState(page)));
    try {
      const response = await request.get('http://127.0.0.1:8787/__test__/navigation-diagnostics', {timeout: 4_000});
      const server = response.ok() ? safeNavigationServerCounters(await response.json()) : null;
      if (server) console.error('NAVIGATION_DIAGNOSTICS', JSON.stringify(server));
      else console.error('NAVIGATION_DIAGNOSTICS_UNAVAILABLE');
    } catch { console.error('NAVIGATION_DIAGNOSTICS_UNAVAILABLE'); }
  }, {auto: true}],
});
