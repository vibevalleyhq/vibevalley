use core::fmt;

use super::table;

/// First Unicode CJK Unified Ideograph code point covered by the direct O(1) table.
pub const CJK_START: u32 = table::CJK_START;

/// Last Unicode CJK Unified Ideograph code point covered by the direct O(1) table.
pub const CJK_END: u32 = table::CJK_END;

const STACK_QUERY_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ReadingsKind {
    #[default]
    Empty,
    Single(u16),
    Poly(&'static [u16]),
}

/// Zero-allocation collection of tone-stripped ASCII Hanyu Pinyin readings for one character.
///
/// Primary reading comes first for polyphones (e.g. `'重'` yields `["zhong", "chong"]`).
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct Readings {
    inner: ReadingsKind,
}

impl Readings {
    /// Returns `true` when the character has no mapped pinyin readings.
    #[inline]
    pub const fn is_empty(self) -> bool {
        matches!(self.inner, ReadingsKind::Empty)
    }

    /// Number of distinct tone-stripped ASCII readings for the character.
    #[inline]
    pub const fn len(self) -> usize {
        match self.inner {
            ReadingsKind::Empty => 0,
            ReadingsKind::Single(_) => 1,
            ReadingsKind::Poly(slice) => slice.len(),
        }
    }

    /// Primary reading for the character, if any.
    #[inline]
    pub fn first(self) -> Option<&'static str> {
        self.get(0)
    }

    /// Reading at `index`, if within bounds.
    #[inline]
    pub fn get(self, index: usize) -> Option<&'static str> {
        match self.inner {
            ReadingsKind::Empty => None,
            ReadingsKind::Single(id) if index == 0 => Some(table::SYLLABLES[id as usize]),
            ReadingsKind::Single(_) => None,
            ReadingsKind::Poly(slice) => slice.get(index).map(|&id| table::SYLLABLES[id as usize]),
        }
    }

    /// Returns `true` if `syllable` matches any reading (exact lowercase ASCII).
    #[inline]
    pub fn contains(self, syllable: &str) -> bool {
        self.iter().any(|py| py == syllable)
    }

    /// Iterates over all readings in primary-first order.
    #[inline]
    pub const fn iter(self) -> ReadingsIter {
        ReadingsIter { readings: self, index: 0 }
    }
}

impl fmt::Debug for Readings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}

/// Iterator over a character's tone-stripped ASCII Hanyu Pinyin readings.
#[derive(Clone, Debug)]
pub struct ReadingsIter {
    readings: Readings,
    index: usize,
}

impl Iterator for ReadingsIter {
    type Item = &'static str;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        let item = self.readings.get(self.index)?;
        self.index += 1;
        Some(item)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.readings.len().saturating_sub(self.index);
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for ReadingsIter {}

impl IntoIterator for Readings {
    type Item = &'static str;
    type IntoIter = ReadingsIter;

    #[inline]
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

#[inline]
fn decode_code(code: u16) -> Readings {
    if code == 0 {
        return Readings { inner: ReadingsKind::Empty };
    }
    let idx = (code - 1) as usize;
    if idx < table::SYLLABLE_COUNT {
        return Readings {
            inner: ReadingsKind::Single(idx as u16),
        };
    }
    let set_idx = idx - table::SYLLABLE_COUNT;
    let start = table::POLY_OFFSETS[set_idx] as usize;
    let end = table::POLY_OFFSETS[set_idx + 1] as usize;
    Readings {
        inner: ReadingsKind::Poly(&table::POLY_POOL[start..end]),
    }
}

/// Looks up all tone-stripped ASCII Hanyu Pinyin readings for `ch`.
///
/// Syllables containing `ü` are stored with `v` (`lv`, `lve`, `nv`, `nve`) and `ê` as `e`.
/// Non-CJK characters return an empty [`Readings`].
#[inline]
pub fn readings(ch: char) -> Readings {
    let cp = ch as u32;
    if (CJK_START..=CJK_END).contains(&cp) {
        return decode_code(table::CJK_INDEX[(cp - CJK_START) as usize]);
    }
    if cp <= 0x7F {
        return Readings { inner: ReadingsKind::Empty };
    }
    match table::EXTRA_CJK.binary_search_by_key(&cp, |&(k, _)| k) {
        Ok(pos) => decode_code(table::EXTRA_CJK[pos].1),
        Err(_) => Readings { inner: ReadingsKind::Empty },
    }
}

/// Returns `true` when `ch` has at least one mapped Hanyu Pinyin reading.
#[inline]
pub fn has_pinyin(ch: char) -> bool {
    !readings(ch).is_empty()
}

/// Returns `true` when `query` continuously matches `text` by case-insensitive substring
/// or Hanyu Pinyin.
///
/// Semantics match `pinyin-pro`'s `match(text, query, { continuous: true, v: true })`
/// combined with case-insensitive direct substring search:
/// - An empty `query` returns `true` (matching `str::contains("")`).
/// - Direct case-insensitive substring match runs first as a fast path.
/// - Spaces are ignored across matched character runs (e.g. `"zwcs"` matches `"中文 测试"`).
/// - Each non-final matched CJK character may match its literal character, its pinyin initial
///   letter (`"zw"` -> `"中文"`), or any full polyphone syllable (`"zhongw"` -> `"中文"`).
/// - The final matched CJK character may match any prefix of any of its pinyin syllables
///   (`"zh"` -> `"中文"`, `"gongd"` -> `"工单"`, `"ai帮g"` -> `"AI帮工"`).
/// - Polyphones are explored across all readings (`"重"` -> `chong`/`zhong`, `"行"` ->
///   `xing`/`hang`, `"长"` -> `chang`/`zhang`).
/// - `ü` and tone-marked Latin vowels in `query` normalize to tone-stripped ASCII (`ü` -> `v`).
pub fn match_continuous(text: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    if text.is_empty() {
        return false;
    }
    if contains_ignore_case(text, query) {
        return true;
    }

    // Without CJK characters or whitespace in either side, DP can only match exact characters
    // already checked by `contains_ignore_case`.
    let has_cjk_or_space = text.chars().any(|ch| ch.is_whitespace() || has_pinyin(ch));
    if !has_cjk_or_space && !query.chars().any(char::is_whitespace) {
        return false;
    }

    let mut stack_raw = ['\0'; STACK_QUERY_LIMIT];
    let mut stack_py = [None; STACK_QUERY_LIMIT];
    let mut len = 0usize;
    let mut heap_raw: Vec<char> = Vec::new();
    let mut heap_py: Vec<Option<u8>> = Vec::new();

    for ch in query.chars().flat_map(char::to_lowercase) {
        if ch.is_whitespace() {
            continue;
        }
        let py = pinyin_ascii_byte(ch);
        if heap_raw.is_empty() && len < STACK_QUERY_LIMIT {
            stack_raw[len] = ch;
            stack_py[len] = py;
            len += 1;
        } else {
            if heap_raw.is_empty() {
                heap_raw.reserve(len + 16);
                heap_py.reserve(len + 16);
                heap_raw.extend_from_slice(&stack_raw[..len]);
                heap_py.extend_from_slice(&stack_py[..len]);
            }
            heap_raw.push(ch);
            heap_py.push(py);
        }
    }

    if heap_raw.is_empty() {
        if len == 0 {
            return false;
        }
        let mut pre = [false; STACK_QUERY_LIMIT + 1];
        let mut cur = [false; STACK_QUERY_LIMIT + 1];
        match_dp(text, &stack_raw[..len], &stack_py[..len], &mut pre[..=len], &mut cur[..=len])
    } else {
        let m = heap_raw.len();
        let mut pre = vec![false; m + 1];
        let mut cur = vec![false; m + 1];
        match_dp(text, &heap_raw, &heap_py, &mut pre, &mut cur)
    }
}

fn match_dp<'a>(text: &str, q_raw: &[char], q_py: &[Option<u8>], mut pre: &'a mut [bool], mut cur: &'a mut [bool]) -> bool {
    let m = q_raw.len();
    debug_assert!(m > 0 && pre.len() == m + 1 && cur.len() == m + 1);

