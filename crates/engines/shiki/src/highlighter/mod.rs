mod engine;
mod options;
mod render;
mod tokenize;
mod transform;

pub use self::engine::Highlighter;
pub use self::options::{
    ColorReplacement, ColorReplacements, ColorsRendering, DefaultColor, ExplanationMode, GrammarState, HighlightOptions, HtmlOptions, HtmlStructure,
    MergeWhitespaces, RootStyleOption, StyledSpan, SvgOptions, ThemeInput, ThemeSelection, ThemedToken, ThemedTokenExplanation, ThemedTokenScopeExplanation,
    ThemedTokenWithVariants, TokenStyles, TokensResult, is_none_theme_name, is_plain_lang,
};
pub use self::tokenize::split_lines;
pub use self::transform::{align_themes_tokenization, flat_token_variants, token_style_entries};
