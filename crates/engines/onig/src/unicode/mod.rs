#[allow(dead_code)]
mod fold_data;
mod lookup;
#[allow(dead_code)]
mod props_data;
pub mod segment;
#[allow(dead_code)]
mod segment_data;

pub use lookup::{
    CharSet, MAX_CODEPOINT, PosixClass, chars_eq_icase, digit_charset, fold_multi_expansion, fold1_equivalents, is_alpha_char, is_extended_pictographic,
    is_general_newline, is_word_char, lookup_property, match_icase_str, set_byte, space_charset, test_byte, word_charset, xdigit_charset,
};
