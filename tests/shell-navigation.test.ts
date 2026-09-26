import {EventEmitter} from 'node:events';
import type {Page} from '@playwright/test';
import {expect, it} from 'vitest';
import {observeShellNavigation} from './e2e/shell-navigation.js';

const fixture = () => {
  const page = Object.assign(new EventEmitter(), {mainFrame: () => mainFrame});
  const mainFrame = {};
  const counters = observeShellNavigation(page as unknown as Page);
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
    responseStatus: 200, fromServiceWorker: false, crashed: true, closed: true});
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
