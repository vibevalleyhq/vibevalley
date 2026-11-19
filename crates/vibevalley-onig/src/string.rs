use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_STRING_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct OnigString {
    id: u64,
    content: String,
    utf16_len: usize,
    // Allocated only when UTF-16 code unit offsets differ from UTF-8 byte offsets.
    utf16_to_utf8: Option<Vec<u32>>,
    utf8_to_utf16: Option<Vec<u32>>,
}

impl OnigString {
    pub fn new(content: impl Into<String>) -> Self {
        let content = content.into();
        let id = NEXT_STRING_ID.fetch_add(1, Ordering::Relaxed);
        if content.is_ascii() {
            let utf16_len = content.len();
            return Self {
                id,
                content,
                utf16_len,
                utf16_to_utf8: None,
                utf8_to_utf16: None,
            };
        }

        let utf8_len = content.len();
        let utf16_len: usize = content.chars().map(char::len_utf16).sum();
        let mut utf16_to_utf8 = vec![0u32; utf16_len + 1];
        let mut utf8_to_utf16 = vec![0u32; utf8_len + 1];

        let mut i16 = 0usize;
        for (i8, ch) in content.char_indices() {
            let len8 = ch.len_utf8();
            let len16 = ch.len_utf16();
            for offset in 0..len16 {
                utf16_to_utf8[i16 + offset] = i8 as u32;
            }
            for offset in 0..len8 {
                utf8_to_utf16[i8 + offset] = i16 as u32;
            }
            i16 += len16;
        }
        utf16_to_utf8[utf16_len] = utf8_len as u32;
        utf8_to_utf16[utf8_len] = utf16_len as u32;

        Self {
            id,
            content,
            utf16_len,
            utf16_to_utf8: Some(utf16_to_utf8),
            utf8_to_utf16: Some(utf8_to_utf16),
        }
    }

    /// Decodes a UTF-16 slice (replacing lone surrogates with U+FFFD) while preserving exact UTF-16 offsets.
    pub fn from_utf16_lossy(units: &[u16]) -> Self {
        let id = NEXT_STRING_ID.fetch_add(1, Ordering::Relaxed);
        let utf16_len = units.len();
        let mut content = String::with_capacity(utf16_len);
        let mut utf16_to_utf8 = vec![0u32; utf16_len + 1];
        let mut utf8_to_utf16 = Vec::with_capacity(utf16_len + 1);

        let mut i16 = 0usize;
        while i16 < utf16_len {
            let u = units[i16];
            let i8 = content.len();
            let (ch, step16) = if (0xD800..=0xDBFF).contains(&u) && i16 + 1 < utf16_len && (0xDC00..=0xDFFF).contains(&units[i16 + 1]) {
                let hi = u32::from(u - 0xD800);
                let lo = u32::from(units[i16 + 1] - 0xDC00);
                let cp = 0x10000 + ((hi << 10) | lo);
                (char::from_u32(cp).unwrap_or('\u{FFFD}'), 2)
            } else if (0xD800..=0xDFFF).contains(&u) {
                ('\u{FFFD}', 1)
            } else {
                (char::from_u32(u32::from(u)).unwrap_or('\u{FFFD}'), 1)
            };

            content.push(ch);
            for offset in 0..step16 {
                utf16_to_utf8[i16 + offset] = i8 as u32;
            }
            for _ in 0..ch.len_utf8() {
                utf8_to_utf16.push(i16 as u32);
            }
            i16 += step16;
        }

        let utf8_len = content.len();
        utf16_to_utf8[utf16_len] = utf8_len as u32;
        utf8_to_utf16.push(utf16_len as u32);

        if utf8_len == utf16_len && content.is_ascii() {
            Self {
                id,
                content,
                utf16_len,
                utf16_to_utf8: None,
                utf8_to_utf16: None,
            }
        } else {
            Self {
                id,
                content,
                utf16_len,
                utf16_to_utf8: Some(utf16_to_utf8),
                utf8_to_utf16: Some(utf8_to_utf16),
            }
        }
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn utf8_len(&self) -> usize {
        self.content.len()
    }

    pub fn utf16_len(&self) -> usize {
        self.utf16_len
    }

    pub fn utf16_to_utf8(&self, utf16_offset: usize) -> usize {
        if utf16_offset >= self.utf16_len {
            return self.content.len();
        }
        match &self.utf16_to_utf8 {
            Some(map) => map[utf16_offset] as usize,
            None => utf16_offset,
        }
    }

    pub fn utf8_to_utf16(&self, utf8_offset: usize) -> usize {
        if utf8_offset >= self.content.len() {
            return self.utf16_len;
        }
        match &self.utf8_to_utf16 {
            Some(map) => map[utf8_offset] as usize,
            None => utf8_offset,
        }
    }
}

impl From<&str> for OnigString {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for OnigString {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}
