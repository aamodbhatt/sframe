import {expect, test} from './test-base.js';

test.use({trace: 'off'});

test('aborted navigation retains only safe driver stage diagnostics', async ({page}) => {
  await page.route('**/diagnostic-abort', (route) => route.abort('failed'));
  let message = '';
  try {
    await page.goto('/diagnostic-abort', {waitUntil: 'commit'});
  } catch (error) { message = error instanceof Error ? error.message : ''; }
  expect(message).toContain('SMALLFRAME_NAVIGATION_STAGE driver-start');
  const stages = message.split('\n').filter((line) => line.includes('SMALLFRAME_NAVIGATION_STAGE'))
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, '').trim().replace(/^-\s*/u, ''));
  expect(stages.length).toBeGreaterThan(0);
  for (const stage of stages) {
    expect(stage).toMatch(/^SMALLFRAME_NAVIGATION_STAGE (driver-start|driver-returned newDocument=(true|false)|event-selection collected=\d+ newDocuments=\d+|lifecycle fired=(true|false)|response-wait request=(true|false)|completed response=(true|false))$/u);
  }
});
