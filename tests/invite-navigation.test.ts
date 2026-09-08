import {describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {gotoInvite} from './e2e/invite-navigation.js';

describe('secret-free invite navigation failures', () => {
  for (const failure of ['blank', 'invite', 'scrub']) {
    it(`discards original ${failure} error, stack and cause`, async () => {
      const secret = randomBytes(32).toString('base64url');
      const original = new Error(secret, {cause: new Error(secret)});
      let navigations = 0;
      const goto = vi.fn().mockImplementation(async () => {
        navigations += 1;
        if ((failure === 'blank' && navigations === 1) || (failure === 'invite' && navigations === 2)) throw original;
        return null;
      });
      const waitForFunction = vi.fn().mockRejectedValue(original);
      let caught: unknown;
      try { await gotoInvite({goto, waitForFunction}, '/r/test', secret); }
      catch (error) { caught = error; }
      // Boolean assertions cannot reflect the generated secret on failure.
      expect(caught instanceof Error).toBe(true);
      const error = caught as Error;
      expect(error.message === 'TEST_INVITE_NAVIGATION_FAILED').toBe(true);
      expect(error.cause === undefined).toBe(true);
      expect(String(error.stack).includes(secret)).toBe(false);
    });
  }
});
