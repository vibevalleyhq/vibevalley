use std::collections::BTreeMap;
use std::path::Path;

use vibevalley_shiki::{
    ColorReplacements, ColorsRendering, CssVariablesThemeOptions, DefaultColor, ExplanationMode, FontStyle, HighlightOptions, Highlighter, HtmlOptions,
    HtmlStructure, MergeWhitespaces, RawGrammar, RawRule, RawTheme, RawThemeSetting, RawTokenSettings, Rgba, ScopePatternList, ShikiError, StandardTokenType,
    SvgOptions, ThemeInput, ThemeSelection, ThemeType, ThemedToken, align_themes_tokenization, create_css_variables_theme,
};

fn shiki_highlighter() -> Highlighter {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut hl = Highlighter::with_default_engine();

    for (file, aliases) in [
        ("javascript.json", &["js"][..]),
        ("typescript.json", &["ts"][..]),
        ("rust.json", &["rs"][..]),
        ("json.json", &[][..]),
    ] {
        let json = std::fs::read_to_string(base.join("shiki-grammars").join(file)).unwrap();
        hl.load_grammar_json(&json, aliases).unwrap();
    }

    for file in [
        "vitesse-light.json",
        "vitesse-dark.json",
        "nord.json",
        "min-light.json",
        "min-dark.json",
        "material-theme-palenight.json",
    ] {
        let json = std::fs::read_to_string(base.join("shiki-themes").join(file)).unwrap();
        hl.load_theme_json(&json).unwrap();
    }

    hl
}

