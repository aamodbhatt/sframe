import {expect, test, type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';

test.use({trace: 'off'});

const abortNextWorkspaceWrite = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (this.name === 'workspaces') {
        IDBObjectStore.prototype.put = put;
        this.transaction.abort();
      }
      return request;
    };
  });
};

const exportedDecisionCount = async (page: Page): Promise<number> => {
  await page.getByRole('button', {name: 'Workspace'}).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export readable JSON'}).click();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('TEST_EXPORT_UNAVAILABLE');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const count = Object.keys(JSON.parse(Buffer.concat(chunks).toString('utf8')).decisions ?? {}).length;
  await page.getByRole('button', {name: 'Workspace'}).click();
  return count;
};

test('a rejected personal edit cannot reach the renderer, export or saved workspace', async ({page}) => {
  await page.goto('/?personal=1', {waitUntil: 'commit'});
  await page.getByRole('button', {name: 'Open this exact version'}).click();
  const app = page.frameLocator('iframe');
  await expect(app.getByText('0 decisions')).toBeVisible();
  await abortNextWorkspaceWrite(page);
  await app.getByRole('button', {name: 'Add decision'}).click();
  await expect(page.locator('#status')).toHaveText('Local save failed; change was not applied.');
  await expect(app.getByText('0 decisions')).toBeVisible();
  expect(await exportedDecisionCount(page)).toBe(0);
  await app.getByRole('button', {name: 'Add decision'}).click();
  await expect(app.getByText('1 decisions')).toBeVisible();
  expect(await exportedDecisionCount(page)).toBe(1);
  await expect(page.locator('#status')).not.toHaveAttribute('data-operation-error', '');
  await page.reload({waitUntil: 'commit'});
  await expect(app.getByText('1 decisions')).toBeVisible();
});

test('an aborted personal import preserves the prior state and retry commits once', async ({page}) => {
  await page.goto('/?personal=1', {waitUntil: 'commit'});
  await page.getByRole('button', {name: 'Open this exact version'}).click();
  const app = page.frameLocator('iframe');
  await app.getByRole('button', {name: 'Add decision'}).click();
  await expect(app.getByText('1 decisions')).toBeVisible();
  await abortNextWorkspaceWrite(page);
  // Use the public empty template to observe replacement without retaining data.
  const input = {name: 'import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({decisions: {}}))};
  await page.locator('#import-file').setInputFiles(input);
  await expect(page.locator('#status')).toContainText('Import rejected: LOCAL_COMMIT_FAILED');
  await expect(app.getByText('1 decisions')).toBeVisible();
  expect(await exportedDecisionCount(page)).toBe(1);
  await page.reload({waitUntil: 'commit'});
  await expect(app.getByText('1 decisions')).toBeVisible();
  await page.locator('#import-file').setInputFiles(input);
  await expect(app.getByText('0 decisions')).toBeVisible();
  await page.reload({waitUntil: 'commit'});
  await expect(app.getByText('0 decisions')).toBeVisible();
});

test('personal imports reject oversized files before reading and hide parser diagnostics', async ({page}) => {
  await page.goto('/?personal=1', {waitUntil: 'commit'});
  await page.getByRole('button', {name: 'Open this exact version'}).click();
  const app = page.frameLocator('iframe');
  await expect(app.getByText('0 decisions')).toBeVisible();
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    (globalThis as any).importReads = 0;
    Blob.prototype.arrayBuffer = function() { (globalThis as any).importReads += 1; return original.call(this); };
  });
  await page.locator('#import-file').setInputFiles({name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(393_217, 32)});
  await expect(page.locator('#status')).toHaveText('Import rejected: STATE_TOO_LARGE');
  expect(await page.evaluate(() => (globalThis as any).importReads)).toBe(0);
  const canary = randomBytes(32).toString('hex');
  await page.locator('#import-file').setInputFiles({name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from(canary)});
  // Compare only booleans, so a regression cannot print the generated canary.
  await expect.poll(async () => (await page.locator('#status').textContent()) === 'Import rejected: STATE_INVALID').toBe(true);
  expect((await page.locator('#status').textContent())?.includes(canary)).toBe(false);
  await app.getByRole('button', {name: 'Add decision'}).click();
  await expect(app.getByText('1 decisions')).toBeVisible();
});

