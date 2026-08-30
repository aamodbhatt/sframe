use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use serde_json::json;
use smallframe_core::{build_signed_package, canonical_json_bytes, hex_digest, sign_dsse_pae};

fn main() {
    let module = b"export default {view(){return {text:'ok'};},onEvent(){}};\n";
    let manifest = json!({
        "schemaVersion": "1.0",
        "id": "dev.example.phase-one-vector",
        "name": "Phase One Vector",
        "version": "0.1.0",
        "description": "Normative deterministic package vector.",
        "runtime": "smallframe-view/1",
        "state": {
            "mode": "personal",
            "maxPlaintextBytes": 393216,
            "publicTemplate": {"items": {}},
            "jsonSchema": {
                "type": "object",
                "properties": {"items": {"type": "object"}},
                "required": ["items"],
                "additionalProperties": false
            }
        },
        "capabilities": [],
        "limits": {"maxViewNodes": 2000, "maxEventRate": 30},
        "publisher": {"displayName": "Test Vector Publisher", "publicKey": "", "keyId": ""},
        "files": {"app.worker.js": {"sha256": "", "bytes": 1}}
    });
    let package = build_signed_package(manifest, module, &SigningKey::from_bytes(&[7_u8; 32]))
        .expect("build normative package");
    println!(
        "packageDigest={}",
        Base64UrlUnpadded::encode_string(&package.package_digest)
    );
    println!(
        "artifactDigest={}",
        Base64UrlUnpadded::encode_string(&package.artifact_digest)
    );
    println!("publisherKeyId={}", package.publisher_key_id);
    println!("archiveBytes={}", package.canonical_archive.len());
    println!("archiveSha256Hex={}", hex_digest(&package.artifact_digest));
    println!(
        "archiveBase64={}",
        Base64::encode_string(&package.canonical_archive)
    );

    let actor = ActorId::from([0x42_u8; 16].as_slice());
    let mut genesis = AutoCommit::new().with_actor(actor);
    genesis
        .put_object(&ROOT, "decisions", ObjType::Map)
        .expect("create deterministic decisions map");
    let genesis_bytes = genesis.save();
    println!("genesisBytes={}", genesis_bytes.len());
    println!(
        "genesisSha256Hex={}",
        hex_digest(&smallframe_core::sha256(&genesis_bytes))
    );
    println!("genesisBase64={}", Base64::encode_string(&genesis_bytes));

    let release_root = SigningKey::from_bytes(&[0x52_u8; 32]);
    let release_public = release_root.verifying_key().to_bytes();
    println!(
        "releaseRootSeed={}",
        Base64UrlUnpadded::encode_string(&release_root.to_bytes())
    );
    println!(
        "releaseRootPublic={}",
        Base64UrlUnpadded::encode_string(&release_public)
    );
    println!(
        "releaseRootKeyId={}",
        smallframe_core::key_id(&release_public)
    );

    let publisher = SigningKey::from_bytes(&[7_u8; 32]);
    let records = [
        (
            "roomDescriptor",
            "application/vnd.smallframe.room-descriptor.v1+json",
            json!({"protocolVersion":1,"roomId":"AAAAAAAAAAAAAAAAAAAAAA","packageDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","publisherKeyId":"sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk","writerPublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","capabilityHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","role":"viewer","expiresAt":1780000000000_u64}),
            &publisher,
        ),
        (
            "publisherEnrollment",
            "application/vnd.smallframe.publisher-enrollment.v1+json",
            json!({"protocolVersion":1,"publisherPublicKey":"6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw","publisherKeyId":"sha256:_oEsEvOrTOasXbaaw1L5BssbEe9D-zPiUu9_9VImOIk","tokenHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","operationId":"AAAAAAAAAAAAAAAAAAAAAA","inviteCodeHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","createdAt":1780000000000_u64}),
            &publisher,
        ),
        (
            "controllerRelease",
            "application/vnd.smallframe.controller-release.v1+json",
            json!({"schemaVersion":1,"buildId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","gitCommit":"0123456789abcdef0123456789abcdef01234567","createdAt":1780000000000_u64,"controllerShellDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","controllerAssetSetDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","serviceWorkerDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","rendererDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","verifierDigest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","protocolMin":1,"protocolMax":1}),
            &release_root,
        ),
    ];
    let vectors = records.map(|(id, payload_type, record, key)| {
        let canonical = canonical_json_bytes(&record).expect("canonical signed record");
        json!({
            "id": id,
            "payloadType": payload_type,
            "record": record,
            "canonicalBase64": Base64::encode_string(&canonical),
            "signature": Base64UrlUnpadded::encode_string(&sign_dsse_pae(payload_type, &canonical, key)),
            "keyId": smallframe_core::key_id(&key.verifying_key().to_bytes())
        })
    });
    println!(
        "signedRecordVectors={}",
        serde_jcs::to_string(&json!({"schemaVersion":1,"vectors":vectors}))
            .expect("encode vectors")
    );
}
use automerge::{ActorId, AutoCommit, ObjType, ROOT, transaction::Transactable};
