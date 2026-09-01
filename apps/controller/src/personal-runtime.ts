type PersonalStoreApi = {
  workspaceIdFor: (packageDigest: string) => Promise<string>;
  loadWorkspace: (workspaceId: string) => Promise<{workspaceId: string; packageDigest: string; state: Record<string, unknown>; revision: number; updatedAt: number} | undefined>;
  saveWorkspace: (workspace: {workspaceId: string; packageDigest: string; state: Record<string, unknown>; revision: number; updatedAt: number}) => Promise<void>;
  forgetWorkspace: (workspaceId: string) => Promise<void>;
  loadApproval: (approvalId: string) => Promise<unknown>;
  saveApproval: (approval: {approvalId: string; packageDigest: string; publisherKeyId: string; capabilityHash: string; approvedAt: number}) => Promise<void>;
};
type PackageMetadata = {packageDigest: string; artifactDigest: string; publisherKeyId: string; publisherPublicKey: string; publisherDisplayName: string; appName: string; appVersion: string; description: string; capabilities: string[]; publicTemplate: Record<string, unknown>; maxPlaintextBytes: number; declaredMode: 'personal' | 'shared'};
type PersonalSession = {handleVerified: (metadata: PackageMetadata) => Promise<void>; stateChanged: (state: Record<string, unknown>, revision: number) => Promise<void>};
type SessionOptions = {archive: Uint8Array; role: 'viewer' | 'editor'; onApprove: (state: Record<string, unknown>, role: 'viewer' | 'editor') => void; onReplaceState: (state: Record<string, unknown>) => Promise<void>};

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement)) throw new Error(`PERSONAL_UI_MISSING_${id}`);
  return value as T;
};
const store = (): PersonalStoreApi => {
  const value = (globalThis as typeof globalThis & {SmallframePersonalStore?: PersonalStoreApi}).SmallframePersonalStore;
  if (!value) throw new Error('PERSONAL_STORE_MISSING');
  return value;
};
const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  return value;
};
const stableJson = (value: unknown): string => `${JSON.stringify(stableValue(value))}\n`;
const saveFile = (bytes: BlobPart, type: string, filename: string): void => {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
const short = (value: string): string => value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
const capabilityHash = async (capabilities: string[]): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(capabilities)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const safeFilename = (name: string, suffix: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40) || 'smallframe'}${suffix}`;

const createSession = (options: SessionOptions): PersonalSession => {
  let metadata: PackageMetadata | undefined;
  let workspaceId = '';
  let currentState: Record<string, unknown> = {};
  let revision = 0;
  const menu = element<HTMLButtonElement>('chrome-menu');
  const actions = element<HTMLElement>('workspace-actions');
  menu.addEventListener('click', () => {
    const open = actions.hidden;
    actions.hidden = !open;
    menu.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!actions.hidden) { actions.hidden = true; menu.setAttribute('aria-expanded', 'false'); menu.focus(); }
    else element<HTMLElement>('app-host').focus();
  });
  let connectivityProbe = 0;
  const updateConnectivity = async (): Promise<void> => {
    const generation = connectivityProbe + 1;
    connectivityProbe = generation;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1500);
    let online = false;
    try {
      const response = await fetch('/connectivity', {cache: 'no-store', signal: controller.signal});
      online = response.status === 204;
    } catch (_) {
      online = false;
    } finally {
      window.clearTimeout(timer);
    }
    if (generation === connectivityProbe) element('connectivity').textContent = online ? 'On this device' : 'Offline · on this device';
  };
  const probeConnectivity = (): void => { void updateConnectivity(); };
  window.addEventListener('online', probeConnectivity);
  window.addEventListener('offline', probeConnectivity);
  window.setInterval(probeConnectivity, 3000);
  probeConnectivity();

  const persist = async (): Promise<void> => {
    if (!metadata || !workspaceId) return;
    await store().saveWorkspace({workspaceId, packageDigest: metadata.packageDigest, state: structuredClone(currentState), revision, updatedAt: Date.now()});
    element('last-sync').textContent = `Saved locally: ${new Date().toLocaleTimeString()}`;
  };
  const approve = async (): Promise<void> => {
    if (!metadata) throw new Error('PERSONAL_APPROVAL_NOT_READY');
    const hash = await capabilityHash(metadata.capabilities);
    if ((element<HTMLInputElement>('remember-approval')).checked) await store().saveApproval({approvalId: `${workspaceId}:${metadata.packageDigest}:${metadata.publisherKeyId}:${hash}`, packageDigest: metadata.packageDigest, publisherKeyId: metadata.publisherKeyId, capabilityHash: hash, approvedAt: Date.now()});
    element('trust-panel').hidden = true;
    element('runtime-panel').hidden = false;
    options.onApprove(structuredClone(currentState), options.role);
  };
  element('approve-package').addEventListener('click', () => { void approve().catch((error: unknown) => { element('trust-description').textContent = error instanceof Error ? error.message : 'Approval failed'; }); });
  const exportPackage = (): void => { if (metadata) saveFile(options.archive, 'application/vnd.smallframe.package', safeFilename(metadata.appName, '.smallframe')); };
  element('export-package').addEventListener('click', exportPackage);
  element('review-export').addEventListener('click', exportPackage);
  element('export-json').addEventListener('click', () => { if (metadata) saveFile(stableJson(currentState), 'application/json', safeFilename(metadata.appName, '-state.json')); });
  element('import-json').addEventListener('click', () => element<HTMLInputElement>('import-file').click());
  element<HTMLInputElement>('import-file').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !metadata || options.role === 'viewer') return;
    void file.text().then(async (body) => {
      if (new TextEncoder().encode(body).byteLength > metadata!.maxPlaintextBytes) throw new Error('STATE_TOO_LARGE');
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('STATE_INVALID');
      const nextState = structuredClone(parsed as Record<string, unknown>);
      await options.onReplaceState(nextState);
      currentState = nextState;
      revision += 1;
      await persist();
    }).catch((error: unknown) => { element('status').textContent = `Import rejected: ${error instanceof Error ? error.message : 'STATE_INVALID'}`; }).finally(() => { input.value = ''; });
  });
  element('forget-workspace').addEventListener('click', () => { if (workspaceId && window.confirm('Forget this local workspace after exporting anything you need?')) void store().forgetWorkspace(workspaceId).then(() => location.reload()); });
  element('leave-package').addEventListener('click', () => { location.href = 'about:blank'; });

  return Object.freeze({
    handleVerified: async (verified) => {
      metadata = verified;
      workspaceId = await store().workspaceIdFor(verified.packageDigest);
      const saved = await store().loadWorkspace(workspaceId);
      currentState = saved?.packageDigest === verified.packageDigest ? structuredClone(saved.state) : structuredClone(verified.publicTemplate);
      revision = saved?.packageDigest === verified.packageDigest ? saved.revision : 0;
      element('app-title').textContent = verified.appName;
      element('runtime-title').textContent = verified.appName;
      element('app-version').textContent = verified.appVersion;
      element('role').textContent = options.role;
      element('digest').textContent = verified.packageDigest;
      element('publisher').textContent = verified.publisherKeyId;
      element('trust-title').textContent = verified.appName;
      element('trust-description').textContent = verified.description;
      element('trust-publisher').textContent = `${verified.publisherDisplayName} · ${short(verified.publisherKeyId)} · cryptographic key—not verified legal identity`;
      element('trust-package').textContent = `${verified.appVersion} · ${short(verified.packageDigest)}${saved ? ' · used before on this device' : ''}`;
      element('trust-context').textContent = `Signed personal ${options.role}${verified.declaredMode === 'shared' ? ' · private local copy of a shared package' : ''}`;
      element('trust-capabilities').textContent = verified.capabilities.length ? verified.capabilities.join(', ') : 'No optional capabilities';
      const hash = await capabilityHash(verified.capabilities);
      const approval = await store().loadApproval(`${workspaceId}:${verified.packageDigest}:${verified.publisherKeyId}:${hash}`);
      if (approval) await approve();
      else { element('runtime-panel').hidden = true; element('trust-panel').hidden = false; element<HTMLButtonElement>('approve-package').focus(); }
    },
    stateChanged: async (state, nextRevision) => { currentState = structuredClone(state); revision = nextRevision; await persist(); }
  });
};

Object.defineProperty(globalThis, 'SmallframePersonalRuntime', {value: Object.freeze({createSession}), enumerable: false, configurable: false, writable: false});
export {};
