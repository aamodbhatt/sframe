import {EventEmitter} from 'node:events';
import type {Page} from '@playwright/test';
import {expect, it} from 'vitest';
import {observeShellNavigation, safeNavigationServerCounters, safeNavigationDocumentState, readNavigationDocumentState} from './e2e/shell-navigation.js';

const fixture = (clock = () => 0) => {
  const page = Object.assign(new EventEmitter(), {mainFrame: () => mainFrame});
  const mainFrame = {};
  const counters = observeShellNavigation(page as unknown as Page, clock);
  const request = (url: string, navigation = true) => ({url: () => url, isNavigationRequest: () => navigation});
  return {page, mainFrame, counters, request};
};

it('retains only counters/status while distinguishing shell response, completion, failure and commit', () => {
  const {page, mainFrame, counters, request} = fixture();
  const req = request('http://app.localhost:4173/?omit=QUERY_SENTINEL#FRAGMENT_SENTINEL');
  page.emit('request', req);
  page.emit('response', {url: req.url, request: () => req, status: () => 200, fromServiceWorker: () => false});
  page.emit('requestfinished', req);
  expect(counters.commits).toBe(0); // A server/browser response is distinct from a committed document.
  page.emit('framenavigated', {});
  expect(counters.commits).toBe(0);
  page.emit('framenavigated', mainFrame);
  page.emit('requestfailed', req);
  page.emit('crash');
  page.emit('close');
  expect(counters).toEqual({requests: 1, responses: 1, finished: 1, failed: 1, commits: 1,
    responseStatus: 200, fromServiceWorker: false, crashed: true, closed: true,
    firstRequestMs: 0, firstResponseMs: 0, firstFinishedMs: 0, firstCommitMs: 0});
  expect(JSON.stringify(counters)).not.toMatch(/SENTINEL|http|fragment|query/iu);
});

it('ignores subresources, other routes and malformed diagnostic inputs, and marks service worker responses', () => {
  const {page, counters, request} = fixture();
  for (const req of [request('http://app.localhost:4173/', false), request('http://app.localhost:4173/main.js'), request('invalid')]) {
    for (const event of ['request', 'requestfinished', 'requestfailed']) page.emit(event, req);
    page.emit('response', {url: req.url, request: () => req, status: () => 200, fromServiceWorker: () => false});
  }
  expect(counters.requests + counters.responses + counters.finished + counters.failed).toBe(0);
  const req = request('http://app.localhost:4173/');
  page.emit('response', {url: req.url, request: () => req, status: () => 503, fromServiceWorker: () => true});
  expect(counters.responseStatus).toBe(503);
  expect(counters.fromServiceWorker).toBe(true);
});

it('server diagnostic output drops unrecognized text and rejects malformed counters', () => {
  const counters = {received: 1, finished: 1, closedEarly: 0, aborted: 0, lastDurationMs: 1, lastStatus: 200, controllerListening: true};
  expect(safeNavigationServerCounters({...counters, privateText: 'OMIT_SENTINEL', url: 'OMIT_SENTINEL'})).toEqual(counters);
  expect(safeNavigationServerCounters({...counters, lastDurationMs: null, lastStatus: null})).not.toBeNull();
  for (const invalid of [null, [], {}, {...counters, received: 'OMIT_SENTINEL'}, {...counters, received: -1},
    {...counters, received: Number.MAX_SAFE_INTEGER + 1}, {...counters, controllerListening: 'OMIT_SENTINEL'}]) {
    expect(safeNavigationServerCounters(invalid)).toBeNull();
  }
});

it('records the first navigation stage times without conflating server completion and document commit', () => {
  let time = 100;
  const {page, counters, mainFrame, request} = fixture(() => time);
  const req = request('http://app.localhost:4173/');
  time = 110; page.emit('request', req);
  time = 120; page.emit('response', {url: req.url, request: () => req, status: () => 200, fromServiceWorker: () => false});
  time = 125; page.emit('requestfinished', req);
  expect(counters.firstCommitMs).toBeNull();
  time = 140; page.emit('framenavigated', mainFrame);
  time = 160; page.emit('request', req);
  expect([counters.firstRequestMs, counters.firstResponseMs, counters.firstFinishedMs, counters.firstCommitMs]).toEqual([10, 20, 25, 40]);
});

it('document diagnostics retain only a fixed readiness enum and booleans, including failure paths', async () => {
  const input = {readyState: 'complete', controllerOrigin: true, rootDocument: true, appHostPresent: true, serviceWorkerControlled: false};
  expect(safeNavigationDocumentState({...input, url: 'OMIT_SENTINEL', text: 'OMIT_SENTINEL'})).toEqual(input);
  for (const invalid of [null, {}, [], {...input, readyState: 'OMIT_SENTINEL'}, {...input, appHostPresent: 'OMIT_SENTINEL'}]) {
    expect(safeNavigationDocumentState(invalid)).toBeNull();
  }
  expect(await readNavigationDocumentState({isClosed: () => true} as Page)).toBeNull();
  expect(await readNavigationDocumentState({isClosed: () => false, evaluate: async () => { throw new Error('OMIT_SENTINEL'); }} as unknown as Page)).toBeNull();
});
