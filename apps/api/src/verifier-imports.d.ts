declare module '*smallframe_verifier.js' {
  export function initSync(input: {module: WebAssembly.Module}): unknown;
  export function wasm_verifier_self_test(): boolean;
  export function wasm_verify_package(bytes: Uint8Array, digest: string, keyId: string): string;
}
declare module '*smallframe_server_verifier.js' {
  export function wasm_inspect_package(bytes: Uint8Array, digest: string, keyId: string): string;
  export function initSync(input: {module: WebAssembly.Module}): unknown;
  export function wasm_verifier_self_test(): boolean;
  export function wasm_verify_package(bytes: Uint8Array, digest: string, keyId: string): string;
}
declare module '*.wasm' {
  const compiled: WebAssembly.Module;
  export default compiled;
}

declare module '*.sql' { const sql: string; export default sql; }
