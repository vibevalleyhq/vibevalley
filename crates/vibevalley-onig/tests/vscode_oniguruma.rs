use vibevalley_onig::{CaptureIndex, CompileErrorKind, FindOption, OnigScanner, OnigString, ScannerCache, ScannerConfig, ScannerMatch, Syntax};

fn cap(start: usize, end: usize) -> Option<CaptureIndex> {
    Some(CaptureIndex::new(start, end))
}

fn m(index: usize, caps: Vec<Option<CaptureIndex>>) -> Option<ScannerMatch> {
    Some(ScannerMatch { index, capture_indices: caps })
}

#[test]
fn vscode_simple1() {
    let scanner = OnigScanner::new(&["ell", "wo"]).unwrap();
    let s = OnigString::new("Hello world!");
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(1, 4)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 2, FindOption::NONE), m(1, vec![cap(6, 8)]));
}

#[test]
fn vscode_simple2() {
    let scanner = OnigScanner::new(&["a", "b", "c"]).unwrap();
    assert_eq!(scanner.find_next_match("x", 0, FindOption::NONE), None);
    let hay = "xxaxxbxxc";
    assert_eq!(scanner.find_next_match(hay, 0, FindOption::NONE), m(0, vec![cap(2, 3)]));
    assert_eq!(scanner.find_next_match(hay, 4, FindOption::NONE), m(1, vec![cap(5, 6)]));
    assert_eq!(scanner.find_next_match(hay, 7, FindOption::NONE), m(2, vec![cap(8, 9)]));
    assert_eq!(scanner.find_next_match(hay, 9, FindOption::NONE), None);
}

#[test]
fn vscode_unicode1() {
    let scanner1 = OnigScanner::new(&["1", "2"]).unwrap();
    let s1 = OnigString::new("ab…cde21");
    assert_eq!(scanner1.find_next_match_utf16(&s1, 5, FindOption::NONE), m(1, vec![cap(6, 7)]));

    let scanner2 = OnigScanner::new(&["\""]).unwrap();
    let s2 = OnigString::new("{\"…\": 1}");
    assert_eq!(scanner2.find_next_match_utf16(&s2, 1, FindOption::NONE), m(0, vec![cap(1, 2)]));
}

#[test]
fn vscode_unicode2() {
    let scanner = OnigScanner::new(&["Y", "X"]).unwrap();
    let s = OnigString::new("a💻bYX");
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(4, 5)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 1, FindOption::NONE), m(0, vec![cap(4, 5)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 3, FindOption::NONE), m(0, vec![cap(4, 5)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 4, FindOption::NONE), m(0, vec![cap(4, 5)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 5, FindOption::NONE), m(1, vec![cap(5, 6)]));
}

#[test]
fn vscode_unicode3() {
    let scanner = OnigScanner::new(&["Возврат"]).unwrap();
    let s = OnigString::new("Возврат long_var_name;");
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(0, 7)]));
}

#[test]
fn vscode_unicode4_surrogates() {
    let scanner = OnigScanner::new(&["X"]).unwrap();

    // Lone high surrogate 0xd83c
    let s1 = OnigString::from_utf16_lossy(&[b'X' as u16, 0xd83c, b'X' as u16]);
    assert_eq!(scanner.find_next_match_utf16(&s1, 0, FindOption::NONE), m(0, vec![cap(0, 1)]));
    assert_eq!(scanner.find_next_match_utf16(&s1, 1, FindOption::NONE), m(0, vec![cap(2, 3)]));
    assert_eq!(scanner.find_next_match_utf16(&s1, 2, FindOption::NONE), m(0, vec![cap(2, 3)]));

    // Lone low surrogate 0xdfff
    let s2 = OnigString::from_utf16_lossy(&[b'X' as u16, 0xdfff, b'X' as u16]);
    assert_eq!(scanner.find_next_match_utf16(&s2, 0, FindOption::NONE), m(0, vec![cap(0, 1)]));
    assert_eq!(scanner.find_next_match_utf16(&s2, 1, FindOption::NONE), m(0, vec![cap(2, 3)]));
    assert_eq!(scanner.find_next_match_utf16(&s2, 2, FindOption::NONE), m(0, vec![cap(2, 3)]));

    // Valid min & max surrogate pairs
    let s3 = OnigString::from_utf16_lossy(&[b'X' as u16, 0xd800, 0xdc00, b'X' as u16]);
    assert_eq!(scanner.find_next_match_utf16(&s3, 2, FindOption::NONE), m(0, vec![cap(3, 4)]));
    let s4 = OnigString::from_utf16_lossy(&[b'X' as u16, 0xdbff, 0xdfff, b'X' as u16]);
    assert_eq!(scanner.find_next_match_utf16(&s4, 2, FindOption::NONE), m(0, vec![cap(3, 4)]));
}

#[test]
fn vscode_out_of_bounds() {
    let scanner = OnigScanner::new(&["X"]).unwrap();
    let s = OnigString::new("X💻X");
    assert_eq!(scanner.find_next_match_utf16(&s, 1000, FindOption::NONE), None);
    assert_eq!(scanner.find_next_match("X💻X", 1000, FindOption::NONE), None);
}