fn stringify_tokens(tokens: &[Vec<ThemedToken>]) -> String {
    tokens
        .iter()
        .map(|line| line.iter().map(|t| t.content.as_str()).collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Ported from `shikijs/shiki/packages/shiki/test/themes.test.ts` (`alignThemesTokenization`).
#[test]
fn align_themes_two_and_three_themes() {
    let hl = shiki_highlighter();
    let opts = HighlightOptions::single("js", "vitesse-dark");

    let (lines1, _) = hl
        .code_to_tokens_base("console.log(\"hello\")", "js", &ThemeInput::from("vitesse-dark"), &opts)
        .unwrap();
    let (lines2, _) = hl
        .code_to_tokens_base("console.log(\"hello\")", "js", &ThemeInput::from("min-light"), &opts)
        .unwrap();

    assert_eq!(stringify_tokens(&lines1), "console . log ( \" hello \" )");
    assert_eq!(stringify_tokens(&lines2), "console .log ( \"hello\" )");

    let aligned = align_themes_tokenization(&[lines1, lines2]);
    assert_eq!(stringify_tokens(&aligned[0]), stringify_tokens(&aligned[1]));
    assert_eq!(stringify_tokens(&aligned[0]), "console . log ( \" hello \" )");

    // Three themes
    let (l1, _) = hl
        .code_to_tokens_base("console.log(\"hello\");", "js", &ThemeInput::from("vitesse-dark"), &opts)
        .unwrap();
    let (l2, _) = hl
        .code_to_tokens_base("console.log(\"hello\");", "js", &ThemeInput::from("min-light"), &opts)
        .unwrap();
    let (l3, _) = hl
        .code_to_tokens_base("console.log(\"hello\");", "js", &ThemeInput::from("nord"), &opts)
        .unwrap();

    assert_eq!(stringify_tokens(&l1), "console . log ( \" hello \" );");
    assert_eq!(stringify_tokens(&l2), "console .log ( \"hello\" );");
    assert_eq!(stringify_tokens(&l3), "console . log ( \" hello \" ) ;");

    let aligned3 = align_themes_tokenization(&[l1, l2, l3]);
    assert_eq!(stringify_tokens(&aligned3[0]), "console . log ( \" hello \" ) ;");
    assert_eq!(stringify_tokens(&aligned3[0]), stringify_tokens(&aligned3[1]));
    assert_eq!(stringify_tokens(&aligned3[1]), stringify_tokens(&aligned3[2]));
}

/// Ported from `shikijs/shiki/packages/shiki/test/themes.test.ts` (`codeToTokensWithThemes`).
#[test]
fn code_to_tokens_with_five_themes_exact_snapshot() {
    let hl = shiki_highlighter();
    let themes = vec![
        ("light".to_string(), ThemeInput::from("vitesse-light")),
        ("dark".to_string(), ThemeInput::from("vitesse-dark")),
        ("nord".to_string(), ThemeInput::from("nord")),
        ("min-dark".to_string(), ThemeInput::from("min-dark")),
        ("min-light".to_string(), ThemeInput::from("min-light")),
    ];
    let opts = HighlightOptions::single("js", "vitesse-light");
    let (lines, _) = hl.code_to_tokens_with_themes("a.b", "js", &themes, &opts).unwrap();

    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].len(), 3);

    // Token 0: "a"
    assert_eq!(lines[0][0].content, "a");
    assert_eq!(lines[0][0].offset, 0);
    assert_eq!(lines[0][0].variant("dark").unwrap().color.as_deref(), Some("#BD976A"));
    assert_eq!(lines[0][0].variant("light").unwrap().color.as_deref(), Some("#B07D48"));
    assert_eq!(lines[0][0].variant("min-dark").unwrap().color.as_deref(), Some("#79B8FF"));
    assert_eq!(lines[0][0].variant("min-light").unwrap().color.as_deref(), Some("#1976D2"));
    assert_eq!(lines[0][0].variant("nord").unwrap().color.as_deref(), Some("#D8DEE9"));

    // Token 1: "."
    assert_eq!(lines[0][1].content, ".");
    assert_eq!(lines[0][1].offset, 1);
    assert_eq!(lines[0][1].variant("dark").unwrap().color.as_deref(), Some("#666666"));
    assert_eq!(lines[0][1].variant("light").unwrap().color.as_deref(), Some("#999999"));
    assert_eq!(lines[0][1].variant("min-dark").unwrap().color.as_deref(), Some("#B392F0"));
    assert_eq!(lines[0][1].variant("min-light").unwrap().color.as_deref(), Some("#24292EFF"));
    assert_eq!(lines[0][1].variant("nord").unwrap().color.as_deref(), Some("#ECEFF4"));

    // Token 2: "b"
    assert_eq!(lines[0][2].content, "b");
    assert_eq!(lines[0][2].offset, 2);
    assert_eq!(lines[0][2].variant("dark").unwrap().color.as_deref(), Some("#BD976A"));
    assert_eq!(lines[0][2].variant("light").unwrap().color.as_deref(), Some("#B07D48"));
    assert_eq!(lines[0][2].variant("min-dark").unwrap().color.as_deref(), Some("#B392F0"));
    assert_eq!(lines[0][2].variant("min-light").unwrap().color.as_deref(), Some("#24292EFF"));
    assert_eq!(lines[0][2].variant("nord").unwrap().color.as_deref(), Some("#D8DEE9"));
}

