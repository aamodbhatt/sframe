use crate::{
    CoreError, ErrorCode, Result, ValidatedManifest, canonical_json_bytes,
    encoding::{decode_base64, decode_base64url_fixed, encode_base64},
    key_id, parse_strict_json,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const PACKAGE_PAYLOAD_TYPE: &str = "application/vnd.smallframe.manifest.v1+json";

#[derive(Debug, Clone)]
pub struct DsseEnvelope {
    pub value: Value,
    pub canonical: Vec<u8>,
    pub signature: [u8; 64],
}

#[must_use]
pub fn dsse_pae(payload_type: &str, payload: &[u8]) -> Vec<u8> {
    let prefix = format!(
        "DSSEv1 {} {payload_type} {} ",
        payload_type.len(),
        payload.len()
    );
    let mut output = Vec::with_capacity(prefix.len() + payload.len());
    output.extend_from_slice(prefix.as_bytes());
    output.extend_from_slice(payload);
    output
}

#[must_use]
pub fn sign_dsse_pae(payload_type: &str, payload: &[u8], signing_key: &SigningKey) -> [u8; 64] {
    signing_key
        .sign(&dsse_pae(payload_type, payload))
        .to_bytes()
}

pub fn verify_dsse_pae(
    payload_type: &str,
    payload: &[u8],
    public_key: &[u8; 32],
    signature: &[u8; 64],
) -> Result<()> {
    let verifying_key = VerifyingKey::from_bytes(public_key).map_err(|_| {
        CoreError::new(ErrorCode::PublisherKeyInvalid, "invalid Ed25519 public key")
    })?;
    verifying_key
        .verify_strict(
            &dsse_pae(payload_type, payload),
            &Signature::from_bytes(signature),
        )
        .map_err(|_| {
            CoreError::new(
                ErrorCode::SignatureInvalid,
                "Ed25519 signature verification failed",
            )
        })
}

pub fn create_dsse_envelope(
    canonical_manifest: &[u8],
    signing_key: &SigningKey,
) -> Result<DsseEnvelope> {
    let public_key = signing_key.verifying_key().to_bytes();
    let key_id = key_id(&public_key);
    let signature = signing_key
        .sign(&dsse_pae(PACKAGE_PAYLOAD_TYPE, canonical_manifest))
        .to_bytes();
    let value = json!({
        "payloadType": PACKAGE_PAYLOAD_TYPE,
        "payload": encode_base64(canonical_manifest),
        "signatures": [{"keyid": key_id, "sig": encode_base64(&signature)}]
    });
    let canonical = canonical_json_bytes(&value)?;
    Ok(DsseEnvelope {
        value,
        canonical,
        signature,
    })
}

pub fn verify_dsse_envelope(input: &[u8], manifest: &ValidatedManifest) -> Result<DsseEnvelope> {
    let value = parse_strict_json(input)?;
    let envelope = value
        .as_object()
        .ok_or_else(|| CoreError::new(ErrorCode::DsseInvalid, "DSSE envelope must be an object"))?;
    let keys: BTreeSet<&str> = envelope.keys().map(String::as_str).collect();
    if keys != BTreeSet::from(["payload", "payloadType", "signatures"]) {
        return Err(CoreError::new(
            ErrorCode::DsseInvalid,
            "DSSE fields do not match schema",
        ));
    }
    if envelope.get("payloadType").and_then(Value::as_str) != Some(PACKAGE_PAYLOAD_TYPE) {
        return Err(CoreError::new(
            ErrorCode::DssePayloadTypeInvalid,
            "wrong DSSE payload type",
        ));
    }
    let payload = envelope
        .get("payload")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::new(ErrorCode::DsseInvalid, "missing DSSE payload"))?;
    let payload = decode_base64(payload, ErrorCode::DsseInvalid)?;
    if payload != manifest.canonical {
        return Err(CoreError::new(
            ErrorCode::DssePayloadMismatch,
            "DSSE payload is not the canonical manifest",
        ));
    }
    let signatures = envelope
        .get("signatures")
        .and_then(Value::as_array)
        .filter(|values| values.len() == 1)
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::DsseInvalid,
                "exactly one DSSE signature is required",
            )
        })?;
    let signature = signatures[0].as_object().ok_or_else(|| {
        CoreError::new(ErrorCode::DsseInvalid, "signature entry must be an object")
    })?;
    let signature_keys: BTreeSet<&str> = signature.keys().map(String::as_str).collect();
    if signature_keys != BTreeSet::from(["keyid", "sig"])
        || signature.get("keyid").and_then(Value::as_str)
            != Some(manifest.publisher_key_id.as_str())
    {
        return Err(CoreError::new(
            ErrorCode::DsseInvalid,
            "DSSE signature key ID mismatch",
        ));
    }
    let signature = signature
        .get("sig")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::new(ErrorCode::DsseInvalid, "missing signature bytes"))?;
    let signature = decode_base64(signature, ErrorCode::DsseInvalid)?;
    let signature: [u8; 64] = signature.try_into().map_err(|_| {
        CoreError::new(ErrorCode::DsseInvalid, "Ed25519 signature must be 64 bytes")
    })?;
    let public_key = decode_base64url_fixed::<32>(
        manifest
            .value
            .get("publisher")
            .and_then(|publisher| publisher.get("publicKey"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::PublisherKeyInvalid,
                    "missing publisher public key",
                )
            })?,
        ErrorCode::PublisherKeyInvalid,
    )?;
    verify_dsse_pae(
        PACKAGE_PAYLOAD_TYPE,
        &manifest.canonical,
        &public_key,
        &signature,
    )?;
    let canonical = canonical_json_bytes(&value)?;
    Ok(DsseEnvelope {
        value,
        canonical,
        signature,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pae_is_length_prefixed() {
        assert_eq!(
            dsse_pae("text/plain", b"hello"),
            b"DSSEv1 10 text/plain 5 hello"
        );
    }

    #[test]
    fn detached_pae_signature_rejects_payload_and_type_mutation() {
        let key = SigningKey::from_bytes(&[9_u8; 32]);
        let signature = sign_dsse_pae("application/vnd.smallframe.test+json", b"{}", &key);
        let public_key = key.verifying_key().to_bytes();
        verify_dsse_pae(
            "application/vnd.smallframe.test+json",
            b"{}",
            &public_key,
            &signature,
        )
        .expect("verify detached signature");
        assert_eq!(
            verify_dsse_pae(
                "application/vnd.smallframe.other+json",
                b"{}",
                &public_key,
                &signature,
            )
            .expect_err("payload type mutation must fail")
            .code(),
            ErrorCode::SignatureInvalid
        );
        assert_eq!(
            verify_dsse_pae(
                "application/vnd.smallframe.test+json",
                b"{\"x\":1}",
                &public_key,
                &signature,
            )
            .expect_err("payload mutation must fail")
            .code(),
            ErrorCode::SignatureInvalid
        );
    }
}
