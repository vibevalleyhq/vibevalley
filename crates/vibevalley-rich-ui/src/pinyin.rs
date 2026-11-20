use nsh_core::prelude::module;

/// Synchronous Hanyu Pinyin search matching exported on `"vibevalley/rich"`.
#[module]
pub struct VvPinyin;

#[module(flat)]
impl VvPinyin {
    /// Returns `true` when `query` continuously matches `text` by case-insensitive substring or Hanyu Pinyin.
    pub fn match_pinyin(text: String, query: String) -> bool {
        vibevalley_pinyin::match_continuous(&text, &query)
    }
}