/// Ported from `shikijs/shiki/packages/shiki/test/themes.test.ts` (font styles, no-default, light-dark, errors).
#[test]
fn multi_theme_html_font_styles_default_color_and_errors() {
    let hl = shiki_highlighter();

    // Font style propagation across light/dark themes
    let input = "import * as Shiki from 'shiki';\n";
    let html1 = hl
        .code_to_html(input, &HtmlOptions::new(HighlightOptions::dual("js", "material-theme-palenight", "nord")))
        .unwrap();
    assert!(html1.contains("font-style:italic"), "html1={html1}");
    assert!(html1.contains("--shiki-dark-font-style:inherit"), "html1={html1}");

    let mut opts_dark_default = HighlightOptions::dual("js", "material-theme-palenight", "nord");
    if let ThemeSelection::Multi { default_color, .. } = &mut opts_dark_default.theme {
        *default_color = DefaultColor::Key("dark".to_string());
    }
    let html2 = hl.code_to_html(input, &HtmlOptions::new(opts_dark_default)).unwrap();
    assert!(html2.contains("font-style:inherit"), "html2={html2}");
    assert!(html2.contains("--shiki-light-font-style:italic"), "html2={html2}");

    // Plaintext should not produce empty style=""
    let plain_html = hl
        .code_to_html(
            "This is plain text",
            &HtmlOptions::new(HighlightOptions::dual("plaintext", "material-theme-palenight", "nord")),
        )
        .unwrap();
    assert!(!plain_html.contains("style=\"\""), "plain_html={plain_html}");

    // defaultColor: false exact snapshot from themes.test.ts:361
    let mut no_default = HighlightOptions::single("js", "nord");
    no_default.theme = ThemeSelection::Multi {
        themes: vec![("dark".to_string(), ThemeInput::from("nord"))],
        default_color: DefaultColor::None,
        css_variable_prefix: "--shiki-".to_string(),
        colors_rendering: ColorsRendering::CssVars,
    };
    let html_no_default = hl.code_to_html("console.log(\"hello\")", &HtmlOptions::new(no_default)).unwrap();
    assert_eq!(
        html_no_default,
        "<pre class=\"shiki shiki-themes nord\" style=\"--shiki-dark:#d8dee9ff;--shiki-dark-bg:#2e3440ff\" tabindex=\"0\"><code><span class=\"line\"><span style=\"--shiki-dark:#D8DEE9\">console</span><span style=\"--shiki-dark:#ECEFF4\">.</span><span style=\"--shiki-dark:#88C0D0\">log</span><span style=\"--shiki-dark:#D8DEE9FF\">(</span><span style=\"--shiki-dark:#ECEFF4\">&quot;</span><span style=\"--shiki-dark:#A3BE8C\">hello</span><span style=\"--shiki-dark:#ECEFF4\">&quot;</span><span style=\"--shiki-dark:#D8DEE9FF\">)</span></span></code></pre>"
    );

    // defaultColor: light-dark()
    let mut light_dark_opts = HighlightOptions::dual("js", "vitesse-light", "vitesse-dark");
    if let ThemeSelection::Multi { default_color, .. } = &mut light_dark_opts.theme {
        *default_color = DefaultColor::LightDark;
    }
    let html_ld = hl.code_to_html("const x = 1", &HtmlOptions::new(light_dark_opts)).unwrap();
    assert!(html_ld.contains("light-dark("), "html_ld={html_ld}");

    // Errors: empty themes
    let mut empty_opts = HighlightOptions::single("js", "nord");
    empty_opts.theme = ThemeSelection::Multi {
        themes: Vec::new(),
        default_color: DefaultColor::default(),
        css_variable_prefix: "--shiki-".to_string(),
        colors_rendering: ColorsRendering::CssVars,
    };
    let err = hl.code_to_tokens("const a = 1", &empty_opts).unwrap_err();
    assert!(matches!(err, ShikiError::InvalidOptions(ref m) if m.contains("must not be empty")));

    // Errors: missing defaultColor key
    let mut missing_default = HighlightOptions::single("js", "nord");
    missing_default.theme = ThemeSelection::Multi {
        themes: vec![("dark".to_string(), ThemeInput::from("nord"))],
        default_color: DefaultColor::Key("light".to_string()),
        css_variable_prefix: "--shiki-".to_string(),
        colors_rendering: ColorsRendering::CssVars,
    };
    let err = hl.code_to_tokens("const a = 1", &missing_default).unwrap_err();
    assert!(matches!(err, ShikiError::InvalidOptions(ref m) if m.contains("`light`")));
}

