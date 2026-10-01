import compiled from '../../../target/phase1-wasm/smallframe_verifier_bg.wasm';
import {initSync, wasm_verifier_self_test, wasm_verify_package} from '../../../target/phase1-wasm/smallframe_verifier.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';

initSync({module: compiled});
if (!wasm_verifier_self_test()) throw new Error('PACKAGE_VERIFIER_SELF_TEST_FAILED');

export const verifyUploadedPackage = (bytes: Uint8Array, declaredDigest: string, publisherKeyId: string):
  {packageDigest: string; artifactDigest: string; publisherKeyId: string} => {
  const result = parseUniqueJson(wasm_verify_package(bytes, declaredDigest, publisherKeyId)) as Record<string, unknown>;
  if (result.ok !== true || typeof result.packageDigest !== 'string'
      || typeof result.artifactDigest !== 'string' || result.publisherKeyId !== publisherKeyId) {
    throw new Error('PACKAGE_UPLOAD_INVALID');
  }
  return {packageDigest: result.packageDigest, artifactDigest: result.artifactDigest, publisherKeyId};
};
