(() => {
  type LineageTuple = {stateEpoch: number; revision: number; envelopeDigest: string};
  type LineageEdge = {from: LineageTuple; to: LineageTuple};
  type ReplicaLineage = {version: 1; gaps: LineageEdge[]; lastVerifiedEdge: LineageEdge | null; unknownPriorHistory: boolean};
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
    lineage?: ReplicaLineage;
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
    loadRoom: (roomId: string, role?: 'viewer' | 'editor') => Promise<StoredSharedRoom | undefined>;
    saveRoom: (room: StoredSharedRoom, approval?: StoredSharedApproval, generation?: string) => Promise<void>;
    forgetRoom: (roomId: string) => Promise<void>;
    generation: (roomId: string) => Promise<string>;
    loadApproval: (approvalId: string) => Promise<StoredSharedApproval | undefined>;
    saveApproval: (approval: StoredSharedApproval, generation?: string) => Promise<void>;
  };

  const openDatabase = async (): Promise<IDBDatabase> => await new Promise((resolve, reject) => {
    const request = indexedDB.open('smallframe-shared-v1', 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('rooms')) database.createObjectStore('rooms', {keyPath: 'roomId'});
      if (!database.objectStoreNames.contains('approvals')) database.createObjectStore('approvals', {keyPath: 'approvalId'});
      if (!database.objectStoreNames.contains('deviceKeys')) database.createObjectStore('deviceKeys', {keyPath: 'roomId'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('SHARED_STORAGE_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('SHARED_STORAGE_OPEN_BLOCKED'));
  });

  const readRecord = async <T>(storeName: string, key: string): Promise<T | undefined> => {
    const database = await openDatabase();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(new Error('SHARED_STORAGE_READ_FAILED'));
        transaction.onabort = () => reject(new Error('SHARED_STORAGE_READ_ABORTED'));
      });
    } finally { database.close(); }
  };

  const writeRecord = async (storeName: string, value: unknown): Promise<void> => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('SHARED_STORAGE_WRITE_FAILED'));
        transaction.onabort = () => reject(new Error('SHARED_STORAGE_WRITE_ABORTED'));
      });
    } finally { database.close(); }
  };

  const generationFor = async (roomId: string): Promise<string> => {
    const marker = await readRecord<{approvalId: string; generation: string}>('approvals', `forget:${roomId}`);
    if (!marker) return '';
    if (marker.approvalId !== `forget:${roomId}` || !/^[0-9a-f-]{36}$/u.test(marker.generation)) throw new Error('LOCAL_FORGET_MARKER_INVALID');
    return marker.generation;
  };

  const assertGeneration = async (roomId: string, expected: string): Promise<void> => {
    if (await generationFor(roomId) !== expected) throw new Error('LOCAL_ROOM_FORGOTTEN');
  };

  const forgetStoredRoom = async (roomId: string): Promise<void> => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['rooms', 'deviceKeys', 'approvals'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('SHARED_STORAGE_DELETE_FAILED'));
        transaction.onabort = () => reject(new Error('SHARED_STORAGE_DELETE_ABORTED'));
        try {
          for (const id of [roomId, storageId(roomId, 'viewer')]) {
            transaction.objectStore('rooms').delete(id);
            transaction.objectStore('deviceKeys').delete(id);
          }
          const approvals = transaction.objectStore('approvals');
          const keys = approvals.getAllKeys(IDBKeyRange.bound(`${roomId}:`, `${roomId}:\uffff`), 129);
          keys.onsuccess = () => {
            try {
              if (keys.result.length > 128) throw new Error('SHARED_APPROVAL_LIMIT');
              for (const key of keys.result) approvals.delete(key);
              approvals.put({approvalId: `forget:${roomId}`, generation: crypto.randomUUID()});
            } catch { try { transaction.abort(); } catch {} }
          };
        } catch {
          try { transaction.abort(); } catch {}
          reject(new Error('SHARED_STORAGE_DELETE_FAILED'));
        }
      });
    } finally { database.close(); }
  };

  type WrappedRoom = {version: 1; roomId: string; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer};
  const storageId = (roomId: string, role: 'viewer' | 'editor'): string => role === 'viewer' ? `${roomId}:viewer` : roomId;
  const roomAad = (id: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`smallframe/local-room/v1:${id}`);
  const loadExactRoom = async (roomId: string, id: string): Promise<StoredSharedRoom | undefined> => {
    const saved = await readRecord<WrappedRoom>('rooms', id);
    if (!saved) return undefined;
    // Old prototype records are not silently blessed as encrypted storage.
    if (saved.version !== 1 || !(saved.ciphertext instanceof ArrayBuffer)) throw new Error('LEGACY_ROOM_EXPORT_REQUIRED');
    const key = await readRecord<{key: CryptoKey}>('deviceKeys', id);
    if (!key) throw new Error('LOCAL_DEVICE_KEY_MISSING');
    const bytes = await crypto.subtle.decrypt({name: 'AES-GCM', iv: saved.nonce, additionalData: roomAad(id)}, key.key, saved.ciphertext);
    const room = JSON.parse(new TextDecoder().decode(bytes)) as StoredSharedRoom;
    if (room.roomId !== roomId) throw new Error('LOCAL_ROOM_CONTEXT_INVALID');
    return room;
  };
  const loadWrappedRoom = async (roomId: string, role?: 'viewer' | 'editor'): Promise<StoredSharedRoom | undefined> => {
    if (role === 'viewer') {
      const viewer = await loadExactRoom(roomId, storageId(roomId, 'viewer'));
      if (viewer) return viewer.role === role ? viewer : undefined;
    }
    const legacy = await loadExactRoom(roomId, roomId);
    if (legacy && (!role || legacy.role === role)) return legacy;
    if (role) return undefined;
    return await loadExactRoom(roomId, storageId(roomId, 'viewer'));
  };
  const commitWrappedRoom = async (room: WrappedRoom, key: CryptoKey, approval?: StoredSharedApproval): Promise<void> => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['deviceKeys', 'rooms', 'approvals'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('SHARED_STORAGE_WRITE_FAILED'));
        transaction.onabort = () => reject(new Error('SHARED_STORAGE_WRITE_ABORTED'));
        try {
          transaction.objectStore('deviceKeys').put({roomId: room.roomId, key});
          transaction.objectStore('rooms').put(room);
          if (approval) transaction.objectStore('approvals').put(approval);
        } catch {
          // A synchronous clone/put exception must also roll back earlier requests.
          try { transaction.abort(); } catch { /* Already aborted. */ }
          reject(new Error('SHARED_STORAGE_WRITE_FAILED'));
        }
      });
    } finally { database.close(); }
  };
  const assertCompatibleWrite = (prior: StoredSharedRoom | undefined, room: StoredSharedRoom): void => {
    if (!prior) return;
    if (prior.packageDigest !== room.packageDigest || prior.role !== room.role || prior.roomKey !== room.roomKey
      || prior.capability !== room.capability || prior.writerPrivateSeed !== room.writerPrivateSeed
      || room.stateEpoch < prior.stateEpoch
      || (room.stateEpoch === prior.stateEpoch && (room.revision < prior.revision
        || (room.revision === prior.revision && room.envelopeDigest !== prior.envelopeDigest)))) {
      throw new Error('LOCAL_STALE_WRITE');
    }
    if (prior.lineage?.unknownPriorHistory && !room.lineage?.unknownPriorHistory) throw new Error('LOCAL_STALE_WRITE');
    if (!prior.lineage && !room.lineage?.unknownPriorHistory) throw new Error('LOCAL_STALE_WRITE');
    if (prior.lineage?.gaps.some((gap, index) => JSON.stringify(room.lineage?.gaps[index]) !== JSON.stringify(gap))) {
      throw new Error('LOCAL_STALE_WRITE');
    }
  };
  const saveWrappedRoom = async (room: StoredSharedRoom, approval?: StoredSharedApproval, generation = ''): Promise<void> => {
    if (approval && (approval.roomId !== room.roomId || approval.packageDigest !== room.packageDigest || approval.role !== room.role)) {
      throw new Error('LOCAL_APPROVAL_CONTEXT_INVALID');
    }
    const id = storageId(room.roomId, room.role);
    await navigator.locks.request(`smallframe:room-storage:${room.roomId}`, async () => {
      await assertGeneration(room.roomId, generation);
      await navigator.locks.request(`smallframe:device-key:${id}`, async () => {
        if (room.role === 'editor') {
          const occupyingRoom = await loadExactRoom(room.roomId, room.roomId);
          if (occupyingRoom && occupyingRoom.role !== 'editor') throw new Error('LOCAL_STORAGE_ROLE_CONFLICT');
        }
        const prior = await loadWrappedRoom(room.roomId, room.role);
        assertCompatibleWrite(prior, room);
        const saved = await readRecord<{roomId: string; key: CryptoKey}>('deviceKeys', id);
        const key = saved?.key ?? await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: roomAad(id)}, key, new TextEncoder().encode(JSON.stringify(room)));
        // Crypto runs before the transaction; key, ciphertext and consent commit together.
        await commitWrappedRoom({version: 1, roomId: id, nonce, ciphertext}, key, approval);
      });
    });
  };
  const api: SharedStoreApi = Object.freeze({
    loadRoom: loadWrappedRoom,
    saveRoom: saveWrappedRoom,
    forgetRoom: async (roomId) => await navigator.locks.request(`smallframe:room-storage:${roomId}`,
      async () => await forgetStoredRoom(roomId)),
    generation: generationFor,
    loadApproval: async (approvalId) => await readRecord<StoredSharedApproval>('approvals', approvalId),
    saveApproval: async (approval, generation = '') => await navigator.locks.request(`smallframe:room-storage:${approval.roomId}`,
      async () => { await assertGeneration(approval.roomId, generation); await writeRecord('approvals', approval); })
  });

  Object.defineProperty(globalThis, 'SmallframeSharedStore', {value: api, enumerable: false, configurable: false, writable: false});
})();

export {};
