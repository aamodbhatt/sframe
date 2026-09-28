use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

fn decode_fixed<const N: usize>(encoded: &str) -> Result<[u8; N], String> {
    let bytes = Base64UrlUnpadded::decode_vec(encoded)
        .map_err(|_| "ENVELOPE_CONTEXT_INVALID".to_owned())?;
    if Base64UrlUnpadded::encode_string(&bytes) != encoded {
        return Err("ENVELOPE_CONTEXT_INVALID".to_owned());
    }
    bytes
        .try_into()
        .map_err(|_| "ENVELOPE_CONTEXT_INVALID".to_owned())
}

fn canonical(value: &Value) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(value).map_err(|_| "ENVELOPE_CANONICALIZE_FAILED".to_owned())
}

fn hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

pub fn encrypt_genesis(
    room_key: &[u8; 32],
    writer: &SigningKey,
    room_id: &str,
    app_id: &str,
    package_digest: &str,
    automerge: &[u8],
) -> Result<Value, String> {
    let raw_room_id = decode_fixed::<16>(room_id)?;
    let raw_package_digest = decode_fixed::<32>(package_digest)?;
    if automerge.len() > 475_136 {
        return Err("GENESIS_SIZE_LIMIT".to_owned());
    }
    let previous = [0_u8; 32];
    let previous_encoded = Base64UrlUnpadded::encode_string(&previous);
    let mut envelope_salt = [0_u8; 16];
    OsRng.fill_bytes(&mut envelope_salt);
    let hkdf_salt = hash(&[b"smallframe/state/salt/v1\0", &raw_room_id, &envelope_salt]);
    let mut info = b"smallframe/state/key/v1\0".to_vec();
    info.extend_from_slice(&0_u64.to_be_bytes());
    info.extend_from_slice(&1_u64.to_be_bytes());
    let mut key = Zeroizing::new([0_u8; 32]);
    Hkdf::<Sha256>::new(Some(&hkdf_salt), room_key)
        .expand(&info, key.as_mut())
        .map_err(|_| "ENVELOPE_KEY_DERIVATION_FAILED".to_owned())?;
    let aad = json!({"protocolVersion":1,"appId":app_id,"roomId":room_id,
        "packageDigest":package_digest,"stateEpoch":0,"proposedRevision":1,
        "previousEnvelopeDigest":previous_encoded});
    let aad_bytes = canonical(&aad)?;
    let length = u32::try_from(automerge.len()).map_err(|_| "GENESIS_SIZE_LIMIT".to_owned())?;
    let padded_len = (automerge.len() + 4).div_ceil(4096) * 4096;
    let mut padded = vec![0_u8; padded_len.max(4096)];
    padded[..4].copy_from_slice(&length.to_be_bytes());
    padded[4..4 + automerge.len()].copy_from_slice(automerge);
    OsRng.fill_bytes(&mut padded[4 + automerge.len()..]);
    let cipher =
        Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "ENVELOPE_KEY_INVALID".to_owned())?;
    let ciphertext = cipher
        .encrypt(
            &Nonce::from([0_u8; 12]),
            Payload {
                msg: &padded,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| "GENESIS_ENCRYPTION_FAILED".to_owned())?;
    if ciphertext.len() > 524_288 {
        return Err("STATE_CIPHERTEXT_LIMIT_EXCEEDED".to_owned());
    }
    let aad_hash = hash(&[&aad_bytes]);
    let ciphertext_hash = hash(&[&ciphertext]);
    let message = hash(&[
        b"smallframe-room-snapshot-v1\0",
        &raw_room_id,
        &raw_package_digest,
        &0_u64.to_be_bytes(),
        &1_u64.to_be_bytes(),
        &previous,
        &envelope_salt,
        &aad_hash,
        &ciphertext_hash,
    ]);
    let signature = writer.sign(&message).to_bytes();
    Ok(json!({"version":1,"stateEpoch":0,"revision":1,
        "envelopeSalt":Base64UrlUnpadded::encode_string(&envelope_salt),
        "previousEnvelopeDigest":previous_encoded,
        "ciphertext":Base64UrlUnpadded::encode_string(&ciphertext),
        "writerPublicKey":Base64UrlUnpadded::encode_string(&writer.verifying_key().to_bytes()),
        "writerSignature":Base64UrlUnpadded::encode_string(&signature),"aad":aad}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn signed_genesis_uses_the_exact_envelope_key_and_aad() {
        let room_id = Base64UrlUnpadded::encode_string(&[3_u8; 16]);
        let package_digest = Base64UrlUnpadded::encode_string(&[4_u8; 32]);
        let writer = SigningKey::generate(&mut OsRng);
        let room_key = [5_u8; 32];
        let envelope = encrypt_genesis(
            &room_key,
            &writer,
            &room_id,
            "test.app",
            &package_digest,
            b"genesis",
        )
        .expect("encrypt");
        let salt = decode_fixed::<16>(envelope["envelopeSalt"].as_str().expect("salt"))
            .expect("salt bytes");
        let raw_room = decode_fixed::<16>(&room_id).expect("room bytes");
        let hkdf_salt = hash(&[b"smallframe/state/salt/v1\0", &raw_room, &salt]);
        let mut info = b"smallframe/state/key/v1\0".to_vec();
        info.extend_from_slice(&0_u64.to_be_bytes());
        info.extend_from_slice(&1_u64.to_be_bytes());
        let mut key = [0_u8; 32];
        Hkdf::<Sha256>::new(Some(&hkdf_salt), &room_key)
            .expand(&info, &mut key)
            .expect("key");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let ciphertext =
            Base64UrlUnpadded::decode_vec(envelope["ciphertext"].as_str().expect("ciphertext"))
                .expect("decode ciphertext");
        let aad = canonical(&envelope["aad"]).expect("aad");
        let plaintext = cipher
            .decrypt(
                &Nonce::from([0_u8; 12]),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .expect("decrypt");
        assert_eq!(&plaintext[..4], &7_u32.to_be_bytes());
        assert_eq!(&plaintext[4..11], b"genesis");
        let aad_hash = hash(&[&aad]);
        let cipher_hash = hash(&[&ciphertext]);
        let message = hash(&[
            b"smallframe-room-snapshot-v1\0",
            &raw_room,
            &[4_u8; 32],
            &0_u64.to_be_bytes(),
            &1_u64.to_be_bytes(),
            &[0_u8; 32],
            &salt,
            &aad_hash,
            &cipher_hash,
        ]);
        let signature = ed25519_dalek::Signature::from_slice(
            &Base64UrlUnpadded::decode_vec(
                envelope["writerSignature"].as_str().expect("signature"),
            )
            .expect("signature bytes"),
        )
        .expect("signature format");
        writer
            .verifying_key()
            .verify(&message, &signature)
            .expect("signature valid");
    }
}
