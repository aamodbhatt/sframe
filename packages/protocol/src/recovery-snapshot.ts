// Recovery object APIs accept only ordinary data records. Snapshot descriptors
// before canonicalization so accessors and inherited toJSON cannot run there.
export const recoveryDataRecord = (value: unknown, fields: readonly string[], code: string): Record<string, unknown> => {
  const invalid = (): never => { throw new Error(code); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid();
  if (Reflect.ownKeys(value).length !== fields.length) return invalid();
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    snapshot[field] = descriptor.value;
  }
  return snapshot;
};

export const recoveryDataArray = (value: unknown, maximum: number): unknown[] => {
  const invalid = (): never => { throw new Error('RECOVERY_TRANSITION_INVALID'); };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length > maximum || Reflect.ownKeys(value).length !== length + 1) return invalid();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    snapshot.push(descriptor.value);
  }
  return snapshot;
};
