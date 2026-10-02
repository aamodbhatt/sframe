import compiled from '../../../target/server-verifier-wasm/smallframe_server_verifier_bg.wasm';
import {initSync, wasm_verifier_self_test, wasm_inspect_package} from '../../../target/server-verifier-wasm/smallframe_server_verifier.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';

initSync({module: compiled});
if (!wasm_verifier_self_test()) throw new Error('PACKAGE_VERIFIER_SELF_TEST_FAILED');

const verified = new WeakSet<object>();
export const isVerifiedInspection = (metadata: object): boolean => verified.has(metadata);

export interface PackageManifestMetadata {appNamespace: string; semver: string; manifestJson: string}

export const verifyUploadedPackage = (bytes: Uint8Array, declaredDigest: string, publisherKeyId: string):
  {packageDigest: string; artifactDigest: string; publisherKeyId: string} & PackageManifestMetadata => {
  const result = parseUniqueJson(wasm_inspect_package(bytes, declaredDigest, publisherKeyId)) as Record<string, unknown>;
  if (result.ok !== true || typeof result.packageDigest !== 'string'
      || typeof result.manifestJson !== 'string' || typeof result.artifactDigest !== 'string' || result.publisherKeyId !== publisherKeyId) {
    throw new Error('PACKAGE_UPLOAD_INVALID');
  }
  const manifest = parseUniqueJson(result.manifestJson) as Record<string, unknown>;
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') throw new Error('PACKAGE_UPLOAD_INVALID');
  const inspection = Object.freeze({appNamespace: manifest.id, semver: manifest.version, manifestJson: result.manifestJson, packageDigest: result.packageDigest, artifactDigest: result.artifactDigest, publisherKeyId});
  verified.add(inspection);
  return inspection;
};
