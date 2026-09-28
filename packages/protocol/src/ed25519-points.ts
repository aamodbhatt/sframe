import {ExtendedPoint} from '@noble/ed25519';

// The JS verifier's RFC mode uses a cofactored equation. Reject noncanonical
// and mixed-order points so verification agrees with native strict Ed25519.
export const strictEd25519Points = (signature: Uint8Array, publicKey: Uint8Array): boolean => {
  if (signature.byteLength !== 64 || publicKey.byteLength !== 32) return false;
  try {
    return [publicKey, signature.slice(0, 32)].every((bytes) => {
      const point = ExtendedPoint.fromHex(bytes, false);
      return !point.isSmallOrder() && point.isTorsionFree();
    });
  } catch { return false; }
};
