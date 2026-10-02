export class PublisherStorageError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function fail(status: number, code: string): never { throw new PublisherStorageError(status, code); }
