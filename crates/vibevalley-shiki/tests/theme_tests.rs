use std::cmp::Ordering;
use std::path::Path;

use vibevalley_shiki::{
    ColorMap, FontStyle, ParsedThemeRule, RawTheme, RawThemeSetting, RawTokenSettings, ScopePatternList, ScopeStack, ShikiError, StyleAttributes, Theme,
    ThemeTrieElement, ThemeTrieElementRule, load_theme_from_file, normalize_theme, parse_theme, parse_theme_plist, resolve_theme_includes, str_slice_cmp,
};

fn setting(scope: Option<ScopePatternList>, fg: Option<&str>, bg: Option<&str>, font_style: Option<&str>) -> RawThemeSetting {
    RawThemeSetting {
        name: None,
        scope,
        settings: Some(RawTokenSettings {
            foreground: fg.map(str::to_string),
            background: bg.map(str::to_string),
            font_style: font_style.map(str::to_string),
            ..RawTokenSettings::default()
        }),
    }
}

fn s(val: &str) -> Option<ScopePatternList> {
    Some(ScopePatternList::Single(val.to_string()))
}

fn m(vals: &[&str]) -> Option<ScopePatternList> {
    Some(ScopePatternList::Multiple(vals.iter().map(|v| (*v).to_string()).collect()))
}

fn raw(settings: Vec<RawThemeSetting>) -> RawTheme {
    RawTheme {
        settings: Some(settings),
        ..RawTheme::default()
    }
}

/// Ported from `microsoft/vscode-textmate/src/tests/themes.test.ts`.
#[test]
fn theme_matching_deeper_and_parent_priorities() {
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#100000"), Some("#200000"), None),
            setting(s("punctuation.definition.string.begin.html"), Some("#300000"), None, None),
            setting(s("meta.tag punctuation.definition.string"), Some("#400000"), None, None),
        ]),
        None,
    );
    let actual = theme
        .match_scope(ScopeStack::from_segments(["punctuation.definition.string.begin.html"]).as_ref())
        .unwrap();
    assert_eq!(theme.color_map()[actual.foreground_id as usize], "#300000");

    // Parent matches 1
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#100000"), Some("#200000"), None),
            setting(s("c a"), Some("#300000"), None, None),
            setting(s("d a.b"), Some("#400000"), None, None),
            setting(s("a"), Some("#500000"), None, None),
        ]),
        None,
    );
    let actual = theme.match_scope(ScopeStack::from_segments(["d", "a.b"]).as_ref()).unwrap();
    assert_eq!(theme.color_map()[actual.foreground_id as usize], "#400000");

    // Parent matches 2
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#100000"), Some("#200000"), None),
            setting(s("meta.tag entity"), Some("#300000"), None, None),
            setting(s("meta.selector.css entity.name.tag"), Some("#400000"), None, None),
            setting(s("entity"), Some("#500000"), None, None),
        ]),
        None,
    );
    let actual = theme
        .match_scope(ScopeStack::from_segments(["text.html.cshtml", "meta.tag.structure.any.html", "entity.name.tag.structure.any.html"]).as_ref())
        .unwrap();
    assert_eq!(theme.color_map()[actual.foreground_id as usize], "#300000");
}

