use std::collections::BTreeMap;

use super::raw::{RawTheme, RawThemeSetting, RawTokenSettings, ScopePatternList, ThemeType};

/// Options for [`create_css_variables_theme`], matching Shiki's `CssVariablesThemeOptions`.
#[derive(Debug, Clone)]
pub struct CssVariablesThemeOptions {
    pub name: String,
    pub variable_prefix: String,
    pub variable_defaults: BTreeMap<String, String>,
    pub font_style: bool,
}

impl Default for CssVariablesThemeOptions {
    fn default() -> Self {
        Self {
            name: "css-variables".to_string(),
            variable_prefix: "--shiki-".to_string(),
            variable_defaults: BTreeMap::new(),
            font_style: true,
        }
    }
}

/// Builds a CSS-variables-driven `RawTheme` matching Shiki's `createCssVariablesTheme`.
pub fn create_css_variables_theme(options: CssVariablesThemeOptions) -> RawTheme {
    let var = |key: &str| -> String {
        if let Some(default) = options.variable_defaults.get(key) {
            format!("var({}{key}, {default})", options.variable_prefix)
        } else {
            format!("var({}{key})", options.variable_prefix)
        }
    };

    let mut colors = BTreeMap::new();
    for (ui_key, var_key) in [
        ("editor.foreground", "foreground"),
        ("editor.background", "background"),
        ("terminal.ansiBlack", "ansi-black"),
        ("terminal.ansiRed", "ansi-red"),
        ("terminal.ansiGreen", "ansi-green"),
        ("terminal.ansiYellow", "ansi-yellow"),
        ("terminal.ansiBlue", "ansi-blue"),
        ("terminal.ansiMagenta", "ansi-magenta"),
        ("terminal.ansiCyan", "ansi-cyan"),
        ("terminal.ansiWhite", "ansi-white"),
        ("terminal.ansiBrightBlack", "ansi-bright-black"),
        ("terminal.ansiBrightRed", "ansi-bright-red"),
        ("terminal.ansiBrightGreen", "ansi-bright-green"),
        ("terminal.ansiBrightYellow", "ansi-bright-yellow"),
        ("terminal.ansiBrightBlue", "ansi-bright-blue"),
        ("terminal.ansiBrightMagenta", "ansi-bright-magenta"),
        ("terminal.ansiBrightCyan", "ansi-bright-cyan"),
        ("terminal.ansiBrightWhite", "ansi-bright-white"),
    ] {
        colors.insert(ui_key.to_string(), var(var_key));
    }

    let make_rule = |scopes: &[&str], fg: Option<String>, font_style: Option<&str>| RawThemeSetting {
        name: None,
        scope: Some(if scopes.len() == 1 {
            ScopePatternList::Single(scopes[0].to_string())
        } else {
            ScopePatternList::Multiple(scopes.iter().map(|s| (*s).to_string()).collect())
        }),
        settings: Some(RawTokenSettings {
            foreground: fg,
            font_style: if options.font_style { font_style.map(str::to_string) } else { None },
            ..RawTokenSettings::default()
        }),
    };

    let token_colors = vec![
        make_rule(
            &[
                "keyword.operator.accessor",
                "meta.group.braces.round.function.arguments",
                "meta.template.expression",
                "markup.fenced_code meta.embedded.block",
            ],
            Some(var("foreground")),
            None,
        ),
        make_rule(&["emphasis"], None, Some("italic")),
        make_rule(&["strong", "markup.heading.markdown", "markup.bold.markdown"], None, Some("bold")),
        make_rule(&["markup.italic.markdown"], None, Some("italic")),
        make_rule(&["meta.link.inline.markdown"], Some(var("token-link")), Some("underline")),
        make_rule(&["string", "markup.fenced_code", "markup.inline"], Some(var("token-string")), None),
        make_rule(&["comment", "string.quoted.docstring.multi"], Some(var("token-comment")), None),
        make_rule(
            &[
                "constant.numeric",
                "constant.language",
                "constant.other.placeholder",
                "constant.character.format.placeholder",
                "variable.language.this",
                "variable.other.object",
                "variable.other.class",
                "variable.other.constant",
                "meta.property-name",
                "meta.property-value",
                "support",
            ],
            Some(var("token-constant")),
            None,
        ),
        make_rule(
            &[
                "keyword",
                "storage.modifier",
                "storage.type",
                "storage.control.clojure",
                "entity.name.function.clojure",
                "entity.name.tag.yaml",
                "support.function.node",
                "support.type.property-name.json",
                "punctuation.separator.key-value",
                "punctuation.definition.template-expression",
            ],
            Some(var("token-keyword")),
            None,
        ),
        make_rule(&["variable.parameter.function"], Some(var("token-parameter")), None),
        make_rule(
            &[
                "support.function",
                "entity.name.type",
                "entity.other.inherited-class",
                "meta.function-call",
                "meta.instance.constructor",
                "entity.other.attribute-name",
                "entity.name.function",
                "constant.keyword.clojure",
            ],
            Some(var("token-function")),
            None,
        ),
        make_rule(
            &[
                "entity.name.tag",
                "string.quoted",
                "string.regexp",
                "string.interpolated",
                "string.template",
                "string.unquoted.plain.out.yaml",
                "keyword.other.template",
            ],
            Some(var("token-string-expression")),
            None,
        ),
        make_rule(
            &[
                "punctuation.definition.arguments",
                "punctuation.definition.dict",
                "punctuation.separator",
                "meta.function-call.arguments",
            ],
            Some(var("token-punctuation")),
            None,
        ),
        make_rule(
            &["markup.underline.link", "punctuation.definition.metadata.markdown"],
            Some(var("token-link")),
            None,
        ),
        make_rule(&["beginning.punctuation.definition.list.markdown"], Some(var("token-string")), None),
        make_rule(
            &[
                "punctuation.definition.string.begin.markdown",
                "punctuation.definition.string.end.markdown",
                "string.other.link.title.markdown",
                "string.other.link.description.markdown",
            ],
            Some(var("token-keyword")),
            None,
        ),
        make_rule(
            &["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"],
            Some(var("token-inserted")),
            None,
        ),
        make_rule(
            &["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"],
            Some(var("token-deleted")),
            None,
        ),
        make_rule(&["markup.changed", "punctuation.definition.changed"], Some(var("token-changed")), None),
    ];

    RawTheme {
        name: Some(options.name),
        theme_type: Some(ThemeType::Dark),
        colors,
        token_colors: Some(token_colors),
        ..RawTheme::default()
    }
}