    pre[0] = true;

    for ch in text.chars().flat_map(char::to_lowercase) {
        // Spaces do not break a continuous match run (matches `pinyin-pro`'s `space: "ignore"`).
        if ch.is_whitespace() {
            continue;
        }

        cur.fill(false);
        cur[0] = true;

        let char_readings = readings(ch);

        for k in 0..m {
            if !pre[k] {
                continue;
            }

            if ch == q_raw[k] {
                if k + 1 == m {
                    return true;
                }
                cur[k + 1] = true;
            }

            if !char_readings.is_empty()
                && let Some(first_b) = q_py[k]
            {
                let rem = &q_py[k..m];
                let rem_len = rem.len();
                for py in char_readings {
                    let py_bytes = py.as_bytes();
                    if py_bytes[0] != first_b {
                        continue;
                    }
                    if k + 1 == m {
                        return true;
                    }
                    cur[k + 1] = true;

                    if rem_len <= py_bytes.len() {
                        if rem.iter().zip(py_bytes).all(|(qb, &pb)| *qb == Some(pb)) {
                            return true;
                        }
                    } else if py_bytes.len() > 1 && rem[..py_bytes.len()].iter().zip(py_bytes).all(|(qb, &pb)| *qb == Some(pb)) {
                        cur[k + py_bytes.len()] = true;
                    }
                }
            }
        }

        core::mem::swap(&mut pre, &mut cur);
    }

    false
}

/// Fast case-insensitive substring check.
///
/// For pure-ASCII `query`, UTF-8 guarantees ASCII bytes (`0x00..=0x7F`) never occur inside
/// multi-byte sequences, so byte-window `eq_ignore_ascii_case` is exact and zero-allocation.
fn contains_ignore_case(text: &str, query: &str) -> bool {
    if query.is_ascii() {
        let q = query.as_bytes();
        let t = text.as_bytes();
        if q.len() > t.len() {
            return false;
        }
        return t.windows(q.len()).any(|w| w.eq_ignore_ascii_case(q));
    }
    if text.contains(query) {
        return true;
    }
    text.to_lowercase().contains(&query.to_lowercase())
}

#[inline]
const fn pinyin_ascii_byte(ch: char) -> Option<u8> {
    match ch {
        'a'..='z' => Some(ch as u8),
        'ü' | 'ǖ' | 'ǘ' | 'ǚ' | 'ǜ' => Some(b'v'),
        'ā' | 'á' | 'ǎ' | 'à' => Some(b'a'),
        'ō' | 'ó' | 'ǒ' | 'ò' => Some(b'o'),
        'ē' | 'é' | 'ě' | 'è' | 'ê' | 'ế' | 'ề' => Some(b'e'),
        'ī' | 'í' | 'ǐ' | 'ì' => Some(b'i'),
        'ū' | 'ú' | 'ǔ' | 'ù' => Some(b'u'),
        'ń' | 'ň' | 'ǹ' => Some(b'n'),
        'ḿ' => Some(b'm'),
        _ => None,
    }
}
