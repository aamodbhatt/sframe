//! Local TEST-ONLY fixture: reuse the public Phase 1 vector signer, never an identity vault.
use automerge::{ActorId, AutoCommit, ObjType, ROOT, transaction::Transactable};
use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use serde_json::json;
use smallframe_core::build_signed_package;

fn main() {
    let manifest = serde_json::from_str(include_str!(
        "../../../examples/decision-board/package/smallframe.json"
    ))
    .expect("public example manifest");
    let module = include_bytes!("../../../examples/decision-board/package/app.worker.js");
    let package = build_signed_package(manifest, module, &SigningKey::from_bytes(&[7_u8; 32]))
        .expect("build TEST-ONLY shared package");
    let mut hostile = AutoCommit::new().with_actor(ActorId::from([0x44_u8; 16].as_slice()));
    hostile
        .put_object(&ROOT, "forbidden", ObjType::List)
        .expect("hostile list fixture");
    println!(
        "{}",
        json!({
            "packageDigest": Base64UrlUnpadded::encode_string(&package.package_digest),
            "publisherKeyId": package.publisher_key_id,
            "archiveBase64": Base64::encode_string(&package.canonical_archive),
            "hostileListBase64": Base64::encode_string(&hostile.save())
        })
    );
}
