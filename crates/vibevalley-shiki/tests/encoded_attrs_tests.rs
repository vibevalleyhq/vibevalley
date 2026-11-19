use std::collections::BTreeMap;

use vibevalley_shiki::{
    EncodedTokenAttributes, FontInfo, FontStyle, OptionalStandardTokenType, RawGrammar, RawRule, RawTheme, RawThemeSetting, RawTokenSettings, Registry,
    ScopePatternList, StandardTokenType,
};

fn assert_attrs(
    meta: EncodedTokenAttributes,
    language_id: u8,
    token_type: StandardTokenType,
    contains_balanced_brackets: bool,
    font_style: FontStyle,
    foreground: u16,
    background: u16,
) {
    assert_eq!(meta.language_id(), language_id, "binary={}", meta.to_binary_str());
    assert_eq!(meta.token_type(), token_type, "binary={}", meta.to_binary_str());
    assert_eq!(meta.contains_balanced_brackets(), contains_balanced_brackets, "binary={}", meta.to_binary_str());
    assert_eq!(meta.font_style(), font_style, "binary={}", meta.to_binary_str());
    assert_eq!(meta.foreground(), foreground, "binary={}", meta.to_binary_str());
    assert_eq!(meta.background(), background, "binary={}", meta.to_binary_str());
}

/// Ported from `microsoft/vscode-textmate/src/tests/grammar.test.ts`.
#[test]
fn encoded_token_attributes_set_and_overwrite() {
    let base = EncodedTokenAttributes::default().set(
        1,
        OptionalStandardTokenType::RegEx,
        Some(false),
        FontStyle::UNDERLINE | FontStyle::BOLD,
        101,
        102,
    );
    assert_attrs(base, 1, StandardTokenType::RegEx, false, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 102);

    // Overwrite languageId
    let v = base.set(2, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NOT_SET, 0, 0);
    assert_attrs(v, 2, StandardTokenType::RegEx, false, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 102);

    // Overwrite tokenType
    let v = base.set(0, OptionalStandardTokenType::Comment, Some(false), FontStyle::NOT_SET, 0, 0);
    assert_attrs(v, 1, StandardTokenType::Comment, false, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 102);

    // Overwrite fontStyle
    let v = base.set(0, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NONE, 0, 0);
    assert_attrs(v, 1, StandardTokenType::RegEx, false, FontStyle::NONE, 101, 102);

    // Overwrite strikethrough
    let strike = EncodedTokenAttributes::default().set(1, OptionalStandardTokenType::RegEx, Some(false), FontStyle::STRIKETHROUGH, 101, 102);
    assert_attrs(strike, 1, StandardTokenType::RegEx, false, FontStyle::STRIKETHROUGH, 101, 102);
    let cleared = strike.set(0, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NONE, 0, 0);
    assert_attrs(cleared, 1, StandardTokenType::RegEx, false, FontStyle::NONE, 101, 102);

    // Overwrite foreground
    let v = base.set(0, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NOT_SET, 5, 0);
    assert_attrs(v, 1, StandardTokenType::RegEx, false, FontStyle::UNDERLINE | FontStyle::BOLD, 5, 102);

    // Overwrite background
    let v = base.set(0, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NOT_SET, 0, 7);
    assert_attrs(v, 1, StandardTokenType::RegEx, false, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 7);

    // Overwrite balanced bracket bit
    let v = base.set(0, OptionalStandardTokenType::NotSet, Some(true), FontStyle::NOT_SET, 0, 0);
    assert_attrs(v, 1, StandardTokenType::RegEx, true, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 102);
    let v = v.set(0, OptionalStandardTokenType::NotSet, Some(false), FontStyle::NOT_SET, 0, 0);
    assert_attrs(v, 1, StandardTokenType::RegEx, false, FontStyle::UNDERLINE | FontStyle::BOLD, 101, 102);
}

#[test]
fn encoded_token_attributes_max_values() {
    let max_lang = 255u8;
    let max_font = FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE;
    let max_fg = 511u16;
    let max_bg = 254u16;

    let v = EncodedTokenAttributes::default().set(max_lang, OptionalStandardTokenType::RegEx, Some(true), max_font, max_fg, max_bg);
    assert_attrs(v, max_lang, StandardTokenType::RegEx, true, max_font, max_fg, max_bg);
}

#[test]
fn fonts_are_correctly_set_case_1() {
    let mut registry = Registry::with_default_engine();
    registry.set_theme(
        &RawTheme {
            settings: Some(vec![RawThemeSetting {
                name: None,
                scope: Some(ScopePatternList::Single("bar.test".to_string())),
                settings: Some(RawTokenSettings {
                    font_family: Some("monospace".to_string()),
                    font_size: Some(1.2),
                    line_height: Some(3.0),
                    ..RawTokenSettings::default()
                }),
            }]),
            ..RawTheme::default()
        },
        None,
    );

    let grammar = registry
        .add_grammar(
            RawGrammar {
                scope_name: "source.test".to_string(),
                patterns: vec![RawRule {
                    match_pattern: Some(r"\bbar\b".to_string()),
                    name: Some("bar.test".to_string()),
                    ..RawRule::default()
                }],
                ..RawGrammar::default()
            },
            Vec::new(),
            0,
            BTreeMap::new(),
        )
        .expect("grammar loads");

    let res = grammar.tokenize_line2("bar hello", None, None).expect("tokenizes");
    assert_eq!(
        res.fonts,
        vec![FontInfo {
            start_index: 0,
            end_index: 3,
            font_family: Some("monospace".to_string()),
            font_size_multiplier: Some(1.2),
            line_height_multiplier: Some(3.0),
        }]
    );
}

#[test]
fn fonts_are_correctly_set_case_2() {
    let mut registry = Registry::with_default_engine();
    registry.set_theme(
        &RawTheme {
            settings: Some(vec![RawThemeSetting {
                name: None,
                scope: Some(ScopePatternList::Single("entity.name.function.ts".to_string())),
                settings: Some(RawTokenSettings {
                    font_family: Some("Times New Roman".to_string()),
                    font_size: Some(1.3),
                    line_height: Some(3.0),
                    ..RawTokenSettings::default()
                }),
            }]),
            ..RawTheme::default()
        },
        None,
    );

    let grammar = registry
        .add_grammar(
            RawGrammar {
                scope_name: "source.ts".to_string(),
                patterns: vec![RawRule {
                    match_pattern: Some("g".to_string()),
                    name: Some("entity.name.function.ts".to_string()),
                    ..RawRule::default()
                }],
                ..RawGrammar::default()
            },
            Vec::new(),
            0,
            BTreeMap::new(),
        )
        .expect("grammar loads");

    let res = grammar.tokenize_line2("function g() {}", None, None).expect("tokenizes");
    assert_eq!(
        res.fonts,
        vec![FontInfo {
            start_index: 9,
            end_index: 10,
            font_family: Some("Times New Roman".to_string()),
            font_size_multiplier: Some(1.3),
            line_height_multiplier: Some(3.0),
        }]
    );
}