for (const failure of ['abort', 'throw'] as const) {
  test(`initial personal approval is atomic on ${failure}`, async ({page}) => {
    await page.goto('/?personal=1', {waitUntil: 'commit'});
    await expect(page.getByRole('button', {name: 'Open this exact version'})).toBeVisible();
    await page.evaluate((failure) => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === 'approvals') {
          IDBObjectStore.prototype.put = put;
          if (failure === 'throw') throw new Error('TEST_APPROVAL_WRITE_FAILED');
          this.transaction.abort();
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }, failure);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.locator('#trust-description')).toHaveText('LOCAL_COMMIT_FAILED');
    await expect(page.frameLocator('iframe').getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('smallframe-personal-v1', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('TEST_DATABASE_OPEN_FAILED'));
      });
      const counts = await Promise.all(['workspaces', 'approvals'].map((name) => new Promise<number>((resolve) => {
        const request = database.transaction(name).objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
      })));
      database.close();
      return counts.every((count) => count === 0);
    })).toBe(true);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
    await page.reload({waitUntil: 'commit'});
    await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
  });
}

test('a stale personal review cannot overwrite a workspace initialized by another tab', async ({page, context}) => {
  await page.goto('/?personal=1', {waitUntil: 'commit'});
  await expect(page.getByRole('button', {name: 'Open this exact version'})).toBeVisible();
  const stale = await context.newPage();
  await stale.goto('/?personal=1', {waitUntil: 'commit'});
  await expect(stale.getByRole('button', {name: 'Open this exact version'})).toBeVisible();
  await page.getByRole('button', {name: 'Open this exact version'}).click();
  await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
  await expect(page.frameLocator('iframe').getByText('1 decisions')).toBeVisible();
  await stale.getByRole('button', {name: 'Open this exact version'}).click();
  await expect(stale.locator('#trust-description')).toHaveText('LOCAL_COMMIT_FAILED');
  await expect(stale.frameLocator('iframe').getByRole('button')).toHaveCount(0);
  await stale.reload({waitUntil: 'commit'});
  await expect(stale.frameLocator('iframe').getByText('1 decisions')).toBeVisible();
});

test('concurrent personal opens resolve one durable workspace identity', async ({page}) => {
  await page.goto('/?personal=1', {waitUntil: 'commit'});
  await expect(page.getByRole('button', {name: 'Open this exact version'})).toBeVisible();
  const result = await page.evaluate(async () => {
    const store = (globalThis as any).SmallframePersonalStore;
    const ids = await Promise.all(Array.from({length: 20}, () => store.workspaceIdFor('public-test-package-pointer')));
    const reopened = await store.workspaceIdFor('public-test-package-pointer');
    return {identities: new Set(ids).size, allDurable: ids.every((id) => id === reopened)};
  });
  expect(result).toEqual({identities: 1, allDurable: true});
});

for (const failure of ['abort', 'throw'] as const) {
  test(`personal pointer creation rejects ${failure} and permits durable retry`, async ({page}) => {
    await page.goto('/?personal=1', {waitUntil: 'commit'});
    await expect(page.getByRole('button', {name: 'Open this exact version'})).toBeVisible();
    const result = await page.evaluate(async (failure) => {
      const store = (globalThis as any).SmallframePersonalStore;
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value, key) {
        if (this.name === 'pointers') {
          IDBObjectStore.prototype.add = add;
          if (failure === 'throw') throw new Error('TEST_POINTER_WRITE_FAILED');
          const request = key === undefined ? add.call(this, value) : add.call(this, value, key);
          this.transaction.abort();
          return request;
        }
        return key === undefined ? add.call(this, value) : add.call(this, value, key);
      };
      let rejected = false;
      try { await store.workspaceIdFor('public-test-aborted-pointer'); }
      catch { rejected = true; }
      finally { IDBObjectStore.prototype.add = add; }
      const accepted = await store.workspaceIdFor('public-test-aborted-pointer');
      return {rejected, durable: accepted === await store.workspaceIdFor('public-test-aborted-pointer')};
    }, failure);
    expect(result).toEqual({rejected: true, durable: true});
  });
}
