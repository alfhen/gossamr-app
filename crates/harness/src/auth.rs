//! Client tokens. A token is 32 random bytes the client keeps; the harness keeps only its stored key, a SHA-256 of
//! it. A client proves its token by answering the harness's hello, which holds a fresh challenge, so the token never
//! crosses the socket. This is SCRAM's client proof (RFC 5802, section 3) without the salt, which only a guessable
//! password needs: the answer is the token masked with an HMAC of the hello under the stored key. The harness unmasks
//! it with each stored key and checks the hash. A program posing as the harness, without the stored key, learns
//! nothing from the answer, and the stored key alone cannot answer.

use std::fmt;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const DOMAIN: &[u8] = b"gossamr-harness client proof v1";

/// A client token. `Debug` shows nothing of it.
#[derive(Clone)]
pub struct Token([u8; 32]);

impl Token {
    /// 256 bits from the operating system's secure source.
    pub fn random() -> Token {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("the operating system has a secure random source");
        Token(bytes)
    }

    /// A token as 64 hex digits, with space around it ignored.
    pub fn parse(text: &str) -> Option<Token> {
        decode(text.trim()).map(Token)
    }

    pub fn hex(&self) -> String {
        encode(&self.0)
    }

    pub fn stored_key(&self) -> [u8; 32] {
        Sha256::digest(self.0).into()
    }

    /// The answer to `hello`, the harness's first message as it was sent.
    pub fn answer(&self, hello: &[u8]) -> [u8; 32] {
        xor(&self.0, &signature(&self.stored_key(), hello))
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(..)")
    }
}

/// Which of `stored` the answer proves, if any. Every key is tried, each compared in constant time, with no early exit.
pub fn verify(stored: &[[u8; 32]], hello: &[u8], answer: &[u8; 32]) -> Option<usize> {
    let mut proven = None;
    for (at, key) in stored.iter().enumerate() {
        let token: [u8; 32] = xor(answer, &signature(key, hello));
        let hash: [u8; 32] = Sha256::digest(token).into();
        if bool::from(hash.ct_eq(key)) {
            proven = Some(at);
        }
    }
    proven
}

fn signature(stored_key: &[u8; 32], hello: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(stored_key).expect("HMAC takes a key of any length");
    mac.update(DOMAIN);
    mac.update(hello);
    mac.finalize().into_bytes().into()
}

fn xor(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    std::array::from_fn(|i| a[i] ^ b[i])
}

pub fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 bytes from 64 hex digits, or None.
pub fn decode(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_an_answer_proves_its_own_token_and_no_other() {
        let (token, other) = (Token::random(), Token::random());
        let hello = br#"{"protocol":1,"build":"b","challenge":"00"}"#;
        let answer = token.answer(hello);
        assert_eq!(verify(&[other.stored_key(), token.stored_key()], hello, &answer), Some(1), "its own token");
        assert_eq!(verify(&[other.stored_key()], hello, &answer), None, "another token");
        assert_eq!(verify(&[token.stored_key()], br#"{"protocol":1,"build":"b","challenge":"01"}"#, &answer), None, "another challenge");
        assert_eq!(verify(&[token.stored_key()], br#"{"protocol":1,"build":"c","challenge":"00"}"#, &answer), None, "another build");
        assert!(answer != token.0 && encode(&answer) != token.hex(), "the answer is not the token");
    }

    #[test]
    fn auth_a_token_reads_back_from_its_hex_and_nothing_else_parses() {
        let token = Token::random();
        assert!(Token::parse(&format!(" {}\n", token.hex())).is_some_and(|back| back.0 == token.0), "round trip");
        for bad in ["", "ab", &"g".repeat(64), &"a".repeat(63), &"é".repeat(32)] {
            assert!(Token::parse(bad).is_none(), "{bad:?}");
        }
        assert_eq!(format!("{token:?}"), "Token(..)");
    }
}
