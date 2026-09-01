(() => {
  type StoredSharedRoom = {
    roomId: string;
    packageDigest: string;
    role: 'viewer' | 'editor';
    roomKey: string;
    capability: string;
    writerPrivateSeed?: string;
    state: Record<string, unknown>;
    stateEpoch: number;
    revision: number;
    envelopeDigest: string;
    etag: string;
    dirty: boolean;
    actorId: string;
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
    appName: string;
    appVersion: string;
    description: string;
    capabilities: string[];
    publicTemplate: Record<string, unknown>;
    maxPlaintextBytes: number;
    declaredMode: 'personal' | 'shared';
  };

  type RoomDescriptor = {
    protocolVersion: 1;
    roomId: string;
    packageDigest: string;
    publisherKeyId: string;
    writerPublicKey: string;
    capabilityHash: string;
    role: 'viewer' | 'editor';
    expiresAt: number;
  };

  type ParsedInvite = {
    version: 1;
    descriptor: RoomDescriptor;
    descriptorSignature: Uint8Array;
    roomKey: Uint8Array;
    capability: Uint8Array;
    writerPrivateSeed?: Uint8Array | undefined;
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
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };

  const decodeBase64Url = (base64url: string): Uint8Array => {
    const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
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

  const createSession = (options: SharedSessionOptions): SharedSession => {
    const {invite, apiOrigin} = options;
    const {descriptor} = invite;
    let metadata: PackageMetadata | undefined;
    let currentState: Record<string, unknown> = {};
    let currentEpoch = 0;
    let currentRevision = 1;
    let currentDigest = encodeBase64Url(new Uint8Array(32));
    let currentEtag = `"sf1.0.1.${currentDigest}"`;
    let isEditorHoldingLock = false;
    let activeSocket: WebSocket | undefined;
    let pollTimer = 0;

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
      roleBadge.textContent = role;
    };

    const fetchRemoteState = async (): Promise<void> => {
      try {
        const res = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}/state`, {
          headers: {Authorization: capHeader, Origin: window.location.origin}
        });
        if (res.status === 304) {
          setStatus('Synced');
          return;
        }
        if (res.status === 200) {
          const etag = res.headers.get('ETag') ?? currentEtag;
          const epoch = Number(res.headers.get('X-Smallframe-State-Epoch') ?? currentEpoch);
          const rev = Number(res.headers.get('X-Smallframe-Revision') ?? currentRevision);
          const digest = res.headers.get('X-Smallframe-Envelope-Digest') ?? currentDigest;

          const buf = await res.arrayBuffer();
          let newState: Record<string, unknown> = {};
          try {
            newState = JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
          } catch {
            newState = {};
          }

          currentState = newState;
          currentEpoch = epoch;
          currentRevision = rev;
          currentDigest = digest;
          currentEtag = etag;

          setStatus('Synced');
          await options.onReplaceState(structuredClone(currentState));
        } else if (res.status === 503) {
          setStatus('Recovery required');
        }
      } catch {
        setStatus('Offline · on this device');
      }
    };

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

        ws.onopen = () => {
          setStatus('Synced');
        };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as {type: string; epoch: number; revision: number};
            if (msg.type === 'revision') {
              void fetchRemoteState();
            }
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          window.setTimeout(() => { void connectRealtime(); }, 3000);
        };
        ws.onerror = () => {
          try { ws.close(); } catch {}
        };
        activeSocket = ws;
      } catch {
        // fallback to periodic poll
        if (!pollTimer) {
          pollTimer = window.setInterval(() => { void fetchRemoteState(); }, 5000);
        }
      }
    };

    // Web Locks API
    if (role === 'editor' && navigator.locks) {
      void navigator.locks.request(`smallframe:room:${descriptor.roomId}`, async (lock) => {
        isEditorHoldingLock = true;
        await new Promise<void>(() => {
          // hold lock for session lifetime
        });
      }).catch(() => {
        isEditorHoldingLock = false;
      });
    }

    const approve = async (): Promise<void> => {
      if (!metadata) throw new Error('SHARED_APPROVAL_NOT_READY');

      if (element<HTMLInputElement>('remember-approval').checked) {
        await store().saveApproval({
          approvalId: `${descriptor.roomId}:${descriptor.packageDigest}:${descriptor.role}`,
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
      options.onApprove(structuredClone(currentState), role);

      // Start background sync
      void fetchRemoteState().then(() => {
        void connectRealtime();
      });
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

        // Initial state from template
        currentState = meta.publicTemplate ? structuredClone(meta.publicTemplate) : {};

        const approval = await store().loadApproval(`${descriptor.roomId}:${descriptor.packageDigest}:${descriptor.role}`);
        if (approval) {
          await approve();
        } else {
          element('trust-panel').hidden = false;
          element('status').textContent = 'Awaiting verification approval…';
        }
      },

      stateChanged: async (state, _rev) => {
        if (role !== 'editor') return;
        currentState = structuredClone(state);
        setStatus('Syncing…');

        try {
          const nextRev = currentRevision + 1;
          const payloadBytes = new TextEncoder().encode(JSON.stringify(currentState));

          const res = await fetch(`${apiOrigin}/v1/rooms/${descriptor.roomId}/state`, {
            method: 'PUT',
            headers: {
              Authorization: capHeader,
              'Content-Type': 'application/octet-stream',
              'If-Match': currentEtag,
              Origin: window.location.origin
            },
            body: payloadBytes
          });

          if (res.status === 204 || res.status === 200) {
            currentRevision = nextRev;
            currentEtag = res.headers.get('ETag') ?? currentEtag;
            setStatus('Synced');
          } else if (res.status === 409) {
            // Conflict: refetch and merge
            await fetchRemoteState();
          } else {
            setStatus('On this device');
          }
        } catch {
          setStatus('Offline · on this device');
        }
      },

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
