type StoredWorkspace = {workspaceId: string; packageDigest: string; state: Record<string, unknown>; revision: number; updatedAt: number};
type StoredApproval = {approvalId: string; packageDigest: string; publisherKeyId: string; capabilityHash: string; approvedAt: number};
type StoredPointer = {packageDigest: string; workspaceId: string};
type StoreApi = {workspaceIdFor: (packageDigest: string) => Promise<string>; loadWorkspace: (workspaceId: string) => Promise<StoredWorkspace | undefined>; saveWorkspace: (workspace: StoredWorkspace) => Promise<void>; forgetWorkspace: (workspaceId: string) => Promise<void>; loadApproval: (approvalId: string) => Promise<StoredApproval | undefined>; saveApproval: (approval: StoredApproval) => Promise<void>};

const openDatabase = async (): Promise<IDBDatabase> => await new Promise((resolve, reject) => {
  const request = indexedDB.open('smallframe-personal-v1', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('workspaces')) database.createObjectStore('workspaces', {keyPath: 'workspaceId'});
    if (!database.objectStoreNames.contains('approvals')) database.createObjectStore('approvals', {keyPath: 'approvalId'});
    if (!database.objectStoreNames.contains('pointers')) database.createObjectStore('pointers', {keyPath: 'packageDigest'});
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('LOCAL_STORAGE_OPEN_FAILED'));
  request.onblocked = () => reject(new Error('LOCAL_STORAGE_OPEN_BLOCKED'));
});

const readRecord = async <T>(storeName: string, key: string): Promise<T | undefined> => {
  const database = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(new Error('LOCAL_STORAGE_READ_FAILED'));
      transaction.onabort = () => reject(new Error('LOCAL_STORAGE_READ_ABORTED'));
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
      transaction.onerror = () => reject(new Error('LOCAL_STORAGE_WRITE_FAILED'));
      transaction.onabort = () => reject(new Error('LOCAL_STORAGE_WRITE_ABORTED'));
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
      transaction.onerror = () => reject(new Error('LOCAL_STORAGE_DELETE_FAILED'));
      transaction.onabort = () => reject(new Error('LOCAL_STORAGE_DELETE_ABORTED'));
    });
  } finally { database.close(); }
};

const api: StoreApi = Object.freeze({
  workspaceIdFor: async (packageDigest) => {
    const existing = await readRecord<StoredPointer>('pointers', packageDigest);
    if (existing) return existing.workspaceId;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const workspaceId = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    await writeRecord('pointers', {packageDigest, workspaceId});
    return workspaceId;
  },
  loadWorkspace: async (workspaceId) => await readRecord<StoredWorkspace>('workspaces', workspaceId),
  saveWorkspace: async (workspace) => await writeRecord('workspaces', workspace),
  forgetWorkspace: async (workspaceId) => await deleteRecord('workspaces', workspaceId),
  loadApproval: async (approvalId) => await readRecord<StoredApproval>('approvals', approvalId),
  saveApproval: async (approval) => await writeRecord('approvals', approval)
});
Object.defineProperty(globalThis, 'SmallframePersonalStore', {value: api, enumerable: false, configurable: false, writable: false});
export {};
