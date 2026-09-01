use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use ed25519_dalek::{
    SigningKey,
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use smallframe_core::key_id;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const SERVICE: &str = "dev.smallframe.cli";
const USER: &str = "identity-vault-v1";
const MAX_RECOVERY_BYTES: u64 = 64 * 1024;
const ARGON_MEMORY_KIB: u32 = 65_536;
const ARGON_ITERATIONS: u32 = 3;
const ARGON_LANES: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultFile {
    schema_version: u8,
    public_key: String,
    key_id: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultPlaintext {
    schema_version: u8,
    private_key_pkcs8: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryHeader {
    schema_version: u8,
    public_key: String,
    key_id: String,
    salt: String,
    nonce: String,
    created_at: u64,
    argon2_memory_kib: u32,
    argon2_iterations: u32,
    argon2_lanes: u32,
    ciphertext_bytes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryBundle {
    header: RecoveryHeader,
    ciphertext: String,
}

pub trait UnlockStore {
    fn load(&self) -> Result<Vec<u8>, String>;
    fn save_new(&self, secret: &[u8]) -> Result<(), String>;
}

pub struct KeyringUnlockStore;

impl UnlockStore for KeyringUnlockStore {
    fn load(&self) -> Result<Vec<u8>, String> {
        keyring::Entry::new(SERVICE, USER)
            .map_err(|_| "KEY_STORE_UNAVAILABLE".to_owned())?
            .get_secret()
            .map_err(|_| "KEY_STORE_LOCKED_OR_MISSING".to_owned())
    }

    fn save_new(&self, secret: &[u8]) -> Result<(), String> {
        let entry =
            keyring::Entry::new(SERVICE, USER).map_err(|_| "KEY_STORE_UNAVAILABLE".to_owned())?;
        match entry.get_secret() {
            Ok(_) => return Err("IDENTITY_EXISTS".to_owned()),
            Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("KEY_STORE_UNAVAILABLE".to_owned()),
        }
        entry
            .set_secret(secret)
            .map_err(|_| "KEY_STORE_WRITE_FAILED".to_owned())
    }
}

pub struct FileUnlockStore {
    path: PathBuf,
}

impl FileUnlockStore {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join("unlock.key"),
        }
    }
}

impl UnlockStore for FileUnlockStore {
    fn load(&self) -> Result<Vec<u8>, String> {
        fs::read(&self.path).map_err(|_| "KEY_STORE_LOCKED_OR_MISSING".to_owned())
    }

    fn save_new(&self, secret: &[u8]) -> Result<(), String> {
        write_new_private(&self.path, secret)
    }
}

pub struct IdentityContext {
    root: PathBuf,
    unlock: Box<dyn UnlockStore>,
}

impl IdentityContext {
    pub fn discover(test_store: Option<&Path>) -> Result<Self, String> {
        if let Some(root) = test_store {
            fs::create_dir_all(root).map_err(|_| "TEST_STORE_CREATE_FAILED".to_owned())?;
            return Ok(Self {
                root: root.to_path_buf(),
                unlock: Box::new(FileUnlockStore::new(root)),
            });
        }
        let root = default_config_root()?;
        fs::create_dir_all(&root).map_err(|_| "CONFIG_CREATE_FAILED".to_owned())?;
        Ok(Self {
            root,
            unlock: Box::new(KeyringUnlockStore),
        })
    }

    fn vault_path(&self) -> PathBuf {
        self.root.join("identity-v1.json")
    }

    pub fn init(&self) -> Result<IdentitySummary, String> {
        if self.vault_path().exists() {
            return Err("IDENTITY_EXISTS".to_owned());
        }
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut unlock_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(unlock_key.as_mut());
        let vault = encrypt_vault(&signing_key, unlock_key.as_ref())?;
        write_new_private(&self.vault_path(), &jcs(&vault)?)?;
        if let Err(error) = self.unlock.save_new(unlock_key.as_ref()) {
            fs::remove_file(self.vault_path())
                .map_err(|_| "IDENTITY_INSTALL_ROLLBACK_FAILED".to_owned())?;
            return Err(error);
        }
        Ok(summary(&signing_key))
    }

    pub fn signing_key(&self) -> Result<SigningKey, String> {
        let unlock = Zeroizing::new(self.unlock.load()?);
        if unlock.len() != 32 {
            return Err("KEY_STORE_VALUE_INVALID".to_owned());
        }
        let bytes = fs::read(self.vault_path()).map_err(|_| "IDENTITY_NOT_FOUND".to_owned())?;
        let vault: VaultFile = strict_json(&bytes)?;
        decrypt_vault(&vault, &unlock)
    }

    pub fn export(&self, output: &Path, passphrase: &str) -> Result<IdentitySummary, String> {
        validate_passphrase(passphrase)?;
        let signing_key = self.signing_key()?;
        let public_key = signing_key.verifying_key().to_bytes();
        let mut salt = [0_u8; 16];
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let pkcs8 = signing_key
            .to_pkcs8_der()
            .map_err(|_| "PRIVATE_KEY_ENCODING_FAILED".to_owned())?;
        let plaintext = jcs(&VaultPlaintext {
            schema_version: 1,
            private_key_pkcs8: Base64::encode_string(pkcs8.as_bytes()),
        })?;
        let mut header = RecoveryHeader {
            schema_version: 1,
            public_key: Base64UrlUnpadded::encode_string(&public_key),
            key_id: key_id(&public_key),
            salt: Base64UrlUnpadded::encode_string(&salt),
            nonce: Base64UrlUnpadded::encode_string(&nonce),
            created_at: now_millis()?,
            argon2_memory_kib: ARGON_MEMORY_KIB,
            argon2_iterations: ARGON_ITERATIONS,
            argon2_lanes: ARGON_LANES,
            ciphertext_bytes: plaintext.len() + 16,
        };
        let aad = jcs(&header)?;
        let derived = derive_key(passphrase, &salt, &header)?;
        let ciphertext = encrypt(derived.as_ref(), &nonce, &aad, &plaintext)?;
        header.ciphertext_bytes = ciphertext.len();
        let bundle = RecoveryBundle {
            header,
            ciphertext: Base64UrlUnpadded::encode_string(&ciphertext),
        };
        write_new_private(output, &jcs(&bundle)?)?;
        Ok(summary(&signing_key))
    }

    pub fn import(&self, input: &Path, passphrase: &str) -> Result<IdentitySummary, String> {
        validate_passphrase(passphrase)?;
        if self.vault_path().exists() {
            return Err("IDENTITY_EXISTS".to_owned());
        }
        let metadata = fs::metadata(input).map_err(|_| "RECOVERY_READ_FAILED".to_owned())?;
        if metadata.len() > MAX_RECOVERY_BYTES {
            return Err("RECOVERY_TOO_LARGE".to_owned());
        }
        let bytes = fs::read(input).map_err(|_| "RECOVERY_READ_FAILED".to_owned())?;
        let bundle: RecoveryBundle = strict_json(&bytes)?;
        validate_recovery_header(&bundle.header)?;
        let salt = decode_fixed::<16>(&bundle.header.salt)?;
        let nonce = decode_fixed::<12>(&bundle.header.nonce)?;
        let ciphertext = Base64UrlUnpadded::decode_vec(&bundle.ciphertext)
            .map_err(|_| "RECOVERY_ENCODING_INVALID".to_owned())?;
        if ciphertext.len() != bundle.header.ciphertext_bytes || ciphertext.len() > 16_384 {
            return Err("RECOVERY_LENGTH_INVALID".to_owned());
        }
        let aad = jcs(&bundle.header)?;
        let derived = derive_key(passphrase, &salt, &bundle.header)?;
        let plaintext = decrypt(derived.as_ref(), &nonce, &aad, &ciphertext)
            .map_err(|_| "RECOVERY_AUTH_FAILED".to_owned())?;
        let recovered: VaultPlaintext = strict_json(&plaintext)?;
        let der = Zeroizing::new(
            Base64::decode_vec(&recovered.private_key_pkcs8)
                .map_err(|_| "PRIVATE_KEY_ENCODING_INVALID".to_owned())?,
        );
        let signing_key = SigningKey::from_pkcs8_der(&der)
            .map_err(|_| "PRIVATE_KEY_ENCODING_INVALID".to_owned())?;
        let public_key = signing_key.verifying_key().to_bytes();
        if Base64UrlUnpadded::encode_string(&public_key) != bundle.header.public_key
            || key_id(&public_key) != bundle.header.key_id
        {
            return Err("RECOVERY_IDENTITY_MISMATCH".to_owned());
        }
        let mut unlock_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(unlock_key.as_mut());
        let vault = encrypt_vault(&signing_key, unlock_key.as_ref())?;
        write_new_private(&self.vault_path(), &jcs(&vault)?)?;
        if let Err(error) = self.unlock.save_new(unlock_key.as_ref()) {
            fs::remove_file(self.vault_path())
                .map_err(|_| "IDENTITY_INSTALL_ROLLBACK_FAILED".to_owned())?;
            return Err(error);
        }
        Ok(summary(&signing_key))
    }

    pub fn save_api_token(&self, token: &str) -> Result<(), String> {
        let path = self.root.join("api-token.txt");
        write_new_private(&path, token.as_bytes())
    }

    pub fn load_api_token(&self) -> Result<String, String> {
        let path = self.root.join("api-token.txt");
        let bytes = fs::read(&path).map_err(|_| "API_TOKEN_NOT_FOUND".to_owned())?;
        String::from_utf8(bytes).map_err(|_| "API_TOKEN_INVALID".to_owned())
    }

    pub fn save_room_record(&self, room_id: &str, record: &serde_json::Value) -> Result<(), String> {
        let path = self.root.join(format!("room-{}.json", room_id));
        let jcs_bytes = jcs(record)?;
        write_new_private(&path, &jcs_bytes)
    }

    pub fn load_room_record(&self, room_id: &str) -> Result<serde_json::Value, String> {
        let path = self.root.join(format!("room-{}.json", room_id));
        let bytes = fs::read(&path).map_err(|_| "ROOM_NOT_FOUND".to_owned())?;
        serde_json::from_slice(&bytes).map_err(|_| "ROOM_RECORD_INVALID".to_owned())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySummary {
    pub public_key: String,
    pub key_id: String,
    pub fingerprint: String,
}

fn summary(signing_key: &SigningKey) -> IdentitySummary {
    let public_key = signing_key.verifying_key().to_bytes();
    let digest = Sha256::digest(public_key);
    IdentitySummary {
        public_key: Base64UrlUnpadded::encode_string(&public_key),
        key_id: key_id(&public_key),
        fingerprint: grouped_base32(&digest),
    }
}

fn encrypt_vault(signing_key: &SigningKey, key: &[u8]) -> Result<VaultFile, String> {
    let public_key = signing_key.verifying_key().to_bytes();
    let pkcs8 = signing_key
        .to_pkcs8_der()
        .map_err(|_| "PRIVATE_KEY_ENCODING_FAILED".to_owned())?;
    let plaintext = jcs(&VaultPlaintext {
        schema_version: 1,
        private_key_pkcs8: Base64::encode_string(pkcs8.as_bytes()),
    })?;
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = format!("smallframe-vault-v1\0{}", key_id(&public_key));
    let ciphertext = encrypt(key, &nonce, aad.as_bytes(), &plaintext)?;
    Ok(VaultFile {
        schema_version: 1,
        public_key: Base64UrlUnpadded::encode_string(&public_key),
        key_id: key_id(&public_key),
        nonce: Base64UrlUnpadded::encode_string(&nonce),
        ciphertext: Base64UrlUnpadded::encode_string(&ciphertext),
    })
}

fn decrypt_vault(vault: &VaultFile, key: &[u8]) -> Result<SigningKey, String> {
    if vault.schema_version != 1 || key.len() != 32 {
        return Err("VAULT_FORMAT_INVALID".to_owned());
    }
    let nonce = decode_fixed::<12>(&vault.nonce)?;
    let ciphertext = Base64UrlUnpadded::decode_vec(&vault.ciphertext)
        .map_err(|_| "VAULT_FORMAT_INVALID".to_owned())?;
    let aad = format!("smallframe-vault-v1\0{}", vault.key_id);
    let plaintext = decrypt(key, &nonce, aad.as_bytes(), &ciphertext)
        .map_err(|_| "VAULT_AUTH_FAILED".to_owned())?;
    let value: VaultPlaintext = strict_json(&plaintext)?;
    let der = Zeroizing::new(
        Base64::decode_vec(&value.private_key_pkcs8)
            .map_err(|_| "PRIVATE_KEY_ENCODING_INVALID".to_owned())?,
    );
    let signing_key =
        SigningKey::from_pkcs8_der(&der).map_err(|_| "PRIVATE_KEY_ENCODING_INVALID".to_owned())?;
    let public_key = signing_key.verifying_key().to_bytes();
    if Base64UrlUnpadded::encode_string(&public_key) != vault.public_key
        || key_id(&public_key) != vault.key_id
    {
        return Err("VAULT_IDENTITY_MISMATCH".to_owned());
    }
    Ok(signing_key)
}

fn encrypt(key: &[u8], nonce: &[u8; 12], aad: &[u8], value: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "ENCRYPTION_KEY_INVALID".to_owned())?;
    let nonce = Nonce::from(*nonce);
    cipher
        .encrypt(&nonce, Payload { msg: value, aad })
        .map_err(|_| "ENCRYPTION_FAILED".to_owned())
}

fn decrypt(key: &[u8], nonce: &[u8; 12], aad: &[u8], value: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "ENCRYPTION_KEY_INVALID".to_owned())?;
    let nonce = Nonce::from(*nonce);
    cipher
        .decrypt(&nonce, Payload { msg: value, aad })
        .map_err(|_| "DECRYPTION_FAILED".to_owned())
}

fn derive_key(
    passphrase: &str,
    salt: &[u8; 16],
    header: &RecoveryHeader,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(
        header.argon2_memory_kib,
        header.argon2_iterations,
        header.argon2_lanes,
        Some(32),
    )
    .map_err(|_| "KDF_PARAMETERS_INVALID".to_owned())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, output.as_mut())
        .map_err(|_| "KDF_FAILED".to_owned())?;
    Ok(output)
}

fn validate_recovery_header(header: &RecoveryHeader) -> Result<(), String> {
    if header.schema_version != 1
        || header.argon2_memory_kib != ARGON_MEMORY_KIB
        || header.argon2_iterations != ARGON_ITERATIONS
        || header.argon2_lanes != ARGON_LANES
        || header.ciphertext_bytes > 16_384
        || decode_fixed::<32>(&header.public_key).is_err()
        || !header.key_id.starts_with("sha256:")
    {
        return Err("RECOVERY_HEADER_INVALID".to_owned());
    }
    Ok(())
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < 12 || passphrase.len() > 1024 {
        Err("PASSPHRASE_POLICY".to_owned())
    } else {
        Ok(())
    }
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], String> {
    let decoded =
        Base64UrlUnpadded::decode_vec(value).map_err(|_| "BASE64URL_INVALID".to_owned())?;
    decoded
        .try_into()
        .map_err(|_| "ENCODED_LENGTH_INVALID".to_owned())
}

fn jcs<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(value).map_err(|_| "JSON_CANONICALIZATION_FAILED".to_owned())
}