#[test]
fn vscode_regex_with_g_anchor() {
    let s = OnigString::new("first-and-second");
    let scanner = OnigScanner::new(&["\\G-and"]).unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), None);
    assert_eq!(scanner.find_next_match_utf16(&s, 5, FindOption::NONE), m(0, vec![cap(5, 9)]));
}

#[test]
fn vscode_kkos_oniguruma_192() {
    let s = OnigString::new("    while (i < len && f(array[i]))");
    let pat = "(?x)\n  (?<!\\+\\+|--)(?<=[({\\[,?=>:*]|&&|\\|\\||\\?|\\*\\/|^await|[^\\._$[:alnum:]]await|^return|[^\\._$[:alnum:]]return|^default|[^\\._$[:alnum:]]default|^yield|[^\\._$[:alnum:]]yield|^)\\s*\n  (?!<\\s*[_$[:alpha:]][_$[:alnum:]]*((\\s+extends\\s+[^=>])|,)) # look ahead is not type parameter of arrow\n  (?=(<)\\s*(?:([_$[:alpha:]][-_$[:alnum:].]*)(?<!\\.|-)(:))?((?:[a-z][a-z0-9]*|([_$[:alpha:]][-_$[:alnum:].]*))(?<!\\.|-))(?=((<\\s*)|(\\s+))(?!\\?)|\\/?>))";
    let scanner = OnigScanner::new(&[pat]).unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), None);
}

#[test]
fn vscode_find_option_not_begin_position() {
    let s = OnigString::new("first-and-second");
    let scanner = OnigScanner::new(&["\\G-and"]).unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 5, FindOption::NONE), m(0, vec![cap(5, 9)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 5, FindOption::NOT_BEGIN_POSITION), None);
}

#[test]
fn vscode_find_option_not_begin_string() {
    let s = OnigString::new("first-and-first");
    let scanner = OnigScanner::new(&["\\Afirst"]).unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 10, FindOption::NONE), None);
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(0, 5)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NOT_BEGIN_STRING), None);
}

#[test]
fn vscode_find_option_not_end_string() {
    let s = OnigString::new("first-and-first");
    let scanner = OnigScanner::new(&["first\\z"]).unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 10, FindOption::NONE), m(0, vec![cap(10, 15)]));
    assert_eq!(scanner.find_next_match_utf16(&s, 10, FindOption::NOT_END_STRING), None);
}

#[test]
fn vscode_configure_scanner() {
    let s = OnigString::new("ABCD");
    let scanner = OnigScanner::with_config(
        &["^[a-z]*$"],
        ScannerConfig {
            options: FindOption::IGNORECASE,
            ..ScannerConfig::default()
        },
    )
    .unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(0, 4)]));
}

#[test]
fn vscode_configure_syntax() {
    let s = OnigString::new("first-and-first");
    let scanner = OnigScanner::with_config(
        &["^(?P<name>.*)$"],
        ScannerConfig {
            syntax: Syntax::Python,
            ..ScannerConfig::default()
        },
    )
    .unwrap();
    assert_eq!(scanner.find_next_match_utf16(&s, 0, FindOption::NONE), m(0, vec![cap(0, 15), cap(0, 15)]));
}

#[test]
fn vscode_throw_error_undefined_group_option() {
    let err = OnigScanner::new(&["(?P<name>a*)"]).unwrap_err();
    assert_eq!(err.kind, CompileErrorKind::InvalidGroupOption);
    assert!(err.message.contains("undefined group option"));
}

#[test]
fn scanner_cache_matches_uncached_and_respects_options_and_g_anchor() {
    let scanner = OnigScanner::new(&["\\Gbar", "\\Afoo", "baz", "qux"]).unwrap();
    let s = OnigString::new("foobar baz qux");
    let mut cache = ScannerCache::new(scanner.len());

    // At 0 with NONE: `\Afoo` matches at 0..3
    assert_eq!(
        scanner.find_next_match_cached(&s, 0, FindOption::NONE, &mut cache),
        scanner.find_next_match(s.content(), 0, FindOption::NONE)
    );
    // At 0 with NOT_BEGIN_STRING: cache must invalidate on option change!
    assert_eq!(
        scanner.find_next_match_cached(&s, 0, FindOption::NOT_BEGIN_STRING, &mut cache),
        m(2, vec![cap(7, 10)])
    );
    // At 3 with NONE: `\Gbar` matches at 3..6 (bypasses cache)
    assert_eq!(scanner.find_next_match_cached(&s, 3, FindOption::NONE, &mut cache), m(0, vec![cap(3, 6)]));
    // At 3 with NOT_BEGIN_POSITION: `\Gbar` fails, `baz` matches at 7..10
    assert_eq!(
        scanner.find_next_match_cached(&s, 3, FindOption::NOT_BEGIN_POSITION, &mut cache),
        m(2, vec![cap(7, 10)])
    );
    // Advance to 11: `qux` matches at 11..14
    assert_eq!(scanner.find_next_match_cached(&s, 11, FindOption::NONE, &mut cache), m(3, vec![cap(11, 14)]));
}
