export const readPersonalImport = async (file: Blob, maximumBytes: number): Promise<Record<string, unknown>> => {
  if (file.size > maximumBytes) throw new Error('STATE_TOO_LARGE');
  try {
    const bytes = await file.arrayBuffer();
    const body = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    // Native parser/read diagnostics can include file contents or private paths.
    throw new Error('STATE_INVALID');
  }
};