#[test]
fn theme_matching_all_simple_default_and_multi_cases() {
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#F8F8F2"), Some("#272822"), None),
            setting(s("source, something"), None, Some("#100000"), None),
            setting(m(&["bar", "baz"]), None, Some("#200000"), None),
            setting(s("source.css selector bar"), None, None, Some("bold")),
            setting(s("constant"), Some("#300000"), None, Some("italic")),
            setting(s("constant.numeric"), Some("#400000"), None, None),
            setting(s("constant.numeric.hex"), None, None, Some("bold")),
            setting(s("constant.numeric.oct"), None, None, Some("bold italic underline")),
            setting(s("constant.numeric.dec"), Some("#500000"), None, Some("")),
            setting(s("storage.object.bar"), Some("#600000"), None, Some("")),
        ]),
        None,
    );
    let map = theme.color_map();

    let check = |path: &[&str], fg: Option<&str>, bg: Option<&str>, fs: &str| {
        let res = theme.match_scope(ScopeStack::from_segments(path.iter().copied()).as_ref()).expect("match");
        assert_eq!(res.font_style.to_display_string(), fs, "path={path:?}");
        let got_fg = (res.foreground_id != 0).then(|| map[res.foreground_id as usize].as_str());
        let got_bg = (res.background_id != 0).then(|| map[res.background_id as usize].as_str());
        assert_eq!(got_fg, fg, "fg mismatch for {path:?}");
        assert_eq!(got_bg, bg, "bg mismatch for {path:?}");
    };

    check(&["source"], None, Some("#100000"), "not set");
    check(&["source.ts"], None, Some("#100000"), "not set");
    check(&["source.tss"], None, Some("#100000"), "not set");
    check(&["something"], None, Some("#100000"), "not set");
    check(&["something.ts"], None, Some("#100000"), "not set");
    check(&["something.tss"], None, Some("#100000"), "not set");
    check(&["baz"], None, Some("#200000"), "not set");
    check(&["baz.ts"], None, Some("#200000"), "not set");
    check(&["baz.tss"], None, Some("#200000"), "not set");
    check(&["constant"], Some("#300000"), None, "italic");
    check(&["constant.string"], Some("#300000"), None, "italic");
    check(&["constant.hex"], Some("#300000"), None, "italic");
    check(&["constant.numeric"], Some("#400000"), None, "italic");
    check(&["constant.numeric.baz"], Some("#400000"), None, "italic");
    check(&["constant.numeric.hex"], Some("#400000"), None, "bold");
    check(&["constant.numeric.hex.baz"], Some("#400000"), None, "bold");
    check(&["constant.numeric.oct"], Some("#400000"), None, "italic bold underline");
    check(&["constant.numeric.oct.baz"], Some("#400000"), None, "italic bold underline");
    check(&["constant.numeric.dec"], Some("#500000"), None, "none");
    check(&["constant.numeric.dec.baz"], Some("#500000"), None, "none");
    check(&["storage.object.bar"], Some("#600000"), None, "none");
    check(&["storage.object.bar.baz"], Some("#600000"), None, "none");
    check(&["storage.object.bart"], None, None, "not set");
    check(&["storage.object"], None, None, "not set");
    check(&["storage"], None, None, "not set");
    check(&[""], None, None, "not set");
    check(&["bazz"], None, None, "not set");
    check(&["asdfg"], None, None, "not set");
    check(&["bar"], None, Some("#200000"), "not set");
    check(&["source.css", "selector", "bar"], None, Some("#200000"), "bold");
}

#[test]
fn theme_matching_vscode_23460_child_combinator_and_issue_233() {
    // Microsoft/vscode#23460
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#aec2e0"), Some("#14191f"), None),
            setting(s("meta.structure.dictionary.json string.quoted.double.json"), Some("#FF410D"), None, None),
            setting(s("meta.structure.dictionary.json string.quoted.double.json"), Some("#ffffff"), None, None),
            setting(s("meta.structure.dictionary.value.json string.quoted.double.json"), Some("#FF410D"), None, None),
        ]),
        None,
    );
    let path = ScopeStack::from_segments([
        "source.json",
        "meta.structure.dictionary.json",
        "meta.structure.dictionary.value.json",
        "string.quoted.double.json",
    ]);
    let res = theme.match_scope(path.as_ref()).unwrap();
    assert_eq!(theme.color_map()[res.foreground_id as usize], "#FF410D");

    // Child combinator `>`
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#100000"), None, None),
            setting(s("b a"), Some("#200000"), None, None),
            setting(s("b > a"), Some("#300000"), None, None),
            setting(s("c > b > a"), Some("#400000"), None, None),
            setting(s("a"), Some("#500000"), None, None),
        ]),
        None,
    );
    let fg = |p: &[&str]| -> &str {
        let r = theme.match_scope(ScopeStack::from_segments(p.iter().copied()).as_ref()).unwrap();
        &theme.color_map()[r.foreground_id as usize]
    };
    assert_eq!(fg(&["b", "a"]), "#300000");
    assert_eq!(fg(&["b", "c", "a"]), "#200000");
    assert_eq!(fg(&["c", "b", "a"]), "#400000");
    assert_eq!(fg(&["c", "b", "d", "a"]), "#200000");

    // Specificity #233: deeper parent scope wins over more shallow parent scopes
    let theme = Theme::create_from_raw_theme(
        &raw(vec![
            setting(None, Some("#100000"), None, None),
            setting(s("y.z a.b"), Some("#200000"), None, None),
            setting(s("x y a.b"), Some("#300000"), None, None),
        ]),
        None,
    );
    let fg_opt = |p: &[&str]| -> Option<&str> {
        let r = theme.match_scope(ScopeStack::from_segments(p.iter().copied()).as_ref())?;
        (r.foreground_id != 0).then(|| theme.color_map()[r.foreground_id as usize].as_str())
    };
    assert_eq!(fg_opt(&["x", "a.b"]), None);
    assert_eq!(fg_opt(&["y", "a.b"]), None);
    assert_eq!(fg_opt(&["y.z", "a"]), None);
    assert_eq!(fg_opt(&["x", "y", "a.b"]), Some("#300000"));
    assert_eq!(fg_opt(&["x", "y.z", "a.b"]), Some("#200000"));
}

