//! Screenshots the person attaches to a question. They live in memory for one run and are never written anywhere.

use serde::Deserialize;

use crate::error::{Error, Result};

pub const MAX_IMAGES: usize = 4;
/// Combined size of the base64 text.
pub const MAX_TOTAL_BASE64: usize = 20 * 1024 * 1024;
/// The largest image Claude accepts.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    /// Standard base64 with padding and no line breaks.
    pub data: String,
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Claude(message.into())
}

fn sniff(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn sextet(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Checks the whole string is canonical base64 and returns the decoded size and the first bytes.
fn inspect(data: &str) -> Option<(usize, Vec<u8>)> {
    let bytes = data.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if padding > 2 || !bytes[..bytes.len() - padding].iter().all(|&b| sextet(b).is_some()) {
        return None;
    }
    let mut head = Vec::with_capacity(12);
    for quad in bytes.chunks(4).take(4) {
        let mut acc = 0u32;
        for &b in quad {
            acc = (acc << 6) | u32::from(sextet(b).unwrap_or(0));
        }
        head.extend_from_slice(&acc.to_be_bytes()[1..]);
    }
    Some((bytes.len() / 4 * 3 - padding, head))
}

pub fn validate(images: &[ImageInput]) -> Result<()> {
    if images.len() > MAX_IMAGES {
        return Err(refuse(format!("You can attach up to {MAX_IMAGES} images to one question.")));
    }
    if images.iter().map(|i| i.data.len()).sum::<usize>() > MAX_TOTAL_BASE64 {
        return Err(refuse("The attached images are too large together. Attach fewer or smaller ones."));
    }
    for (n, image) in images.iter().enumerate() {
        let which = format!("Image {}", n + 1);
        if !matches!(image.media_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
            return Err(refuse(format!("{which} is {}, and only PNG, JPEG, GIF and WebP images can be attached.", image.media_type)));
        }
        let (size, head) = inspect(&image.data).ok_or_else(|| refuse(format!("{which} isn't valid image data.")))?;
        if size > MAX_IMAGE_BYTES {
            return Err(refuse(format!("{which} is larger than 5 MB.")));
        }
        if sniff(&head) != Some(image.media_type.as_str()) {
            return Err(refuse(format!("{which} isn't the {} it says it is.", image.media_type)));
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A 1x1 transparent PNG.
    pub const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    pub fn png() -> ImageInput {
        ImageInput { media_type: "image/png".into(), data: PNG.into() }
    }

    fn b64(bytes: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for c in bytes.chunks(3) {
            let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
            for i in 0..4 {
                out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        out
    }

    fn image(media_type: &str, bytes: &[u8]) -> ImageInput {
        ImageInput { media_type: media_type.into(), data: b64(bytes) }
    }

    fn message(images: &[ImageInput]) -> String {
        validate(images).unwrap_err().to_string()
    }

    #[test]
    fn each_allowed_type_passes_when_the_bytes_match() {
        assert!(validate(&[]).is_ok());
        assert!(validate(&[png()]).is_ok());
        assert!(validate(&[image("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0])]).is_ok());
        assert!(validate(&[image("image/gif", b"GIF89a....")]).is_ok());
        assert!(validate(&[image("image/webp", b"RIFF\x10\0\0\0WEBPVP8 ")]).is_ok());
    }

    #[test]
    fn at_most_four_images() {
        assert!(validate(&[png(), png(), png(), png()]).is_ok());
        assert!(message(&[png(), png(), png(), png(), png()]).contains("up to 4"));
    }

    #[test]
    fn other_media_types_are_refused() {
        for t in ["image/svg+xml", "image/bmp", "application/pdf", "image/jpg", ""] {
            let mut i = png();
            i.media_type = t.into();
            assert!(message(&[i]).contains("only PNG, JPEG, GIF and WebP"), "{t}");
        }
    }

    #[test]
    fn the_declared_type_must_match_the_bytes() {
        let mut i = png();
        i.media_type = "image/jpeg".into();
        assert!(message(&[i]).contains("isn't the image/jpeg"));
        assert!(message(&[image("image/png", b"<svg xmlns=...>")]).contains("isn't the image/png"));
        assert!(message(&[image("image/webp", b"RIFF\x10\0\0\0WAVEfmt ")]).contains("isn't the image/webp"));
    }

    #[test]
    fn data_must_be_canonical_base64() {
        for bad in ["", "not base64!", "iVBO\nRw0K", "iVBORw0KGgo", "iVBORw0KGg==x", "====", "iVBOR==="] {
            let mut i = png();
            i.data = bad.into();
            assert!(message(&[i]).contains("isn't valid image data"), "{bad:?}");
        }
    }

    #[test]
    fn size_limits_apply_per_image_and_in_total() {
        let mut big = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        big.resize(5 * 1024 * 1024 + 1, 0);
        assert!(message(&[image("image/png", &big)]).contains("larger than 5 MB"));
        big.truncate(5 * 1024 * 1024);
        let ok = image("image/png", &big);
        assert!(validate(std::slice::from_ref(&ok)).is_ok());
        assert!(message(&[ok.clone(), ok.clone(), ok.clone(), ok]).contains("too large together"));
    }
}
