import type {Page} from '@playwright/test';

// Traces must remain disabled for callers. Playwright navigation errors otherwise
// include the entire invite in their message and call log even with tracing off.
export const gotoInvite = async (page: Pick<Page, 'goto' | 'waitForFunction'>, path: string, fragment: string): Promise<void> => {
  try {
    // Reopening a scrubbed URL with just a new fragment is otherwise same-document
    // navigation: the parser never reruns and a reopen assertion can be a false pass.
    await page.goto('about:blank', {waitUntil: 'commit', timeout: 10_000});
    await page.goto(`${path}#${fragment}`, {waitUntil: 'commit', timeout: 10_000});
    await page.waitForFunction(() => location.hash === '', undefined, {timeout: 10_000});
  } catch {
    throw new Error('TEST_INVITE_NAVIGATION_FAILED');
  }
};
