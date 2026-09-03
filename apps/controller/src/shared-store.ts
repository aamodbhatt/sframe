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

  const deleteRecord = async (storeName: string, key: string): Promise<void> => {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('SHARED_STORAGE_DELETE_FAILED'));
        transaction.onabort = () => reject(new Error('SHARED_STORAGE_DELETE_ABORTED'));
      });
    } finally { database.close(); }
  };

  type WrappedRoom = {version: 1; roomId: string; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer};
  const deviceKey = async (roomId: string): Promise<CryptoKey> => navigator.locks.request(`smallframe:device-key:${roomId}`, async () => {
    const saved = await readRecord<{roomId: string; key: CryptoKey}>('deviceKeys', roomId);
    if (saved) return saved.key;
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    await writeRecord('deviceKeys', {roomId, key});
    return key;
  });
  const roomAad = (roomId: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`smallframe/local-room/v1:${roomId}`);
  const loadWrappedRoom = async (roomId: string): Promise<StoredSharedRoom | undefined> => {
    const saved = await readRecord<WrappedRoom>('rooms', roomId);
    if (!saved) return undefined;
    // Old prototype records are not silently blessed as encrypted storage.
    if (saved.version !== 1 || !(saved.ciphertext instanceof ArrayBuffer)) throw new Error('LEGACY_ROOM_EXPORT_REQUIRED');
    const key = await readRecord<{key: CryptoKey}>('deviceKeys', roomId);
    if (!key) throw new Error('LOCAL_DEVICE_KEY_MISSING');
    const bytes = await crypto.subtle.decrypt({name: 'AES-GCM', iv: saved.nonce, additionalData: roomAad(roomId)}, key.key, saved.ciphertext);
    const room = JSON.parse(new TextDecoder().decode(bytes)) as StoredSharedRoom;
    if (room.roomId !== roomId) throw new Error('LOCAL_ROOM_CONTEXT_INVALID');
    return room;
  };
  const saveWrappedRoom = async (room: StoredSharedRoom): Promise<void> => {
    const key = await deviceKey(room.roomId);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: roomAad(room.roomId)}, key, new TextEncoder().encode(JSON.stringify(room)));
    await writeRecord('rooms', {version: 1, roomId: room.roomId, nonce, ciphertext});
  };
  const api: SharedStoreApi = Object.freeze({
    loadRoom: loadWrappedRoom,
    saveRoom: saveWrappedRoom,
    forgetRoom: async (roomId) => await deleteRecord('rooms', roomId),
    loadApproval: async (approvalId) => await readRecord<StoredSharedApproval>('approvals', approvalId),
    saveApproval: async (approval) => await writeRecord('approvals', approval)
  });

  Object.defineProperty(globalThis, 'SmallframeSharedStore', {value: api, enumerable: false, configurable: false, writable: false});
})();

export {};