/// Ported from `shikijs/shiki/packages/shiki/test/css-variables.test.ts` (exact snapshots!).
#[test]
fn css_variables_theme_factory_exact_snapshots() {
    let hl = shiki_highlighter();

    let mut defaults = BTreeMap::new();
    defaults.insert("background".to_string(), "#000".to_string());
    let theme1 = create_css_variables_theme(CssVariablesThemeOptions {
        variable_prefix: "--my-".to_string(),
        variable_defaults: defaults.clone(),
        ..CssVariablesThemeOptions::default()
    });
    let html1 = hl
        .code_to_html("const a = 1", &HtmlOptions::new(HighlightOptions::single("js", theme1)))
        .unwrap();
    assert_eq!(
        html1,
        "<pre class=\"shiki css-variables\" style=\"background-color:var(--my-background, #000);color:var(--my-foreground)\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:var(--my-token-keyword)\">const</span><span style=\"color:var(--my-token-constant)\"> a</span><span style=\"color:var(--my-token-keyword)\"> =</span><span style=\"color:var(--my-token-constant)\"> 1</span></span></code></pre>"
    );

    let theme2 = create_css_variables_theme(CssVariablesThemeOptions {
        name: "foo".to_string(),
        variable_defaults: defaults,
        font_style: false,
        ..CssVariablesThemeOptions::default()
    });
    let html2 = hl
        .code_to_html("const a = 1", &HtmlOptions::new(HighlightOptions::single("js", theme2)))
        .unwrap();
    assert_eq!(
        html2,
        "<pre class=\"shiki foo\" style=\"background-color:var(--shiki-background, #000);color:var(--shiki-foreground)\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:var(--shiki-token-keyword)\">const</span><span style=\"color:var(--shiki-token-constant)\"> a</span><span style=\"color:var(--shiki-token-keyword)\"> =</span><span style=\"color:var(--shiki-token-constant)\"> 1</span></span></code></pre>"
    );
}

/// Ported from `shikijs/shiki/packages/shiki/test/color-replacement.test.ts` (flat, single, scoped).
#[test]
fn color_replacements_flat_single_and_scoped() {
    let hl = shiki_highlighter();

    // Flat replacements on dual theme
    let mut opts = HighlightOptions::dual("js", "vitesse-light", "material-theme-palenight");
    opts.color_replacements = ColorReplacements::new()
        .with_global("#393a34", "var(---replaced-1)")
        .with_global("#b07d48", "var(---replaced-2)");
    let html = hl.code_to_html("console.log(\"hi\")", &HtmlOptions::new(opts)).unwrap();
    assert!(html.contains("color:var(---replaced-1);--shiki-dark:#babed8"), "html={html}");
    assert!(html.contains("color:var(---replaced-2);--shiki-dark:#BABED8"), "html={html}");

    // Single theme replacements
    let mut single_opts = HighlightOptions::single("js", "vitesse-light");
    single_opts.color_replacements = ColorReplacements::new()
        .with_global("#393a34", "var(---replaced-1)")
        .with_global("#b07d48", "var(---replaced-2)");
    let html_single = hl.code_to_html("console.log(\"hi\")", &HtmlOptions::new(single_opts)).unwrap();
    assert!(html_single.contains("var(---replaced-1)"));
    assert!(html_single.contains("var(---replaced-2)"));

    // Scoped replacements (precedence matches JS insertion order)
    let custom_light = RawTheme {
        name: Some("custom-light".to_string()),
        theme_type: Some(ThemeType::Light),
        settings: Some(vec![RawThemeSetting {
            name: None,
            scope: Some(ScopePatternList::Single("string".to_string())),
            settings: Some(RawTokenSettings {
                foreground: Some("#a3be8c".to_string()),
                ..RawTokenSettings::default()
            }),
        }]),
        fg: Some("#393a34".to_string()),
        bg: Some("#b07d48".to_string()),
        ..RawTheme::default()
    };
    let mut custom_dark = custom_light.clone();
    custom_dark.name = Some("custom-dark".to_string());
    custom_dark.theme_type = Some(ThemeType::Dark);

    let mut scoped_opts = HighlightOptions::dual("js", custom_light, custom_dark);
    scoped_opts.color_replacements = ColorReplacements::new()
        .with_scoped("custom-dark", "#b07d48", "var(---replaced-1)")
        .with_scoped("custom-light", "#393a34", "var(---replaced-2)")
        .with_scoped("custom-light", "#b07d48", "var(---replaced-3)")
        .with_global("#393a34", "var(---replaced-4)");

    let html_scoped = hl.code_to_html("console.log(\"hi\")", &HtmlOptions::new(scoped_opts)).unwrap();
    assert!(html_scoped.contains("var(---replaced-1)"), "html={html_scoped}");
    assert!(!html_scoped.contains("var(---replaced-2)"), "html={html_scoped}");
    assert!(html_scoped.contains("var(---replaced-3)"), "html={html_scoped}");
    assert!(html_scoped.contains("var(---replaced-4)"), "html={html_scoped}");
}

