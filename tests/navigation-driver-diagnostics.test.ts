import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {navigationDiagnosticSource} from '../scripts/instrument-navigation.mjs';

const installed = readFileSync('node_modules/playwright-core/lib/coreBundle.js', 'utf8');
const original = installed.split('\n').filter((line) => !line.includes('SMALLFRAME_NAVIGATION_STAGE')).join('\n');

it('adds only progress-log statements and preserves every original driver byte', () => {
  const instrumented = navigationDiagnosticSource(original);
  const restored = instrumented.split('\n').filter((line) => !line.includes('SMALLFRAME_NAVIGATION_STAGE')).join('\n');
  expect(restored).toBe(original);
  expect(createHash('sha256').update(restored).digest('hex')).toBe('549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171');
  const added = instrumented.split('\n').filter((line) => line.includes('SMALLFRAME_NAVIGATION_STAGE'));
  expect(added).toHaveLength(6);
  expect(added.every((line) => line.trim().startsWith('progress2.log('))).toBe(true);
  expect(added.join('\n')).not.toMatch(/url3|referer|signature|capability|headers|body/iu);
  expect(navigationDiagnosticSource(instrumented)).toBe(instrumented);
});

it('rejects version/source drift and modified diagnostics that could expose raw identifiers', () => {
  expect(() => navigationDiagnosticSource(original + '\n')).toThrow('NAVIGATION_DIAGNOSTIC_DRIVER_UNEXPECTED');
  const instrumented = navigationDiagnosticSource(original);
  const unsafe = instrumented.replace('Boolean(navigateResult.newDocumentId)', 'navigateResult.newDocumentId');
  expect(() => navigationDiagnosticSource(unsafe)).toThrow('NAVIGATION_DIAGNOSTIC_DRIVER_UNEXPECTED');
});
