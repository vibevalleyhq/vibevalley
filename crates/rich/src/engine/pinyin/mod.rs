//! Zero-dependency pure-Rust Hanyu Pinyin lookup and continuous search matcher.
//!
//! Covers all mapped Unicode CJK Unified Ideographs (`U+4E00..=U+9FFF`) in O(1)
//! plus supplementary ideographs (including `〇` `U+3007`) via binary search,
//! supporting polyphones, initials, full syllables, final-character prefixes,
//! mixed Hanzi/ASCII queries, and tone-stripped ASCII matching (`ü` normalized to `v`).

mod matcher;
mod table;

pub use matcher::{CJK_END, CJK_START, Readings, ReadingsIter, has_pinyin, match_continuous, readings};
