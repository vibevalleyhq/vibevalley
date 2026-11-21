// Ported from kkos/oniguruma/test/test_options.c, test_syntax.c (Perl/Java/Python/PerlNg),
// and test_regset.c (position-lead multi-pattern scanning).
use vibevalley_onig::{CaptureIndex, FindOption, OnigRegExp, OnigScanner, Syntax};

fn assert_opt_match(options: FindOption, pat: &str, hay: &str, from: usize, to: usize, mem: usize) {
    let re = OnigRegExp::with_options(pat, options, Syntax::Oniguruma).unwrap_or_else(|e| panic!("compile /{pat}/ failed: {e}"));
    let m = re
        .search(hay, 0, options)
        .unwrap_or_else(|e| panic!("exec /{pat}/ failed: {e}"))
        .unwrap_or_else(|| panic!("expected match for /{pat}/ on {hay:?}"));
    assert_eq!(m.get(mem), Some(CaptureIndex::new(from, to)), "span mismatch for /{pat}/ on {hay:?} mem={mem}");
}

fn assert_opt_nomatch(options: FindOption, pat: &str, hay: &str) {
    let re = OnigRegExp::with_options(pat, options, Syntax::Oniguruma).unwrap_or_else(|e| panic!("compile /{pat}/ failed: {e}"));
    let m = re.search(hay, 0, options).unwrap_or_else(|e| panic!("exec /{pat}/ failed: {e}"));
    assert_eq!(m, None, "expected no match for /{pat}/ on {hay:?}");
}