#[test]
fn theme_parsing_issues_35_38_and_str_slice_cmp() {
    // Issue #38: ignores invalid colors
    let parsed = parse_theme(&raw(vec![
        setting(None, Some("#cccccc"), Some("#222222"), None),
        setting(s("variable"), None, None, Some("")),
        setting(s("variable.parameter"), Some(""), None, Some("italic")),
        setting(s("support.other.variable"), None, None, Some("")),
        setting(s("variable.other"), Some(""), None, Some("normal")),
        setting(s("variable.parameter.function.coffee"), Some("#F9D423"), None, Some("italic")),
    ]));
    assert_eq!(parsed.len(), 6);
    assert_eq!(parsed[0].foreground.as_deref(), Some("#cccccc"));
    assert_eq!(parsed[1].font_style, FontStyle::NONE);
    assert_eq!(parsed[2].foreground, None);
    assert_eq!(parsed[2].font_style, FontStyle::ITALIC);
    assert_eq!(parsed[4].foreground, None);
    assert_eq!(parsed[4].font_style, FontStyle::NONE);
    assert_eq!(parsed[5].foreground.as_deref(), Some("#F9D423"));

    // Issue #35: trailing comma with newlines
    let parsed = parse_theme(&raw(vec![
        setting(None, Some("#EFEFEF"), Some("#25292C"), None),
        setting(
            s("meta.at-rule.return.scss,\nmeta.at-rule.return.scss punctuation.definition,\nmeta.at-rule.else.scss,\n"),
            Some("#CC7832"),
            None,
            None,
        ),
    ]));
    assert_eq!(parsed.len(), 4);
    assert_eq!(parsed[1].scope, "meta.at-rule.return.scss");
    assert_eq!(parsed[2].scope, "punctuation.definition");
    assert_eq!(parsed[2].parent_scopes.as_deref(), Some(&["meta.at-rule.return.scss".to_string()][..]));
    assert_eq!(parsed[3].scope, "meta.at-rule.else.scss");

    // strArrCmp parity
    let a = vec!["a".to_string()];
    let ab = vec!["a".to_string(), "b".to_string()];
    let ac = vec!["a".to_string(), "c".to_string()];
    let empty: Vec<String> = vec![];
    assert_eq!(str_slice_cmp(None, None), Ordering::Equal);
    assert_eq!(str_slice_cmp(None, Some(&empty)), Ordering::Less);
    assert_eq!(str_slice_cmp(Some(&empty), None), Ordering::Greater);
    assert_eq!(str_slice_cmp(Some(&empty), Some(&a)), Ordering::Less);
    assert_eq!(str_slice_cmp(Some(&ab), Some(&a)), Ordering::Greater);
    assert_eq!(str_slice_cmp(Some(&ab), Some(&ac)), Ordering::Less);
}