/// Ported from `shikijs/shiki/packages/shiki/test/theme-none.test.ts` (exact snapshots!).
#[test]
fn theme_none_single_and_multi() {
    let hl = shiki_highlighter();

    let html_single = hl
        .code_to_html("console.log", &HtmlOptions::new(HighlightOptions::single("js", "none")))
        .unwrap();
    assert_eq!(
        html_single,
        "<pre class=\"shiki none\" style=\"background-color:;color:\" tabindex=\"0\"><code><span class=\"line\"><span>console.log</span></span></code></pre>"
    );

    let html_multi = hl
        .code_to_html("console.log", &HtmlOptions::new(HighlightOptions::dual("ts", "vitesse-light", "none")))
        .unwrap();
    assert_eq!(
        html_multi,
        "<pre class=\"shiki shiki-themes vitesse-light none\" style=\"background-color:#ffffff;--shiki-dark-bg:inherit;color:#393a34;--shiki-dark:inherit\" tabindex=\"0\"><code><span class=\"line\"><span style=\"color:#B07D48;--shiki-dark:inherit\">console</span><span style=\"color:#999999;--shiki-dark:inherit\">.</span><span style=\"color:#B07D48;--shiki-dark:inherit\">log</span></span></code></pre>"
    );
}

/// Ported from `shikijs/shiki/packages/shiki/test/grammar-state.test.ts` (exact TypeScript snapshots!).
#[test]
fn grammar_state_and_context_code_in_typescript() {
    let hl = shiki_highlighter();

    let state = hl
        .get_last_grammar_state("let a:", &HighlightOptions::single("typescript", "vitesse-light"))
        .unwrap();
    assert_eq!(state.lang, "typescript");
    assert_eq!(state.themes(), vec!["vitesse-light"]);
    assert_eq!(
        state.scopes(),
        vec!["meta.type.annotation.ts", "meta.var-single-variable.expr.ts", "meta.var.expr.ts", "source.ts",]
    );

    let input = "Omit<{}, string | number>";
    let natural = hl.code_to_tokens(input, &HighlightOptions::single("typescript", "vitesse-light")).unwrap();

    let mut ctx_opts = HighlightOptions::single("typescript", "vitesse-light");
    ctx_opts.grammar_state = Some(state.clone());
    let with_state = hl.code_to_tokens(input, &ctx_opts).unwrap();
    let with_state_again = hl.code_to_tokens(input, &ctx_opts).unwrap();

    // Without type-annotation context: `Omit` is a variable (`#B07D48`)
    assert_eq!(natural.tokens[0][0].content, "Omit");
    assert_eq!(natural.tokens[0][0].color.as_deref(), Some("#B07D48"));

    // With type-annotation context: `Omit` is a type (`#2E8F82`), and reusing `state` is idempotent!
    assert_eq!(with_state.tokens[0][0].content, "Omit");
    assert_eq!(with_state.tokens[0][0].color.as_deref(), Some("#2E8F82"));
    assert_eq!(with_state.tokens, with_state_again.tokens);

    // `grammar_context_code` produces identical result to explicit `grammar_state`
    let mut context_code_opts = HighlightOptions::single("typescript", "vitesse-light");
    context_code_opts.grammar_context_code = Some("let a:".to_string());
    let via_context_code = hl.code_to_tokens(input, &context_code_opts).unwrap();
    assert_eq!(via_context_code.tokens, with_state.tokens);
}

