use crate::{CoreError, ErrorCode, Result};
use base64ct::{Base64, Base64UrlUnpadded, Encoding};

pub(crate) fn decode_base64url_fixed<const N: usize>(
    value: &str,
    code: ErrorCode,
) -> Result<[u8; N]> {
    let decoded = Base64UrlUnpadded::decode_vec(value)
        .map_err(|_| CoreError::new(code, "invalid unpadded base64url"))?;
    let bytes: [u8; N] = decoded
        .try_into()
        .map_err(|_| CoreError::new(code, "decoded length mismatch"))?;
    if Base64UrlUnpadded::encode_string(&bytes) != value {
        return Err(CoreError::new(code, "noncanonical unpadded base64url"));
    }
    Ok(bytes)
}

pub(crate) fn encode_base64url(value: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(value)
}

pub(crate) fn decode_base64(value: &str, code: ErrorCode) -> Result<Vec<u8>> {
    let decoded =
        Base64::decode_vec(value).map_err(|_| CoreError::new(code, "invalid padded base64"))?;
    if Base64::encode_string(&decoded) != value {
        return Err(CoreError::new(code, "noncanonical padded base64"));
    }
    Ok(decoded)
}

pub(crate) fn encode_base64(value: &[u8]) -> String {
    Base64::encode_string(value)
}
