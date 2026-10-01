import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const marker = 'SMALLFRAME_NAVIGATION_STAGE';
const sourceHash = '549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171';
const hash = (source) => createHash('sha256').update(source).digest('hex');
const replaceOnce = (source, needle, replacement) => {
  if (source.split(needle).length !== 2) throw new Error('NAVIGATION_DIAGNOSTIC_DRIVER_UNEXPECTED');
  return source.replace(needle, replacement);
};

// Diagnostic logging only. The hash pins the exact installed driver source;
// removing the added log lines must reproduce it byte for byte. No navigation
// command, event predicate, await, timeout, return value or retry is changed.
export const navigationDiagnosticSource = (input) => {
  const source = input.split('\n').filter((line) => !line.includes(marker)).join('\n');
  if (hash(source) !== sourceHash) throw new Error('NAVIGATION_DIAGNOSTIC_DRIVER_UNEXPECTED');
  let output = replaceOnce(source,
    '          navigateResult = await progress2.race(this._page.delegate.navigateFrame(this, url3, referer));',
    '          progress2.log("SMALLFRAME_NAVIGATION_STAGE driver-start");\n'
      + '          navigateResult = await progress2.race(this._page.delegate.navigateFrame(this, url3, referer));\n'
      + '          progress2.log("SMALLFRAME_NAVIGATION_STAGE driver-returned newDocument=" + Boolean(navigateResult.newDocumentId));');
  output = replaceOnce(output,
    '        let event;\n        if (navigateResult.newDocumentId) {',
    '        progress2.log("SMALLFRAME_NAVIGATION_STAGE event-selection collected=" + navigationEvents.length + " newDocuments=" + navigationEvents.filter((item) => Boolean(item.newDocument)).length);\n'
      + '        let event;\n        if (navigateResult.newDocumentId) {');
  output = replaceOnce(output,
    '        if (!this._firedLifecycleEvents.has(waitUntil))\n          await helper.waitForEvent(progress2, this, _Frame.Events.AddLifecycle, (e) => e === waitUntil).promise;\n        const request2 = event.newDocument ? event.newDocument.request : void 0;\n        const response2 = request2 ? await request2._finalRequest().response(progress2) : null;\n        return response2;',
    '        progress2.log("SMALLFRAME_NAVIGATION_STAGE lifecycle fired=" + this._firedLifecycleEvents.has(waitUntil));\n'
      + '        if (!this._firedLifecycleEvents.has(waitUntil))\n          await helper.waitForEvent(progress2, this, _Frame.Events.AddLifecycle, (e) => e === waitUntil).promise;\n'
      + '        const request2 = event.newDocument ? event.newDocument.request : void 0;\n'
      + '        progress2.log("SMALLFRAME_NAVIGATION_STAGE response-wait request=" + Boolean(request2));\n'
      + '        const response2 = request2 ? await request2._finalRequest().response(progress2) : null;\n'
      + '        progress2.log("SMALLFRAME_NAVIGATION_STAGE completed response=" + Boolean(response2));\n'
      + '        return response2;');
  if (input !== source && input !== output) throw new Error('NAVIGATION_DIAGNOSTIC_DRIVER_UNEXPECTED');
  return output;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = JSON.parse(readFileSync('node_modules/playwright-core/package.json', 'utf8'));
  if (metadata.version !== '1.63.0') throw new Error('NAVIGATION_DIAGNOSTIC_DRIVER_VERSION');
  const path = 'node_modules/playwright-core/lib/coreBundle.js';
  writeFileSync(path, navigationDiagnosticSource(readFileSync(path, 'utf8')));
  console.log('Pinned Playwright navigation stage logging enabled; behavior unchanged.');
}