/// Tests VibeValley GPUI span output, SVG rendering, inline HTML, whitespace modes,
/// full scope explanations, language aliases, and custom grammar injections on Rust & JSON.
#[test]
fn gpui_spans_svg_explanations_and_injections() {
    let mut hl = shiki_highlighter();

    // Rust highlighting for GPUI (`code_to_spans`) with multibyte UTF-8 text
    let rust_code = "// 注释 comment\npub fn greet(name: &str) -> usize {\n    42\n}";
    let spans = hl.code_to_spans(rust_code, "rs", "vitesse-dark").unwrap();
    assert_eq!(spans.len(), 4);
    // Every span range must slice valid UTF-8 char boundaries in its line
    for (line, line_spans) in rust_code.lines().zip(&spans) {
        let mut cursor = 0;
        for sp in line_spans {
            assert!(sp.range.start >= cursor && sp.range.start < sp.range.end);
            assert!(sp.range.end <= line.len());
            assert!(line.is_char_boundary(sp.range.start) && line.is_char_boundary(sp.range.end));
            cursor = sp.range.end;
        }
    }
    // Line 0 is a comment (`StandardTokenType::Comment`)
    assert_eq!(spans[0][0].token_type, StandardTokenType::Comment);
    assert!(spans[0][0].fg.is_some());
    assert_eq!(
        Rgba::from_hex("#4D9375"),
        Some(Rgba {
            r: 0x4d,
            g: 0x93,
            b: 0x75,
            a: 0xff
        })
    );

    // SVG output: pure SVG `<rect>` + `<text>`/`<tspan>`, zero `<foreignObject>`
    let svg = hl
        .code_to_svg(
            "fn main() {\n    println!(\"hi\");\n}",
            &SvgOptions::new(HighlightOptions::single("rust", "nord")),
        )
        .unwrap();
    assert!(svg.starts_with("<svg "));
    assert!(svg.ends_with("</svg>"));
    assert!(!svg.contains("foreignObject"));
    assert!(svg.contains("<tspan "));
    assert!(svg.contains("println!"));

    // Inline HTML + MergeWhitespaces::Never + ExplanationMode::Full
    let mut inline_opts = HtmlOptions::new(HighlightOptions::single("json", "vitesse-light"));
    inline_opts.structure = HtmlStructure::Inline;
    inline_opts.merge_whitespaces = MergeWhitespaces::Never;
    let inline_html = hl.code_to_html("{\"a\": 1}\n{\"b\": 2}", &inline_opts).unwrap();
    assert!(!inline_html.contains("<pre"));
    assert!(inline_html.contains("<br>"));

    let mut explain_opts = HighlightOptions::single("rust", "vitesse-dark");
    explain_opts.include_explanation = ExplanationMode::Full;
    let explained = hl.code_to_tokens("let x = 1;", &explain_opts).unwrap();
    let first_ex = explained.tokens[0][0].explanation.as_ref().expect("full explanation attached");
    assert!(!first_ex.is_empty());
    assert!(
        first_ex[0]
            .scopes
            .iter()
            .any(|s| s.scope_name == "source.rust" && !s.theme_matches.is_empty() || s.scope_name.contains("storage"))
    );

    // Custom injection grammar targeting `comment` inside Rust
    let todo_injection = RawGrammar {
        scope_name: "source.todo.injection".to_string(),
        name: Some("todo-injection".to_string()),
        injection_selector: Some("L:comment".to_string()),
        inject_to: vec!["source.rust".to_string()],
        patterns: vec![RawRule {
            match_pattern: Some(r"\bTODO\b".to_string()),
            name: Some("keyword.other.todo".to_string()),
            ..RawRule::default()
        }],
        ..RawGrammar::default()
    };
    hl.load_grammar(todo_injection).unwrap();
    hl.compile_all_grammars().unwrap();

    let mut inj_opts = HighlightOptions::single("rust", "vitesse-dark");
    inj_opts.include_explanation = ExplanationMode::ScopeName;
    let res = hl.code_to_tokens("/* TODO fix me */", &inj_opts).unwrap();
    let has_todo_scope = res.tokens[0].iter().any(|tok| {
        tok.content == "TODO"
            && tok
                .explanation
                .as_ref()
                .is_some_and(|ex| ex.iter().any(|e| e.scopes.iter().any(|s| s.scope_name == "keyword.other.todo")))
    });
    assert!(has_todo_scope, "injected TODO scope should appear inside Rust block comments");

    // Verify FontStyle bitflags helper
    let fs = FontStyle::BOLD | FontStyle::ITALIC;
    assert!(fs.is_bold() && fs.is_italic() && !fs.is_underline());
}
