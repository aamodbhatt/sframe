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

  const openDatabase = async (): Promise<IDBDatabase> => await new Promise((resolve, reject) => {
    const request = indexedDB.open('smallframe-shared-v1', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('rooms')) database.createObjectStore('rooms', {keyPath: 'roomId'});
      if (!database.objectStoreNames.contains('approvals')) database.createObjectStore('approvals', {keyPath: 'approvalId'});
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

  const api: SharedStoreApi = Object.freeze({
    loadRoom: async (roomId) => await readRecord<StoredSharedRoom>('rooms', roomId),
    saveRoom: async (room) => await writeRecord('rooms', room),
    forgetRoom: async (roomId) => await deleteRecord('rooms', roomId),
    loadApproval: async (approvalId) => await readRecord<StoredSharedApproval>('approvals', approvalId),
    saveApproval: async (approval) => await writeRecord('approvals', approval)
  });

  Object.defineProperty(globalThis, 'SmallframeSharedStore', {value: api, enumerable: false, configurable: false, writable: false});
})();

export {};
