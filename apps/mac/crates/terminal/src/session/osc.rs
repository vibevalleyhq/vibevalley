//! Lightweight VT OSC 7 (CWD) and OSC 133 (semantic prompt) stream scanner.
//!
//! Splits incoming PTY byte chunks at the exact boundary of OSC 7 / OSC 133
//! sequences so the session thread can feed the preceding bytes into
//! `alacritty_terminal::Term` and capture the cursor position while it sits
//! right at the mark.

use std::path::PathBuf;

/// Maximum OSC payload buffered for OSC 7 / OSC 133 parsing.
const MAX_OSC_PAYLOAD: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PromptMark {
    PromptStart,
    InputStart,
    OutputStart { command: String },
    CommandEnd { exit_code: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OscEvent {
    Pwd(PathBuf),
    Prompt(PromptMark),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Osc,
}

/// Stateful scanner matching `vte::Parser`'s 7-bit OSC framing byte-for-byte.
pub(crate) struct OscScanner {
    state: State,
    buf: Vec<u8>,
    overflowed: bool,
}

impl OscScanner {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Ground,
            buf: Vec::with_capacity(128),
            overflowed: false,
        }
    }

    /// Scans `bytes` until the end of the next OSC 7 / OSC 133 sequence (or end
    /// of slice). Returns `(consumed_len, Option<OscEvent>)`.
    pub(crate) fn next_chunk(&mut self, bytes: &[u8]) -> (usize, Option<OscEvent>) {
        let mut i = 0;
        while i < bytes.len() {
            match self.state {
                State::Ground => {
                    if let Some(off) = bytes[i..].iter().position(|&b| b == 0x1b) {
                        i += off + 1;
                        self.state = State::Escape;
                    } else {
                        return (bytes.len(), None);
                    }
                }
                State::Escape => {
                    let b = bytes[i];
                    i += 1;
                    match b {
                        b']' => {
                            self.buf.clear();
                            self.overflowed = false;
                            self.state = State::Osc;
                        }
                        0x1b => {}
                        _ => self.state = State::Ground,
                    }
                }
                State::Osc => {
                    let b = bytes[i];
                    i += 1;
                    match b {
                        0x07 | 0x18 | 0x1a => {
                            self.state = State::Ground;
                            if let Some(ev) = self.finish_osc() {
                                return (i, Some(ev));
                            }
                        }
                        0x1b => {
                            self.state = State::Escape;
                            if let Some(ev) = self.finish_osc() {
                                return (i, Some(ev));
                            }
                        }
                        0x00..=0x06 | 0x08..=0x17 | 0x19 | 0x1c..=0x1f => {}
                        _ => {
                            if self.buf.len() < MAX_OSC_PAYLOAD {
                                self.buf.push(b);
                            } else {
                                self.overflowed = true;
                            }
                        }
                    }
                }
            }
        }
        (bytes.len(), None)
    }

    fn finish_osc(&mut self) -> Option<OscEvent> {
        if self.overflowed {
            self.buf.clear();
            self.overflowed = false;
            return None;
        }
        let event = parse_osc_payload(&self.buf);
        self.buf.clear();
        event
    }
}

fn parse_osc_payload(payload: &[u8]) -> Option<OscEvent> {
    let semi = payload.iter().position(|&b| b == b';')?;
    let code = &payload[..semi];
    let body = &payload[semi + 1..];
    match code {
        b"7" => parse_pwd(body).map(OscEvent::Pwd),
        b"133" => parse_osc_133(body).map(OscEvent::Prompt),
        _ => None,
    }
}

fn parse_osc_133(body: &[u8]) -> Option<PromptMark> {
    let mut parts = body.split(|&b| b == b';');
    let kind = parts.next()?;
    match kind {
        b"A" => Some(PromptMark::PromptStart),
        b"B" => Some(PromptMark::InputStart),
        b"C" => {
            let mut command = String::new();
            for param in parts {
                if let Some(val) = param.strip_prefix(b"cmdline_url=") {
                    let decoded: Vec<u8> = percent_encoding::percent_decode(val).collect();
                    command = String::from_utf8_lossy(&decoded).into_owned();
                } else if let Some(val) = param.strip_prefix(b"cmdline=") {
                    command = unescape_cmdline(val);
                }
            }
            Some(PromptMark::OutputStart { command })
        }
        b"D" => {
            let exit_code = parts
                .next()
                .filter(|p| !p.is_empty() && !p.contains(&b'='))
                .and_then(|p| std::str::from_utf8(p).ok())
                .and_then(|s| s.parse::<i32>().ok());
            Some(PromptMark::CommandEnd { exit_code })
        }
        _ => None,
    }
}

fn unescape_cmdline(raw: &[u8]) -> String {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'\\' && i + 1 < raw.len() {
            match raw[i + 1] {
                b'\\' => {
                    out.push(b'\\');
                    i += 2;
                    continue;
                }
                b'x' if i + 3 < raw.len() => {
                    if let Ok(hex) = std::str::from_utf8(&raw[i + 2..i + 4])
                        && let Ok(byte) = u8::from_str_radix(hex, 16)
                    {
                        out.push(byte);
                        i += 4;
                        continue;
                    }
                }
                _ => {}
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Accepts what shells put in OSC 7: a `file://host/path` URL (percent
/// encoded), kitty's unencoded `kitty-shell-cwd://host/path`, or a bare path.
pub(crate) fn parse_pwd(raw: &[u8]) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;

    let (rest, encoded) = if let Some(rest) = raw.strip_prefix(b"file://") {
        (rest, true)
    } else if let Some(rest) = raw.strip_prefix(b"kitty-shell-cwd://") {
        (rest, false)
    } else {
        (raw, false)
    };
    let start = rest.iter().position(|b| *b == b'/')?;
    let path = &rest[start..];
    let bytes: Vec<u8> = if encoded {
        percent_encoding::percent_decode(path).collect()
    } else {
        path.to_vec()
    };
    Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_osc_7_and_osc_133_across_chunk_boundaries() {
        let mut scanner = OscScanner::new();
        let stream = b"hi\x1b]7;file://localhost/tmp/a%20b\x07\x1b]133;A\x07$ \x1b]133;B\x1b\\ls\r\n\x1b]133;C;cmdline_url=ls%20-la\x07out\r\n\x1b]133;D;7\x07";
        let mut events = Vec::new();
        for piece in stream.chunks(5) {
            let mut rest = piece;
            while !rest.is_empty() {
                let (consumed, ev) = scanner.next_chunk(rest);
                rest = &rest[consumed..];
                if let Some(ev) = ev {
                    events.push(ev);
                }
            }
        }
        assert_eq!(
            events,
            vec![
                OscEvent::Pwd(PathBuf::from("/tmp/a b")),
                OscEvent::Prompt(PromptMark::PromptStart),
                OscEvent::Prompt(PromptMark::InputStart),
                OscEvent::Prompt(PromptMark::OutputStart { command: "ls -la".into() }),
                OscEvent::Prompt(PromptMark::CommandEnd { exit_code: Some(7) }),
            ]
        );
    }

    #[test]
    fn parses_kitty_and_bare_pwd_variants() {
        assert_eq!(parse_pwd(b"kitty-shell-cwd://host/tmp/my%20dir"), Some(PathBuf::from("/tmp/my%20dir")));
        assert_eq!(parse_pwd(b"/var/tmp"), Some(PathBuf::from("/var/tmp")));
    }
}
