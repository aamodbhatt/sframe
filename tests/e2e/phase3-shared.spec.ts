import {expect, test} from '@playwright/test';
import {getPublicKeyAsync} from '@noble/ed25519';
import {
  createSignedRoomDescriptor,
  formatInviteFragment,
  encodeBase64Url,
  decodeBase64Url
} from '../../packages/protocol/src/index.js';

test.describe('Phase 3 encrypted shared rooms & collaborative runtime', () => {
  const publisherPriv = new Uint8Array(32).fill(0x55);
  const roomKey = new Uint8Array(32).fill(0x42);
  const writerPriv = new Uint8Array(32).fill(0x33);
  const viewerCap = new Uint8Array(32).fill(0xaa);
  const editorCap = new Uint8Array(32).fill(0xbb);
  const rawRoomId = new Uint8Array(16).fill(0x19);
  const roomId = encodeBase64Url(rawRoomId);

  test.beforeEach(async ({context}) => {
    await context.clearCookies();
  });

  test('scrubs invite fragment synchronously, opens shared editor, edits state, and enforces viewer mode', async ({page, context}) => {
    const packageDigest = 'VyYD4sVLFttWpR3_Eu-zcg_jkRj3BWqx2kBvwl1HbzE';
    const publisherKeyId = 'sha256:T80bER4SmCMIgBOzsTLd-6Rp5b1l0lPoeA3LbSERsY8';
    const writerPub = await getPublicKeyAsync(writerPriv);

    // 1. Create Editor invite
    const editorDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: Date.now() + 86_400_000
    });

    const editorFragment = formatInviteFragment({
      descriptorJcsBytes: editorDesc.jcsBytes,
      descriptorSignature: editorDesc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    // Navigate to invite URL with fragment
    await page.goto(`/#${editorFragment}`);

    // Verify fragment is scrubbed synchronously from address bar
    await expect(page).toHaveURL(/^http:\/\/app\.localhost:4173\/?$/);
    expect(page.url().includes('#')).toBe(false);

    // Verify Trust panel
    await expect(page.getByRole('heading', {name: 'Decision Board', level: 2})).toBeVisible();
    await expect(page.locator('#trust-context')).toContainText('Encrypted shared room (editor)');

    // Approve
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await expect(page.locator('#role')).toHaveText('editor');

    // Add a decision
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();

    // Verify workspace menu
    await page.getByRole('button', {name: 'Workspace'}).click();
    await expect(page.getByRole('button', {name: 'Export readable JSON'})).toBeVisible();

    // 2. Open Viewer invite in second page
    const viewerDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: viewerCap,
      role: 'viewer',
      expiresAt: Date.now() + 86_400_000
    });

    const viewerFragment = formatInviteFragment({
      descriptorJcsBytes: viewerDesc.jcsBytes,
      descriptorSignature: viewerDesc.signature,
      roomKey,
      capability: viewerCap
    });

    const viewerPage = await context.newPage();
    await viewerPage.goto(`/#${viewerFragment}`);

    // Verify fragment scrubbed
    expect(viewerPage.url().includes('#')).toBe(false);
    await expect(viewerPage.locator('#trust-context')).toContainText('Encrypted shared room (viewer)');

    // Approve viewer
    await viewerPage.getByRole('button', {name: 'Open this exact version'}).click();
    const viewerApp = viewerPage.frameLocator('iframe');
    await expect(viewerPage.locator('#role')).toHaveText('viewer');

    // Viewer cannot add decisions
    await viewerApp.getByRole('button', {name: 'Add decision'}).click();
    // Remains 0 decisions in fresh viewer state
    await expect(viewerApp.getByText('0 decisions')).toBeVisible();

    await viewerPage.close();
  });
});
