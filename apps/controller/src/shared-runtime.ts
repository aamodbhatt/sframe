import {authenticateInvite, verifyInviteRelayContext} from '../../../packages/protocol/src/room-descriptor.js';
import type {ParsedInvite} from '../../../packages/protocol/src/room-descriptor.js';

(() => {
  type StoredSharedRoom = {
    roomId: string;
    packageDigest: string;
    role: 'viewer' | 'editor';
    roomKey: string;
    capability: string;
    writerPrivateSeed?: string | undefined;
    state: Record<string, unknown>;
    stateEpoch: number;
    revision: number;
    envelopeDigest: string;
    etag: string;
    dirty: boolean;
    actorId: string;
    automergeBase64?: string | undefined;
    updatedAt: number;
  };

  type StoredSharedApproval = {
    approvalId: string;
    roomId: string;
    packageDigest: string;
    publisherKeyId: string;
    capabilityHash: string;
    role: 'viewer' | 'editor';
    approvedAt: number;
    descriptorDigest: string;
    capabilities: string[];
  };

  type SharedStoreApi = {
    loadRoom: (roomId: string) => Promise<StoredSharedRoom | undefined>;
    saveRoom: (room: StoredSharedRoom) => Promise<void>;
    forgetRoom: (roomId: string) => Promise<void>;
    loadApproval: (approvalId: string) => Promise<StoredSharedApproval | undefined>;
    saveApproval: (approval: StoredSharedApproval) => Promise<void>;
  };

  type PackageMetadata = {
    packageDigest: string;
    artifactDigest: string;
    publisherKeyId: string;
    publisherPublicKey: string;
    publisherDisplayName: string;
    appId: string;
    appName: string;
    appVersion: string;
    description: string;
    capabilities: string[];
    publicTemplate: Record<string, unknown>;
    stateSchema: Record<string, unknown>;
    maxPlaintextBytes: number;
    declaredMode: 'personal' | 'shared';
  };

  type SharedSession = {
    handleVerified: (metadata: PackageMetadata) => Promise<void>;
    stateChanged: (state: Record<string, unknown>, revision: number) => Promise<void>;
    setBuildId?: (buildId: string) => void;
    showUpdateBanner?: (waitingWorker: ServiceWorker) => void;
  };

  type SharedSessionOptions = {
    invite: ParsedInvite;
    archive: Uint8Array;
    apiOrigin: string;
    onApprove: (state: Record<string, unknown>, role: 'viewer' | 'editor') => void;
    onReplaceState: (state: Record<string, unknown>) => Promise<void>;
  };

  type StateWorkerResponse = {
    id: number;
    ok: boolean;
    error?: string;
    bytes?: Uint8Array;
    projectedState?: Record<string, unknown>;
    envelope?: unknown;
    envelopeDigest?: string;
    etag?: string;
  };

  class StateWorkerClient {
    private readonly worker: Worker;
    private nextId = 1;
    private readonly pending = new Map<number, {resolve: (res: any) => void; reject: (err: any) => void; timer: number}>();
    private stopped = false;

    constructor() {
      const helper = (globalThis as typeof globalThis & {__smallframeScriptUrl?: (url: string) => unknown}).__smallframeScriptUrl;
      const script = helper ? helper('/state-worker.js') as string : '/state-worker.js';
      this.worker = new Worker(script);
      this.worker.onmessage = (event: MessageEvent<StateWorkerResponse>) => {
        const {id, ok, error, ...data} = event.data;
        const entry = this.pending.get(id);
        if (!entry) return;
        window.clearTimeout(entry.timer);
        this.pending.delete(id);
        if (ok) entry.resolve(data);
        else entry.reject(new Error(typeof error === 'string' && /^[A-Z_]{1,64}$/u.test(error) ? error : 'STATE_WORKER_REJECTED'));
      };
      this.worker.onerror = () => this.failClosed();
      this.worker.onmessageerror = () => this.failClosed();
    }

    private failClosed(): void {
      this.stopped = true;
      this.worker.terminate();
      for (const entry of this.pending.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new Error('STATE_WORKER_STOPPED'));
      }
      this.pending.clear();
    }

    stop(): void { this.failClosed(); }

    async genesis(initialJson: string, actorIdHex: string): Promise<{bytes: Uint8Array; projectedState: Record<string, unknown>}> {
      return this.call('genesis', {initialJson, actorIdHex});
    }

    async applyPatch(docBytes: Uint8Array, patchJson: string, actorIdHex: string): Promise<{bytes: Uint8Array; projectedState: Record<string, unknown>}> {
      return this.call('apply_patch', {docBytes, patchJson, actorIdHex});
    }

    async merge(localBytes: Uint8Array, remoteBytes: Uint8Array, stateSchemaJson: string, maxPlaintextBytes: number): Promise<{bytes: Uint8Array; projectedState: Record<string, unknown>}> {
      return this.call('merge', {localBytes, remoteBytes, stateSchemaJson, maxPlaintextBytes});
    }

    async encrypt(params: {
      roomKey: Uint8Array;
      writerPrivateKey: Uint8Array;
      roomId: string;
      appId?: string;
      packageDigest: string;
      stateEpoch: number;
      proposedRevision: number;
      previousEnvelopeDigest: string;
      automergeBytes: Uint8Array;
    }): Promise<{envelope: unknown; envelopeDigest: string; etag: string}> {
      return this.call('encrypt', params);
    }

    async decrypt(params: {
      roomKey: Uint8Array;
      expectedWriterPublicKey?: Uint8Array | undefined;
      expectedAppId?: string | undefined;
      roomId: string;
      packageDigest: string;
      stateSchemaJson: string;
      maxPlaintextBytes: number;
      envelope: unknown;
    }): Promise<{automergeBytes: Uint8Array; projectedState: Record<string, unknown>; envelopeDigest: string; etag: string}> {
      return this.call('decrypt', params);
    }

    private call<T>(type: string, args: Record<string, unknown>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (this.stopped) { reject(new Error('STATE_WORKER_STOPPED')); return; }
        const id = this.nextId++;
        const timer = window.setTimeout(() => this.failClosed(), 1000);
        this.pending.set(id, {resolve, reject, timer});
        this.worker.postMessage({id, type, ...args});
      });
    }
  }

  const element = <T extends HTMLElement>(id: string): T => {
    const value = document.getElementById(id);
    if (!(value instanceof HTMLElement)) throw new Error(`SHARED_UI_MISSING_${id}`);
    return value as T;
  };

  const store = (): SharedStoreApi => {
    const value = (globalThis as typeof globalThis & {SmallframeSharedStore?: SharedStoreApi}).SmallframeSharedStore;
    if (!value) throw new Error('SHARED_STORE_MISSING');
    return value;
  };

  const encodeBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };

  const decodeBase64Url = (base64url: string): Uint8Array => {
    const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, stableValue(child)])
      );
    }
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

  const safeFilename = (name: string, suffix: string): string =>
    `${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40) || 'smallframe'}${suffix}`;

  const randomActorIdHex = (): string => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < bytes.byteLength; i += 1) hex += bytes[i]!.toString(16).padStart(2, '0');
    return hex;
  };

  const createSession = (options: SharedSessionOptions): SharedSession => {
    const {invite, apiOrigin} = options;
    const {descriptor} = invite;
    let metadata: PackageMetadata | undefined;
    let currentState: Record<string, unknown> = {};
    let currentAppId: string | undefined;
    let localDocBytes: Uint8Array | undefined;
    let actorIdHex = randomActorIdHex();
    let currentEpoch = 0;
    let currentRevision = 1;
    let currentDigest = encodeBase64Url(new Uint8Array(32));
    let currentEtag = `"sf1.0.1.${currentDigest}"`;
    let isEditorHoldingLock = false;
    let activeSocket: WebSocket | undefined;
    let pollTimer = 0;
    let dirty = false;
    let remembered = false;
    let approved = false;
    let authenticated = false;
    let savedApproval: StoredSharedApproval | undefined;
    const descriptorDigest = encodeBase64Url(invite.descriptorDigest);
    const approvalId = `${descriptor.roomId}:${descriptorDigest}`;
    const assertNotExpired = (): void => {
      if (Date.now() >= descriptor.expiresAt) throw new Error('INVITE_EXPIRED');
    };
    const matchesApproval = (approval: StoredSharedApproval | undefined): boolean => Boolean(metadata && approval
      && approval.approvalId === approvalId && approval.descriptorDigest === descriptorDigest
      && approval.roomId === descriptor.roomId && approval.packageDigest === descriptor.packageDigest
      && approval.publisherKeyId === descriptor.publisherKeyId && approval.capabilityHash === descriptor.capabilityHash
      && approval.role === descriptor.role && stableJson(approval.capabilities) === stableJson(metadata.capabilities));
    const checkRelayContext = async (): Promise<void> => {
      assertNotExpired();
      let response: Response;
      try {
        response = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}`, {
          headers: {Authorization: capHeader}, signal: AbortSignal.timeout(5000)
        });
      } catch (error) {
        // Offline reopening is allowed only for this exact previously approved link.
        // An HTTP rejection or a metadata mismatch never takes this fallback.
        if (matchesApproval(savedApproval) && localDocBytes && (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError'))) return;
        throw new Error('ROOM_METADATA_UNAVAILABLE');
      }
      if (!response.ok) throw new Error('ROOM_ACCESS_REJECTED');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('ROOM_METADATA_INVALID');
      let json = '';
      let size = 0;
      const decoder = new TextDecoder('utf-8', {fatal: true});
      try {
        for (;;) {
          const {value, done} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) throw new Error('ROOM_METADATA_TOO_LARGE');
          json += decoder.decode(value, {stream: true});
        }
        verifyInviteRelayContext(invite, JSON.parse(json + decoder.decode()));
      } finally { await reader.cancel(); }
    };
    let queue: Promise<unknown> = Promise.resolve();
    const serialized = <T>(action: () => Promise<T>): Promise<T> => {
      const result = queue.then(action);
      queue = result.catch(() => undefined);
      return result;
    };

    let worker = new StateWorkerClient();
    const guardedRemote = async <T>(action: (active: StateWorkerClient) => Promise<T>): Promise<T> => {
      try { return await action(worker); }
      catch {
        worker.stop();
        worker = new StateWorkerClient();
        throw new Error('REMOTE_STATE_INVALID');
      }
    };
    const role = descriptor.role;
    const capHeader = `SF-Cap ${encodeBase64Url(invite.capability)}`;

    // UI elements
    const menu = element<HTMLButtonElement>('chrome-menu');
    const actions = element<HTMLElement>('workspace-actions');
    menu.addEventListener('click', () => {
      const open = actions.hidden;
      actions.hidden = !open;
      menu.setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!actions.hidden) {
        actions.hidden = true;
        menu.setAttribute('aria-expanded', 'false');
        menu.focus();
      } else {
        element<HTMLElement>('app-host').focus();
      }
    });

    const setStatus = (statusText: string): void => {
      const connectivity = element('connectivity');
      connectivity.textContent = statusText;
    };

    const updateRoleBadge = (): void => {
      const roleBadge = element('role');
      if (role === 'editor' && !isEditorHoldingLock) {
        roleBadge.textContent = 'editor (read-only lease)';
      } else {
        roleBadge.textContent = role;
      }
    };

    const persistRoom = async (dirty: boolean): Promise<void> => {
      if (!remembered || !isEditorHoldingLock) return;
        await store().saveRoom({
          roomId: descriptor.roomId,
          packageDigest: descriptor.packageDigest,
          role,
          roomKey: encodeBase64Url(invite.roomKey),
          capability: encodeBase64Url(invite.capability),
          writerPrivateSeed: invite.writerPrivateSeed ? encodeBase64Url(invite.writerPrivateSeed) : undefined,
          state: currentState,
          stateEpoch: currentEpoch,
          revision: currentRevision,
          envelopeDigest: currentDigest,
          etag: currentEtag,
          dirty,
          actorId: actorIdHex,
          automergeBase64: localDocBytes ? encodeBase64Url(localDocBytes) : undefined,
          updatedAt: Date.now()
        });
        element('last-sync').textContent = `Saved locally: ${new Date().toLocaleTimeString()}`;
    };

    const fetchRemoteState = async (): Promise<void> => {
      assertNotExpired();
      try {
        const res = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}/state`, {
          headers: {
            Authorization: capHeader,
            Accept: 'application/json',
            Origin: window.location.origin
          }
        });
        if (res.status === 304) return;
        if (res.status === 503) {
          setStatus('Recovery required');
          throw new Error('RECOVERY_REQUIRED');
        }
        if (res.status === 200) {
          const contentType = res.headers.get('Content-Type') ?? '';
          if (contentType.includes('application/json')) {
            const wireEnvelope = await res.json();
            const decrypted = await guardedRemote(async (active) => active.decrypt({
              roomKey: invite.roomKey,
              expectedWriterPublicKey: descriptor.writerPublicKey ? decodeBase64Url(descriptor.writerPublicKey) : undefined,
              expectedAppId: metadata?.appId,
              roomId: descriptor.roomId,
              packageDigest: descriptor.packageDigest,
              stateSchemaJson: stableJson(metadata!.stateSchema),
              maxPlaintextBytes: metadata!.maxPlaintextBytes,
              envelope: wireEnvelope
            }));

            if (localDocBytes) {
              if (wireEnvelope.stateEpoch !== currentEpoch) throw new Error('RECOVERY_TRANSITION_REQUIRED');
              if (wireEnvelope.proposedRevision < currentRevision) throw new Error('REMOTE_ROLLBACK');
              if (wireEnvelope.proposedRevision === currentRevision && decrypted.envelopeDigest !== currentDigest) throw new Error('REMOTE_EQUIVOCATION');
              if (wireEnvelope.proposedRevision === currentRevision + 1 && wireEnvelope.previousEnvelopeDigest !== currentDigest) throw new Error('PREDECESSOR_MISMATCH');
              const merged = await guardedRemote(async (active) => active.merge(localDocBytes!, decrypted.automergeBytes, stableJson(metadata!.stateSchema), metadata!.maxPlaintextBytes));
              if (approved) await options.onReplaceState(structuredClone(merged.projectedState));
              localDocBytes = merged.bytes;
              currentState = merged.projectedState;
            } else {
              localDocBytes = decrypted.automergeBytes;
              currentState = decrypted.projectedState;
            }

            currentEpoch = wireEnvelope.stateEpoch;
            currentAppId = metadata?.appId;
            currentRevision = wireEnvelope.proposedRevision;
            currentDigest = decrypted.envelopeDigest;
            currentEtag = res.headers.get('ETag') ?? decrypted.etag;
          } else {
            throw new Error('SIGNED_ENVELOPE_REQUIRED');
          }

          setStatus(dirty ? 'Saved locally · pending sync' : 'Synced');
          await persistRoom(dirty);
        } else {
          throw new Error('RELAY_UNAVAILABLE');
        }
      } catch (error) {
        setStatus('Sync paused · local copy retained');
        throw error;
      }
    };

    const syncRoom = async (): Promise<void> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await fetchRemoteState();
        if (!dirty || !isEditorHoldingLock || !invite.writerPrivateSeed || !localDocBytes) return;
        const encrypted = await worker.encrypt({roomKey: invite.roomKey, writerPrivateKey: invite.writerPrivateSeed,
          roomId: descriptor.roomId, ...(currentAppId ? {appId: currentAppId} : {}), packageDigest: descriptor.packageDigest, stateEpoch: currentEpoch,
          proposedRevision: currentRevision + 1, previousEnvelopeDigest: currentDigest, automergeBytes: localDocBytes});
        const res = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}/state`, {method: 'PUT',
          headers: {Authorization: capHeader, 'Content-Type': 'application/json', 'If-Match': currentEtag},
          body: JSON.stringify(encrypted.envelope)});
        if (res.ok) {
          currentRevision += 1;
          currentDigest = encrypted.envelopeDigest;
          currentEtag = encrypted.etag;
          dirty = false;
          await persistRoom(false);
          setStatus('Synced');
          return;
        }
        if (res.status !== 409) throw new Error('RELAY_WRITE_REJECTED');
        await new Promise((resolve) => window.setTimeout(resolve, Math.random() * 50 * 2 ** attempt));
      }
      setStatus('Saved locally · pending sync');
    };
    const requestSync = (): void => {
      void serialized(syncRoom).catch(() => setStatus('Sync paused · local copy retained'));
    };
    window.addEventListener('online', requestSync);
    window.addEventListener('focus', () => { if (approved) requestSync(); });

    const connectRealtime = async (): Promise<void> => {
      if (typeof WebSocket === 'undefined') return;
      try {
        const ticketRes = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}/events-ticket`, {
          method: 'POST',
          headers: {Authorization: capHeader, Origin: window.location.origin}
        });
        if (!ticketRes.ok) return;
        const {ticket} = (await ticketRes.json()) as {ticket: string};
        const wsUrl = `${apiOrigin.replace(/^http/u, 'ws')}/v1/rooms/${descriptor.roomId}/socket`;
        const ws = new WebSocket(wsUrl, ['smallframe.v1', `sf-ticket.${ticket}`]);

        ws.onopen = () => { setStatus('Synced'); };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as {type: string; epoch: number; revision: number};
            if (msg.type === 'revision') {
              requestSync();
            }
          } catch {}
        };
        ws.onclose = () => {
          window.setTimeout(() => { void connectRealtime(); }, 3000);
        };
        ws.onerror = () => {
          try { ws.close(); } catch {}
        };
        activeSocket = ws;
      } catch {
        if (!pollTimer) {
          pollTimer = window.setInterval(() => { if (!document.hidden && navigator.onLine) requestSync(); }, 600_000);
        }
      }
    };

    let resolveLease: (() => void) | undefined;
    const leasePromise = new Promise<void>((resolve) => { resolveLease = resolve; });

    // Web Locks API
    if (role === 'editor' && typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks.request(`smallframe:room:${descriptor.roomId}`, {ifAvailable: true}, async (lock) => {
        if (!lock) {
          isEditorHoldingLock = false;
          updateRoleBadge();
          resolveLease?.();
          return;
        }
        isEditorHoldingLock = true;
        updateRoleBadge();
        resolveLease?.();
        await new Promise<void>(() => {});
      }).catch(() => {
        isEditorHoldingLock = false;
        updateRoleBadge();
        resolveLease?.();
      });
    } else {
      resolveLease?.();
    }

    const approve = async (): Promise<void> => {
      await leasePromise;
      if (!metadata || !authenticated) throw new Error('SHARED_APPROVAL_NOT_READY');
      await checkRelayContext();

      remembered = element<HTMLInputElement>('remember-approval').checked;
      try { await serialized(fetchRemoteState); }
      catch (error) { if (!localDocBytes) throw error; }
      if (!localDocBytes) throw new Error('VERIFIED_GENESIS_UNAVAILABLE');

      if (element<HTMLInputElement>('remember-approval').checked) {
        await store().saveApproval({
          approvalId,
          descriptorDigest,
          capabilities: metadata.capabilities,
          roomId: descriptor.roomId,
          packageDigest: descriptor.packageDigest,
          publisherKeyId: descriptor.publisherKeyId,
          capabilityHash: descriptor.capabilityHash,
          role,
          approvedAt: Date.now()
        });
      }

      element('trust-panel').hidden = true;
      element('runtime-panel').hidden = false;
      updateRoleBadge();
      approved = true;
      options.onApprove(structuredClone(currentState), role === 'editor' && isEditorHoldingLock ? 'editor' : 'viewer');

      void connectRealtime();
      if (dirty) window.setTimeout(requestSync, 0);
    };

    element('approve-package').addEventListener('click', () => {
      void approve().catch((error: unknown) => {
        element('trust-description').textContent = error instanceof Error ? error.message : 'Approval failed';
      });
    });

    const exportPackage = (): void => {
      if (metadata) saveFile(options.archive, 'application/vnd.smallframe.package', safeFilename(metadata.appName, '.smallframe'));
    };

    const exportJson = (): void => {
      if (!metadata) return;
      saveFile(
        stableJson({
          schemaVersion: 1,
          roomId: descriptor.roomId,
          packageDigest: descriptor.packageDigest,
          role,
          stateEpoch: currentEpoch,
          revision: currentRevision,
          exportedAt: new Date().toISOString(),
          state: currentState
        }),
        'application/json',
        safeFilename(`${metadata.appName}-room-${descriptor.roomId}`, '.json')
      );
    };

    element('export-package').addEventListener('click', exportPackage);
    element('export-json').addEventListener('click', exportJson);
    element('review-export').addEventListener('click', exportPackage);
    element('leave-package').addEventListener('click', () => { window.location.href = 'about:blank'; });

    return {
      handleVerified: async (meta) => {
        await authenticateInvite(invite, meta, location.pathname);
        metadata = meta;
        element('app-title').textContent = meta.appName;
        element('app-version').textContent = meta.appVersion;
        element('runtime-title').textContent = meta.appName;
        element('trust-title').textContent = meta.appName;
        element('trust-publisher').textContent = `${meta.publisherDisplayName} · ${short(meta.publisherKeyId)} · cryptographic key—not verified legal identity`;
        element('trust-package').textContent = `${meta.appVersion} · ${short(meta.packageDigest)}`;
        element('trust-context').textContent = `Encrypted shared room (${role})`;
        element('trust-capabilities').textContent = meta.capabilities.length ? meta.capabilities.join(', ') : 'No optional capabilities';
        element('digest').textContent = meta.packageDigest;
        element('publisher').textContent = `${meta.publisherDisplayName} · ${meta.publisherKeyId}`;
        element('trust-description').textContent = meta.description || 'No description provided.';
        updateRoleBadge();

        const storedRoom = await store().loadRoom(descriptor.roomId);
        if (storedRoom && storedRoom.packageDigest === descriptor.packageDigest && storedRoom.role === role
          && storedRoom.capability === encodeBase64Url(invite.capability) && storedRoom.roomKey === encodeBase64Url(invite.roomKey)
          && storedRoom.writerPrivateSeed === (invite.writerPrivateSeed ? encodeBase64Url(invite.writerPrivateSeed) : undefined)) {
          actorIdHex = storedRoom.actorId;
          currentEpoch = storedRoom.stateEpoch;
          currentRevision = storedRoom.revision;
          currentDigest = storedRoom.envelopeDigest;
          currentEtag = storedRoom.etag;
          currentState = storedRoom.state;
          dirty = storedRoom.dirty;
          if (storedRoom.automergeBase64) {
            localDocBytes = decodeBase64Url(storedRoom.automergeBase64);
          }
        } else {
          currentState = meta.publicTemplate ? structuredClone(meta.publicTemplate) : {};
          // Shared replicas must load publisher-created history from the relay.
        }

        savedApproval = await store().loadApproval(approvalId);
        await checkRelayContext();
        authenticated = true;
        if (matchesApproval(savedApproval)) {
          await approve();
        } else {
          element('trust-panel').hidden = false;
          element('status').textContent = 'Awaiting verification approval…';
        }
      },

      stateChanged: async (state, _rev) => serialized(async () => {
        assertNotExpired();
        await leasePromise;
        if (role !== 'editor' || !isEditorHoldingLock || !invite.writerPrivateSeed || !localDocBytes) throw new Error('READ_ONLY');
        currentState = structuredClone(state);
        setStatus('Syncing…');

        try {
          const patchRes = await worker.applyPatch(localDocBytes, JSON.stringify(currentState), actorIdHex);
          localDocBytes = patchRes.bytes;
          currentState = patchRes.projectedState;

          dirty = true;
          await persistRoom(true);
          window.setTimeout(requestSync, 0);
        } catch {
          setStatus('Local save failed');
          throw new Error('LOCAL_COMMIT_FAILED');
        }
      }),

      setBuildId: (buildId) => {
        element('build').textContent = `Verified renderer ${short(metadata?.packageDigest ?? '')} · Build ${short(buildId)}`;
      },

      showUpdateBanner: (waitingWorker) => {
        const banner = element('update-banner');
        banner.hidden = false;
        element('apply-update').onclick = () => {
          waitingWorker.postMessage({type: 'sf.release.skipWaiting'});
          window.location.reload();
        };
        element('dismiss-update').onclick = () => {
          banner.hidden = true;
        };
      }
    };
  };

  Object.defineProperty(globalThis, 'SmallframeSharedRuntime', {
    value: {createSession},
    enumerable: false,
    configurable: false,
    writable: false
  });
})();

export {};
