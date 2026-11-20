use super::is_extended_pictographic;
use super::segment_data::{EGCB_RANGES, WB_RANGES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentMode {
    ExtendedGraphemeCluster,
    Word,
}

const EGCB_OTHER: u8 = 0;
const EGCB_CR: u8 = 1;
const EGCB_LF: u8 = 2;
const EGCB_CONTROL: u8 = 3;
const EGCB_EXTEND: u8 = 4;
const EGCB_PREPEND: u8 = 5;
const EGCB_RI: u8 = 6;
const EGCB_SPACING_MARK: u8 = 7;
const EGCB_ZWJ: u8 = 8;
const EGCB_L: u8 = 13;
const EGCB_LV: u8 = 14;
const EGCB_LVT: u8 = 15;
const EGCB_T: u8 = 16;
const EGCB_V: u8 = 17;

const WB_ANY: u8 = 0;
const WB_ALETTER: u8 = 1;
const WB_CR: u8 = 2;
const WB_DOUBLE_QUOTE: u8 = 3;
const WB_EXTEND: u8 = 4;
const WB_EXTEND_NUM_LET: u8 = 5;
const WB_FORMAT: u8 = 6;
const WB_HEBREW_LETTER: u8 = 7;
const WB_KATAKANA: u8 = 8;
const WB_LF: u8 = 9;
const WB_MID_LETTER: u8 = 10;
const WB_MID_NUM: u8 = 11;
const WB_MID_NUM_LET: u8 = 12;
const WB_NEWLINE: u8 = 13;
const WB_NUMERIC: u8 = 14;
const WB_RI: u8 = 15;
const WB_SINGLE_QUOTE: u8 = 16;
const WB_WSEG_SPACE: u8 = 17;
const WB_ZWJ: u8 = 18;

fn lookup_type(table: &[(u32, u32, u8)], cp: u32) -> u8 {
    let mut low = 0usize;
    let mut high = table.len();
    while low < high {
        let mid = (low + high) >> 1;
        if cp > table[mid].1 {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if low < table.len() && cp >= table[low].0 { table[low].2 } else { 0 }
}

#[inline]
fn egcb_type(cp: u32) -> u8 {
    lookup_type(EGCB_RANGES, cp)
}

#[inline]
fn wb_type(cp: u32) -> u8 {
    lookup_type(WB_RANGES, cp)
}

#[inline]
fn prev_char(s: &str, pos: usize) -> Option<(usize, char)> {
    let ch = s[..pos].chars().next_back()?;
    Some((pos - ch.len_utf8(), ch))
}

#[inline]
fn next_char(s: &str, pos: usize) -> Option<(usize, char)> {
    let ch = s[pos..].chars().next()?;
    Some((pos + ch.len_utf8(), ch))
}

pub fn is_break_position(s: &str, pos: usize, mode: SegmentMode) -> bool {
    match mode {
        SegmentMode::ExtendedGraphemeCluster => is_egcb_break(s, pos),
        SegmentMode::Word => is_wb_break(s, pos),
    }
}

/// Advances one full text segment (`\X === (?>\O(?:\Y\O)*)`) starting at `pos` within `s`.
pub fn next_segment_end(s: &str, pos: usize, mode: SegmentMode) -> Option<usize> {
    let (mut cur, _) = next_char(s, pos)?;
    while cur < s.len() && !is_break_position(s, cur, mode) {
        let (next, _) = next_char(s, cur)?;
        cur = next;
    }
    Some(cur)
}

fn is_egcb_break(s: &str, pos: usize) -> bool {
    if pos == 0 || pos >= s.len() {
        return true;
    }
    let Some((mut prev_pos, from_ch)) = prev_char(s, pos) else {
        return true;
    };
    let Some((_, to_ch)) = next_char(s, pos) else {
        return true;
    };
    let from_cp = from_ch as u32;
    let to_cp = to_ch as u32;
    let from = egcb_type(from_cp);
    let to = egcb_type(to_cp);

    if from == EGCB_OTHER && to == EGCB_OTHER {
        return true;
    }
    // GB3
    if from == EGCB_CR && to == EGCB_LF {
        return false;
    }
    // GB4 & GB5
    if (EGCB_CR..=EGCB_CONTROL).contains(&from) || (EGCB_CR..=EGCB_CONTROL).contains(&to) {
        return true;
    }
    // GB6, GB7, GB8 (Hangul)
    if from >= EGCB_L && to >= EGCB_L {
        if from == EGCB_L && to != EGCB_T {
            return false;
        }
        if (from == EGCB_LV || from == EGCB_V) && (to == EGCB_V || to == EGCB_T) {
            return false;
        }
        if to == EGCB_T && (from == EGCB_LVT || from == EGCB_T) {
            return false;
        }
        return true;
    }
    // GB9, GB9a, GB9b
    if to == EGCB_EXTEND || to == EGCB_ZWJ || to == EGCB_SPACING_MARK || from == EGCB_PREPEND {
        return false;
    }
    // GB11: Extended_Pictographic Extend* ZWJ x Extended_Pictographic
    if from == EGCB_ZWJ {
        if is_extended_pictographic(to_cp) {
            while let Some((p, ch)) = prev_char(s, prev_pos) {
                prev_pos = p;
                let cp = ch as u32;
                if is_extended_pictographic(cp) {
                    return false;
                }
                if egcb_type(cp) != EGCB_EXTEND {
                    break;
                }
            }
        }
        return true;
    }
    // GB12, GB13: RI pairs
    if from == EGCB_RI && to == EGCB_RI {
        let mut count = 0usize;
        while let Some((p, ch)) = prev_char(s, prev_pos) {
            prev_pos = p;
            if egcb_type(ch as u32) != EGCB_RI {
                break;
            }
            count += 1;
        }
        if count.is_multiple_of(2) {
            return false;
        }
    }
    true
}

#[inline]
fn is_wb_ignore_tail(t: u8) -> bool {
    matches!(t, WB_EXTEND | WB_FORMAT | WB_ZWJ)
}

#[inline]
fn is_wb_ah_letter(t: u8) -> bool {
    matches!(t, WB_ALETTER | WB_HEBREW_LETTER)
}

#[inline]
fn is_wb_mid_num_let_q(t: u8) -> bool {
    matches!(t, WB_MID_NUM_LET | WB_SINGLE_QUOTE)
}

fn wb_next_main_type(s: &str, mut pos: usize) -> Option<u8> {
    // Advance past current char at `pos`, then skip Extend/Format/ZWJ.
    let (next, _) = next_char(s, pos)?;
    pos = next;
    while let Some((n, ch)) = next_char(s, pos) {
        let t = wb_type(ch as u32);
        if !is_wb_ignore_tail(t) {
            return Some(t);
        }
        pos = n;
    }
    None
}

fn wb_prev_main_type(s: &str, mut pos: usize) -> u8 {
    while let Some((p, ch)) = prev_char(s, pos) {
        pos = p;
        let t = wb_type(ch as u32);
        if !is_wb_ignore_tail(t) {
            return t;
        }
    }
    WB_ANY
}

fn is_wb_break(s: &str, pos: usize) -> bool {
    if pos == 0 || pos >= s.len() {
        return true;
    }
    let Some((mut prev_pos, from_ch)) = prev_char(s, pos) else {
        return true;
    };
    let Some((_, to_ch)) = next_char(s, pos) else {
        return true;
    };
    let from_cp = from_ch as u32;
    let to_cp = to_ch as u32;
    let mut from = wb_type(from_cp);
    let to = wb_type(to_cp);

    if from == WB_ANY && to == WB_ANY {
        return true;
    }
    // WB3
    if from == WB_CR && to == WB_LF {
        return false;
    }
    // WB3a, WB3b
    if matches!(from, WB_NEWLINE | WB_CR | WB_LF) || matches!(to, WB_NEWLINE | WB_CR | WB_LF) {
        return true;
    }
    // WB3c: ZWJ x Extended_Pictographic
    if from == WB_ZWJ && is_extended_pictographic(to_cp) {
        return false;
    }
    // WB3d: WSegSpace x WSegSpace
    if from == WB_WSEG_SPACE && to == WB_WSEG_SPACE {
        return false;
    }
    // WB4: X (Extend | Format | ZWJ)* -> X
    if is_wb_ignore_tail(to) {
        return false;
    }
    if is_wb_ignore_tail(from) {
        while let Some((p, ch)) = prev_char(s, prev_pos) {
            prev_pos = p;
            from = wb_type(ch as u32);
            if !is_wb_ignore_tail(from) {
                break;
            }
        }
    }

    if is_wb_ah_letter(from) {
        // WB5
        if is_wb_ah_letter(to) {
            return false;
        }
        // WB6
        if (to == WB_MID_LETTER || is_wb_mid_num_let_q(to)) && wb_next_main_type(s, pos).is_some_and(is_wb_ah_letter) {
            return false;
        }
    }

    // WB7
    if (from == WB_MID_LETTER || is_wb_mid_num_let_q(from)) && is_wb_ah_letter(to) && is_wb_ah_letter(wb_prev_main_type(s, prev_pos)) {
        return false;
    }

    if from == WB_HEBREW_LETTER {
        // WB7a
        if to == WB_SINGLE_QUOTE {
            return false;
        }
        // WB7b
        if to == WB_DOUBLE_QUOTE && wb_next_main_type(s, pos) == Some(WB_HEBREW_LETTER) {
            return false;
        }
    }

    // WB7c
    if from == WB_DOUBLE_QUOTE && to == WB_HEBREW_LETTER && wb_prev_main_type(s, prev_pos) == WB_HEBREW_LETTER {
        return false;
    }

    if to == WB_NUMERIC {
        // WB8, WB9
        if from == WB_NUMERIC || is_wb_ah_letter(from) {
            return false;
        }
        // WB11
        if (from == WB_MID_NUM || is_wb_mid_num_let_q(from)) && wb_prev_main_type(s, prev_pos) == WB_NUMERIC {
            return false;
        }
    }

    if from == WB_NUMERIC {
        // WB10
        if is_wb_ah_letter(to) {
            return false;
        }
        // WB12
        if (to == WB_MID_NUM || is_wb_mid_num_let_q(to)) && wb_next_main_type(s, pos) == Some(WB_NUMERIC) {
            return false;
        }
    }

    // WB13
    if from == WB_KATAKANA && to == WB_KATAKANA {
        return false;
    }
    // WB13a
    if (is_wb_ah_letter(from) || from == WB_NUMERIC || from == WB_KATAKANA || from == WB_EXTEND_NUM_LET) && to == WB_EXTEND_NUM_LET {
        return false;
    }
    // WB13b
    if from == WB_EXTEND_NUM_LET && (is_wb_ah_letter(to) || to == WB_NUMERIC || to == WB_KATAKANA) {
        return false;
    }

    // WB15, WB16
    if from == WB_RI && to == WB_RI {
        let mut count = 0usize;
        while let Some((p, ch)) = prev_char(s, prev_pos) {
            prev_pos = p;
            if wb_type(ch as u32) != WB_RI {
                break;
            }
            count += 1;
        }
        if count.is_multiple_of(2) {
            return false;
        }
    }

    true
}