fn strict_json<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = T::deserialize(&mut deserializer).map_err(|_| "JSON_INVALID".to_owned())?;
    deserializer
        .end()
        .map_err(|_| "JSON_TRAILING_DATA".to_owned())?;
    Ok(value)
}

fn now_millis() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "SYSTEM_CLOCK_INVALID".to_owned())?;
    u64::try_from(duration.as_millis()).map_err(|_| "SYSTEM_CLOCK_INVALID".to_owned())
}

fn default_config_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base = env::var_os("APPDATA");
    #[cfg(target_os = "macos")]
    let base =
        env::var_os("HOME").map(|path| PathBuf::from(path).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|path| PathBuf::from(path).join(".config")));
    base.map(|path| path.join("smallframe"))
        .ok_or_else(|| "CONFIG_DIRECTORY_UNAVAILABLE".to_owned())
}

fn write_new_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "OUTPUT_PATH_INVALID".to_owned())?;
    fs::create_dir_all(parent).map_err(|_| "OUTPUT_DIRECTORY_CREATE_FAILED".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "OUTPUT_EXISTS_OR_UNWRITABLE".to_owned())?;
    file.write_all(bytes)
        .map_err(|_| "OUTPUT_WRITE_FAILED".to_owned())?;
    file.sync_all().map_err(|_| "OUTPUT_SYNC_FAILED".to_owned())
}