#[test]
fn oniguruma_test_options_suite() {
    let oia = FindOption::IGNORECASE | FindOption::IGNORECASE_IS_ASCII;

    assert_opt_match(FindOption::IGNORECASE, "a", "A", 0, 1, 0);
    assert_opt_nomatch(FindOption::IGNORECASE_IS_ASCII, "a", "A");
    // Kelvin sign U+212A
    assert_opt_match(FindOption::IGNORECASE, "\u{212a}", "k", 0, 1, 0);
    assert_opt_match(FindOption::IGNORECASE, "k", "\u{212a}", 0, 3, 0);
    assert_opt_nomatch(oia, "\u{212a}", "k");
    assert_opt_nomatch(oia, "k", "\u{212a}");
    assert_opt_match(oia, "a", "a", 0, 1, 0);
    assert_opt_match(oia, "A", "A", 0, 1, 0);
    assert_opt_match(oia, "a", "A", 0, 1, 0);
    assert_opt_match(oia, "A", "a", 0, 1, 0);
    assert_opt_match(oia, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", 0, 26, 0);
    assert_opt_match(oia, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", 0, 26, 0);
    assert_opt_match(oia, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "ABCabcdefghijklmnopqrstuvwxyz", 3, 29, 0);
    assert_opt_match(oia, "abcdefghijklmnopqrstuvwxyz", "abcABCDEFGHIJKLMNOPQRSTUVWXYZ", 3, 29, 0);
    assert_opt_match(oia, "#%(a!;)(b&)", "#%A!;B&", 5, 7, 2);

    assert_opt_match(FindOption::IGNORECASE, "ss", "\u{00df}", 0, 2, 0);
    assert_opt_match(FindOption::IGNORECASE, "\u{00df}", "SS", 0, 2, 0);
    assert_opt_nomatch(oia, "ss", "\u{00df}");
    assert_opt_nomatch(oia, "\u{00df}", "ss");
    assert_opt_match(oia, "ss", "SS", 0, 2, 0);
    assert_opt_match(oia, "Ss", "sS", 0, 2, 0);

    assert_opt_nomatch(FindOption::NOTBOL, "^ab", "ab");
    assert_opt_nomatch(FindOption::NOTBOL, "\\Aab", "ab");
    assert_opt_nomatch(FindOption::NOTEOL, "ab$", "ab");
    assert_opt_nomatch(FindOption::NOTEOL, "ab\\z", "ab");
    assert_opt_nomatch(FindOption::NOTEOL, "ab\\Z", "ab");
    assert_opt_nomatch(FindOption::NOTEOL, "ab\\Z", "ab\n");

    assert_opt_nomatch(FindOption::NOT_BEGIN_STRING, "\\Aab", "ab");
    assert_opt_nomatch(FindOption::NOT_END_STRING, "ab\\z", "ab");
    assert_opt_nomatch(FindOption::NOT_END_STRING, "ab\\Z", "ab");
    assert_opt_nomatch(FindOption::NOT_END_STRING, "ab\\Z", "ab\n");

    assert_opt_match(FindOption::NONE, "a|abc", "abc", 0, 1, 0);
    assert_opt_match(FindOption::NONE, "(a|abc)\\Z", "abc", 0, 3, 0);

    assert_opt_match(FindOption::WORD_IS_ASCII, "\\w", "@g", 1, 2, 0);
    assert_opt_nomatch(FindOption::WORD_IS_ASCII, "\\w", "あ");
    assert_opt_match(FindOption::NONE, "\\d", "１", 0, 3, 0);
    assert_opt_nomatch(FindOption::DIGIT_IS_ASCII, "\\d", "１");
    assert_opt_match(FindOption::SPACE_IS_ASCII, "\\s", " ", 0, 1, 0);
    assert_opt_match(FindOption::NONE, "\\s", "　", 0, 3, 0);
    assert_opt_nomatch(FindOption::SPACE_IS_ASCII, "\\s", "　");

    assert_opt_match(FindOption::POSIX_IS_ASCII, "\\w\\d\\s", "c3 ", 0, 3, 0);
    assert_opt_nomatch(FindOption::POSIX_IS_ASCII, "\\w|\\d|\\s", "あ４　");

    assert_opt_match(FindOption::EXTEND, " abc  \n def", "abcdef", 0, 6, 0);
    assert_opt_match(FindOption::FIND_LONGEST, "\\w+", "abc defg hij", 4, 8, 0);
    assert_opt_match(FindOption::FIND_NOT_EMPTY, "\\w*", "@@@ abc defg hij", 4, 7, 0);
}

fn assert_syn_match(syntax: Syntax, pat: &str, hay: &str, from: usize, to: usize) {
    let re = OnigRegExp::with_options(pat, FindOption::DEFAULT, syntax).unwrap_or_else(|e| panic!("compile ({syntax:?}) /{pat}/ failed: {e}"));
    let m = re
        .find(hay)
        .unwrap()
        .unwrap_or_else(|| panic!("expected match ({syntax:?}) /{pat}/ on {hay:?}"));
    assert_eq!(m.full(), CaptureIndex::new(from, to), "/{pat}/ on {hay:?}");
}

fn assert_syn_nomatch(syntax: Syntax, pat: &str, hay: &str) {
    let re = OnigRegExp::with_options(pat, FindOption::DEFAULT, syntax).unwrap_or_else(|e| panic!("compile ({syntax:?}) /{pat}/ failed: {e}"));
    assert_eq!(re.find(hay).unwrap(), None, "/{pat}/ on {hay:?}");
}

#[test]
fn oniguruma_test_syntax_perl_and_java() {
    for syntax in [Syntax::Perl, Syntax::Java] {
        // Reluctant & possessive intervals
        assert_syn_match(syntax, "a{1,3}?", "aaaaaa", 0, 1);
        assert_syn_match(syntax, "a{3}?", "aaaaaa", 0, 3);
        assert_syn_match(syntax, "a{3,3}?", "aaaaaa", 0, 3);
        assert_syn_match(syntax, "a{1,3}+", "aaaaaa", 0, 3);
        assert_syn_match(syntax, "a{3}+", "aaaaaa", 0, 3);
        assert_syn_match(syntax, "a{3,3}+", "aaaaaa", 0, 3);

        // Isolated option semantics in Perl/Java
        assert_syn_match(syntax, "", "", 0, 0);
        assert_syn_match(syntax, "^", "", 0, 0);
        assert_syn_nomatch(syntax, "^a", "\na");
        assert_syn_nomatch(syntax, ".", "\n");
        assert_syn_match(syntax, "(?s:.)", "\n", 0, 1);
        assert_syn_match(syntax, "(?s).", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|.", "\n", 0, 1);
        assert_syn_nomatch(syntax, "(?s:a)|.", "\n");
        assert_syn_match(syntax, "b(?s)a|.", "\n", 0, 1);
        assert_syn_nomatch(syntax, "((?s)a)|.", "\n");
        assert_syn_nomatch(syntax, "b(?:(?s)a)|z|.", "\n");
        assert_syn_nomatch(syntax, ".|b(?s)a", "\n");
        assert_syn_nomatch(syntax, ".(?s)", "\n");
        assert_syn_nomatch(syntax, "(?s)(?-s)a|.", "\n");
        assert_syn_match(syntax, "(?s)a|.(?-s)", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|((?-s)).", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|(?:(?-s)).", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|(?:).", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|(?:.)", "\n", 0, 1);
        assert_syn_match(syntax, "(?s)a|(?:a*).", "\n", 0, 1);
        assert_syn_nomatch(syntax, "a|(?:).", "\n");
        assert_syn_nomatch(syntax, "a|(?:)(.)", "\n");
        assert_syn_match(syntax, "(?s)a|(?:)(.)", "\n", 0, 1);
        assert_syn_match(syntax, "b(?s)a|(?:)(.)", "\n", 0, 1);
        assert_syn_nomatch(syntax, "b((?s)a)|(?:)(.)", "\n");

        // Lookahead & Lookbehind
        assert_syn_match(syntax, "(?=a).b", "ab", 0, 2);
        assert_syn_match(syntax, "(?=ab|(.))\\1", "ab", 1, 2);
        assert_syn_nomatch(syntax, "(?!(.)z)a\\1", "aa");
        assert_syn_match(syntax, "(?<=a)b", "ab", 1, 2);
        assert_syn_match(syntax, "(?<=a|b)c", "abc", 2, 3);
        assert_syn_match(syntax, "(?<=a|(.))\\1", "abcc", 3, 4);
        assert_syn_nomatch(syntax, "(?<!RMA)X", "123RMAX");
        assert_syn_match(syntax, "(?<=RMA)X", "123RMAX", 6, 7);
        assert_syn_nomatch(syntax, "(?<!RMA)$", "123RMA");
        assert_syn_match(syntax, "(?<=RMA)$", "123RMA", 6, 6);
        assert_syn_nomatch(syntax, "(?<!RMA)\\Z", "123RMA");
        assert_syn_match(syntax, "(?<=RMA)\\Z", "123RMA", 6, 6);
        assert_syn_nomatch(syntax, "(?<!RMA)\\z", "123RMA");
        assert_syn_match(syntax, "(?<=RMA)\\z", "123RMA", 6, 6);
        assert_syn_nomatch(syntax, "(?<!c|c)a", "ca");

        // Character class with unescaped dash after char type
        assert_syn_match(syntax, "[\\w\\-%]", "a", 0, 1);
        assert_syn_match(syntax, "[\\w\\-%]", "%", 0, 1);
        assert_syn_match(syntax, "[\\w\\-%]", "-", 0, 1);
        assert_syn_match(syntax, "[\\w-%]", "a", 0, 1);
        assert_syn_match(syntax, "[\\w-%]", "%", 0, 1);
        assert_syn_match(syntax, "[\\w-%]", "-", 0, 1);
    }

    assert_syn_match(Syntax::Java, "(?<=ab|(.))\\1", "abb", 2, 3);
    assert_syn_nomatch(Syntax::Java, "(?<!ab|b)c", "bbc");
    assert_syn_nomatch(Syntax::Java, "(?<!b|ab)c", "bbc");
}

#[test]
fn oniguruma_test_syntax_python_and_perl_ng() {
    // Python (?a) ASCII mode
    assert_syn_match(Syntax::Python, "(?a)\\w", "a", 0, 1);
    assert_syn_match(Syntax::Python, "\\w", "あ", 0, 3);
    assert_syn_nomatch(Syntax::Python, "(?a)\\w", "あ");
    assert_syn_match(Syntax::Python, "\\s", "　", 0, 3);
    assert_syn_nomatch(Syntax::Python, "(?a)\\s", "　");
    assert_syn_match(Syntax::Python, "\\d", "５", 0, 3);
    assert_syn_nomatch(Syntax::Python, "(?a)\\d", "５");
    assert_syn_match(Syntax::Python, "あ\\b ", "あ ", 0, 4);
    assert_syn_nomatch(Syntax::Python, "(?a)あ\\b ", "あ ");
    assert_syn_nomatch(Syntax::Python, "あ\\B ", "あ ");
    assert_syn_match(Syntax::Python, "(?a)あ\\B ", "あ ", 0, 4);
    assert_syn_match(Syntax::Python, "(?a)\\W", "あ", 0, 3);
    assert_syn_nomatch(Syntax::Python, "\\W", "あ");
    assert_syn_match(Syntax::Python, "(?a)\\S", "　", 0, 3);
    assert_syn_nomatch(Syntax::Python, "\\S", "　");
    assert_syn_match(Syntax::Python, "(?a)\\D", "５", 0, 3);
    assert_syn_nomatch(Syntax::Python, "\\D", "５");

    // Python \Z / \z / (?s) / (?m) / (?P<name>) / (?P=name) / (?P>name) / \u / \U
    assert_syn_match(Syntax::Python, "a\\Z", "a", 0, 1);
    assert_syn_nomatch(Syntax::Python, "a\\Z", "a\n");
    assert!(OnigRegExp::with_options("\\z", FindOption::DEFAULT, Syntax::Python).is_err());
    assert_syn_nomatch(Syntax::Python, ".", "\n");
    assert_syn_match(Syntax::Python, "(?s).", "\n", 0, 1);
    assert_syn_nomatch(Syntax::Python, "^abc", "\nabc");
    assert_syn_match(Syntax::Python, "(?m)^abc", "\nabc", 1, 4);
    assert_syn_nomatch(Syntax::Python, "abc$", "abc\ndef");
    assert_syn_match(Syntax::Python, "abc$", "abc\n", 0, 3);
    assert_syn_match(Syntax::Python, "(?m)abc$", "abc\ndef", 0, 3);
    assert_syn_match(Syntax::Python, "(?P<name>abc)", "abc", 0, 3);
    assert_syn_match(Syntax::Python, "(?P<name>abc)(?P=name)", "abcabc", 0, 6);
    assert_syn_match(Syntax::Python, "(?P<name>abc){0}(?P>name)", "abc", 0, 3);
    assert_syn_match(Syntax::Python, "(?P<expr>[^()]+|\\((?P>expr)\\)){0}(?P>expr)", "((((xyz))))", 0, 11);
    assert_syn_match(Syntax::Python, "\\u0041", "A", 0, 1);
    assert_syn_match(Syntax::Python, "\\U00000041", "A", 0, 1);
    assert!(OnigRegExp::with_options("\\U0041", FindOption::DEFAULT, Syntax::Python).is_err());

    // PerlNg inline options & PCRE-style subroutine calls
    assert_syn_match(Syntax::PerlNg, "(?i)test", "TEST", 0, 4);
    assert_syn_nomatch(Syntax::PerlNg, "(?-i)test", "teSt");
    assert_syn_match(Syntax::PerlNg, "(?i)te(?-i)st", "TEst", 0, 4);
    assert_syn_nomatch(Syntax::PerlNg, "(?i)te(?-i)st", "TesT");
    assert_syn_match(Syntax::PerlNg, "(abc)(?-1)", "abcabc", 0, 6);
    assert_syn_match(Syntax::PerlNg, "(?+1)(abc)", "abcabc", 0, 6);
    assert_syn_match(Syntax::PerlNg, "(abc)(?1)", "abcabc", 0, 6);
}

#[test]
fn oniguruma_test_regset_suite() {
    let empty = OnigScanner::new::<&str>(&[]).unwrap();
    assert!(empty.is_empty());
    assert_eq!(empty.find_next_match(" abab bccab ca", 0, FindOption::NONE), None);

    let s1 = OnigScanner::new(&["abc", "(bca)", "(cab)"]).unwrap();
    let m1 = s1.find_next_match(" abab bccab ca", 0, FindOption::NONE).unwrap();
    assert_eq!(m1.index, 2);
    assert_eq!(m1.full(), CaptureIndex::new(8, 11));
    assert_eq!(m1.get(1), Some(CaptureIndex::new(8, 11)));

    let s2 = OnigScanner::new(&["小説", "9", "夏目漱石"]).unwrap();
    assert_eq!(s2.find_next_match(" XXXX AAA 1223 012345678bbb", 0, FindOption::NONE), None);
    let m2 = s2.find_next_match("0123456789", 0, FindOption::NONE).unwrap();
    assert_eq!(m2.index, 1);
    assert_eq!(m2.full(), CaptureIndex::new(9, 10));

    let s7 = OnigScanner::new(&["0+", "1+", "2+", "3+", "4+", "5+", "6+", "7+", "8+", "9+"]).unwrap();
    let m7 = s7.find_next_match("abcde 555 qwert", 0, FindOption::NONE).unwrap();
    assert_eq!(m7.index, 5);
    assert_eq!(m7.full(), CaptureIndex::new(6, 9));

    let s8 = OnigScanner::new(&["a", ".*"]).unwrap();
    let m8 = s8.find_next_match("", 0, FindOption::NONE).unwrap();
    assert_eq!(m8.index, 1);
    assert_eq!(m8.full(), CaptureIndex::new(0, 0));
}
