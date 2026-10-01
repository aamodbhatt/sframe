import type {Page} from '@playwright/test';

// Traces must remain disabled for callers. Playwright navigation errors otherwise
// include the entire invite in their message and call log even with tracing off.
export const gotoInvite = async (page: Pick<Page, 'goto' | 'waitForFunction'>, path: string, fragment: string): Promise<void> => {
  let stage: 'blank' | 'invite' | 'scrub' = 'blank';
  try {
    // Reopening a scrubbed URL with just a new fragment is otherwise same-document
    // navigation: the parser never reruns and a reopen assertion can be a false pass.
    await page.goto('about:blank', {waitUntil: 'commit', timeout: 10_000});
    stage = 'invite';
    await page.goto(`${path}#${fragment}`, {waitUntil: 'commit', timeout: 10_000});
    stage = 'scrub';
    await page.waitForFunction(() => location.hash === '', undefined, {timeout: 10_000});
  } catch (error) {
    // Copy only the pinned driver's fixed enums/booleans/counts. Its raw error
    // and call log include the bearer fragment and must never be retained.
    const message = (error instanceof Error ? error.message : '').replace(/\u001b\[[0-9;]*m/gu, '');
    const driverStages = [...message.matchAll(/SMALLFRAME_NAVIGATION_STAGE (?:driver-start|driver-returned newDocument=(?:true|false)|event-selection collected=\d{1,6} newDocuments=\d{1,6}|lifecycle fired=(?:true|false)|response-wait request=(?:true|false)|completed response=(?:true|false))(?=\s|$)/gu)]
      .slice(0, 12).map((match) => match[0]);
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    console.error('INVITE_NAVIGATION_DIAGNOSTICS', JSON.stringify({stage, timeout, driverStages}));
    throw new Error('TEST_INVITE_NAVIGATION_FAILED');
  }
};