fn grouped_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut output = String::new();
    let mut accumulator = 0_u16;
    let mut bits = 0_u8;
    for byte in bytes {
        accumulator = (accumulator << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(char::from(
                ALPHABET[usize::from((accumulator >> bits) & 31)],
            ));
        }
    }
    if bits > 0 {
        output.push(char::from(
            ALPHABET[usize::from((accumulator << (5 - bits)) & 31)],
        ));
    }
    output
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

pub fn read_passphrase(
    path: Option<&Path>,
    confirmation: bool,
) -> Result<Zeroizing<String>, String> {
    if let Some(path) = path {
        let metadata = fs::metadata(path).map_err(|_| "PASSPHRASE_FILE_READ_FAILED".to_owned())?;
        if !metadata.is_file() || metadata.len() > 1024 {
            return Err("PASSPHRASE_FILE_INVALID".to_owned());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("PASSPHRASE_FILE_PERMISSIONS".to_owned());
            }
        }
        let value =
            fs::read_to_string(path).map_err(|_| "PASSPHRASE_FILE_READ_FAILED".to_owned())?;
        return Ok(Zeroizing::new(
            value.trim_end_matches(['\r', '\n']).to_owned(),
        ));
    }
    let first = Zeroizing::new(
        rpassword::prompt_password("Recovery passphrase: ")
            .map_err(|_| "PASSPHRASE_READ_FAILED".to_owned())?,
    );
    if confirmation {
        let second = Zeroizing::new(
            rpassword::prompt_password("Confirm passphrase: ")
                .map_err(|_| "PASSPHRASE_READ_FAILED".to_owned())?,
        );
        if first.as_str() != second.as_str() {
            return Err("PASSPHRASE_MISMATCH".to_owned());
        }
    }
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let mut random = [0_u8; 8];
        OsRng.fill_bytes(&mut random);
        env::temp_dir().join(format!("smallframe-{label}-{}", hex(&random)))
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn recovery_round_trip_rejects_wrong_passphrase_and_tampered_header() {
        let root = temporary_root("identity-test");
        let source = IdentityContext::discover(Some(&root.join("source"))).expect("source context");
        let original = source.init().expect("identity init");
        let recovery = root.join("recovery.json");
        source
            .export(&recovery, "correct horse battery staple")
            .expect("identity export");

        let wrong = IdentityContext::discover(Some(&root.join("wrong"))).expect("wrong context");
        assert_eq!(
            wrong
                .import(&recovery, "incorrect horse battery staple")
                .unwrap_err(),
            "RECOVERY_AUTH_FAILED"
        );

        let imported =
            IdentityContext::discover(Some(&root.join("imported"))).expect("import context");
        let restored = imported
            .import(&recovery, "correct horse battery staple")
            .expect("identity import");
        assert_eq!(restored.key_id, original.key_id);

        let mut bundle: RecoveryBundle =
            strict_json(&fs::read(&recovery).expect("read recovery")).expect("bundle");
        bundle.header.created_at += 1;
        let tampered = root.join("tampered.json");
        write_new_private(&tampered, &jcs(&bundle).expect("encode tampered"))
            .expect("write tampered");
        let tampered_context =
            IdentityContext::discover(Some(&root.join("tampered"))).expect("tampered context");
        assert_eq!(
            tampered_context
                .import(&tampered, "correct horse battery staple")
                .unwrap_err(),
            "RECOVERY_AUTH_FAILED"
        );

        fs::remove_dir_all(root).expect("remove owned temporary test directory");
    }
}