#[test]
fn theme_resolving_defaults_and_trie_inheritance() {
    // Always has defaults
    let actual = Theme::create_from_parsed_theme(vec![], None);
    let mut cm = ColorMap::default();
    let fg = cm.get_id(Some("#000000"));
    let bg = cm.get_id(Some("#ffffff"));
    assert_eq!(actual.color_map(), cm.color_map());
    assert_eq!(actual.defaults(), &StyleAttributes::new(FontStyle::NONE, fg, bg, "", 0.0, 0.0));
    assert_eq!(
        actual.root(),
        &ThemeTrieElement::new(ThemeTrieElementRule::new(0, None, FontStyle::NOT_SET, 0, 0, "", 0.0, 0.0), vec![])
    );

    // Same rules get merged by index order
    let actual = Theme::create_from_parsed_theme(
        vec![
            ParsedThemeRule {
                scope: String::new(),
                parent_scopes: None,
                index: 0,
                font_style: FontStyle::NOT_SET,
                foreground: Some("#F8F8F2".to_string()),
                background: Some("#272822".to_string()),
                font_family: String::new(),
                font_size: 0.0,
                line_height: 0.0,
            },
            ParsedThemeRule {
                scope: "var".to_string(),
                parent_scopes: None,
                index: 2,
                font_style: FontStyle::BOLD,
                foreground: None,
                background: None,
                font_family: String::new(),
                font_size: 0.0,
                line_height: 0.0,
            },
            ParsedThemeRule {
                scope: "var".to_string(),
                parent_scopes: None,
                index: 1,
                font_style: FontStyle::NOT_SET,
                foreground: Some("#ff0000".to_string()),
                background: None,
                font_family: String::new(),
                font_size: 0.0,
                line_height: 0.0,
            },
        ],
        None,
    );
    let var_match = actual.match_scope(ScopeStack::from_segments(["var"]).as_ref()).unwrap();
    assert_eq!(var_match.font_style, FontStyle::BOLD);
    assert_eq!(actual.color_map()[var_match.foreground_id as usize], "#FF0000");
}

#[test]
fn vscode_theme_include_inheritance_and_tmtheme_plist() {
    let themes_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/themes");

    // dark_plus.json includes ./dark_vs.json
    let dark_plus = load_theme_from_file(&themes_dir.join("dark_plus.json")).expect("dark_plus loads");
    assert_eq!(dark_plus.name.as_deref(), Some("Dark+"));
    let resolved = normalize_theme(&dark_plus);
    assert_eq!(resolved.fg, "#D4D4D4");
    assert_eq!(resolved.bg, "#1E1E1E");
    let compiled = resolved.compile();
    // From dark_vs.json (inherited): comment -> #608B4E
    let comment = compiled.match_scope(ScopeStack::from_segments(["comment.line"]).as_ref()).unwrap();
    assert_eq!(compiled.color_map()[comment.foreground_id as usize], "#608B4E");
    // From dark_plus.json (child override): entity.name.function -> #DCDCAA
    let func = compiled.match_scope(ScopeStack::from_segments(["entity.name.function.rs"]).as_ref()).unwrap();
    assert_eq!(compiled.color_map()[func.foreground_id as usize], "#DCDCAA");

    // light_plus.json includes ./light_vs.json
    let light_plus = load_theme_from_file(&themes_dir.join("light_plus.json")).expect("light_plus loads");
    assert_eq!(light_plus.name.as_deref(), Some("Light+"));

    // .tmTheme XML plist decoding
    let monokai_xml = std::fs::read_to_string(themes_dir.join("Monokai.tmTheme")).unwrap();
    let monokai = parse_theme_plist(&monokai_xml).expect("Monokai.tmTheme parses");
    let monokai_resolved = normalize_theme(&monokai);
    assert_eq!(monokai_resolved.name, "Monokai");
    assert_eq!(monokai_resolved.fg, "#F8F8F2");
    assert_eq!(monokai_resolved.bg, "#272822");

    // Cycle detection in include chains
    let cyclic = RawTheme {
        name: Some("a".to_string()),
        include: Some("b".to_string()),
        ..RawTheme::default()
    };
    let err = resolve_theme_includes(cyclic, &mut |key| {
        Ok(RawTheme {
            name: Some(key.to_string()),
            include: Some("b".to_string()),
            ..RawTheme::default()
        })
    })
    .unwrap_err();
    assert!(matches!(err, ShikiError::ThemeIncludeCycle(_)));
}
