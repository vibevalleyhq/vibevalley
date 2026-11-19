// Ported from slevithan/oniguruma-to-es/spec/*.spec.js covering Oniguruma edge cases.
use vibevalley_onig::{CaptureIndex, FindOption, OnigRegExp, Syntax};

fn exact_match(pat: &str, hay: &str) {
    let re = OnigRegExp::new(pat).unwrap_or_else(|e| panic!("compile /{pat}/ failed: {e}"));
    let m = re.find(hay).unwrap().unwrap_or_else(|| panic!("expected /{pat}/ to match {hay:?}"));
    assert_eq!(m.full(), CaptureIndex::new(0, hay.len()), "/{pat}/ did not match full {hay:?}");
}

fn finds_match(pat: &str, hay: &str) {
    let re = OnigRegExp::new(pat).unwrap_or_else(|e| panic!("compile /{pat}/ failed: {e}"));
    assert!(re.is_match(hay).unwrap(), "expected /{pat}/ to find match in {hay:?}");
}

fn no_match(pat: &str, hay: &str) {
    let re = OnigRegExp::new(pat).unwrap_or_else(|e| panic!("compile /{pat}/ failed: {e}"));
    assert!(!re.is_match(hay).unwrap(), "expected /{pat}/ NOT to match {hay:?}");
}

fn must_error(pat: &str) {
    assert!(OnigRegExp::new(pat).is_err(), "expected /{pat}/ to fail compilation");
}

#[test]
fn spec_character_class_posix_nested_and_intersection() {
    // Invalid POSIX classes must error
    for pat in ["[[:^:]]", "[[:^u:]]", "[[:^uper:]]", "[[:u:]]", "[[:upp:]]", "[[:uppers:]]", "[[:\u{212a}:]]"] {
        must_error(pat);
    }

    // Non-POSIX classes starting/ending with `:` are standard nested character classes
    for pat in [
        "[[:^1:]]",
        "[[:1:]]",
        "[[:upper :]]",
        "[[:upper1:]]",
        "[[:]]",
        "[[::]]",
        "[[:::]]",
        "[[:abc[:upper:]def:]]",
    ] {
        exact_match(pat, ":");
    }

    // Unclosed nested classes must error
    must_error("[[:::]");
    must_error("[[:[:[:[:upper:]]");

    // Character class intersection `&&`
    exact_match("[a-w&&[^c-g]z]", "a");
    exact_match("[a-w&&[^c-g]z]", "h");
    no_match("[a-w&&[^c-g]z]", "c");
    no_match("[a-w&&[^c-g]z]", "z");
    no_match("[a&&]", "a");
    no_match("[&&a]", "a");
    no_match("[&&]", "a");
    exact_match("[[&&]a]", "a");
    exact_match("[\\w&&a]", "a");
    no_match("[\\w&&a]", "b");
}

#[test]
fn spec_quantifiers_possessive_and_quantifiability() {
    // Possessive quantifiers do not backtrack
    no_match("a++.", "aaa");
    exact_match("a++1", "aaa1");
    no_match("\\u0061++.", "aaa");
    exact_match("\\u0061++1", "aaa1");
    no_match("a*+.", "aaa");
    exact_match("a*+1", "aaa1");
    no_match("a?+.", "a");
    exact_match("a?+1", "a1");

    // Interval `{1,}+` is chained in Oniguruma (NOT possessive)
    exact_match("a{1,}+.", "aaa");

    // Reversed interval `{10,1}` is possessive `{1,10}+`
    exact_match("a{1,10}.", "aaa");
    no_match("a{10,1}.", "aaa");
    exact_match("a{10,1}1", "aaa1");

    // Character classes & groups with possessive quantifiers
    no_match("[a-z]++.", "aaa");
    exact_match("[a-z]++1", "aaa1");
    no_match("(a(a?))++.", "aaaa");
    exact_match("(a(a?))++1", "aaaa1");
    exact_match("a++b++", "ab");
    exact_match("(ab++)++", "ababb");
    exact_match("(a(b)++)++", "ababb");
    exact_match("[.*+]", "*");

    // Quantifying nothing / assertions / directives must error
    for pat in [
        "+", "(+)", "|+", "(|+)", "(+|)", "\\A+", "\\z+", "\\Z+", "^+", "$+", "\\G+", "\\b+", "\\B+", "(?=)+", "(?!)+", "(?<=)+", "(?<!)+", "\\K+", "(?i)+",
        "(?-i)+", "(?i-m)+",
    ] {
        must_error(pat);
    }
}

#[test]
fn spec_lookaround_assertions() {
    // Lookahead
    finds_match("a(?=b)", "ab");
    no_match("a(?=b)", "ac");
    no_match("a(?=b)", "a");
    no_match("a(?!b)", "ab");
    finds_match("a(?!b)", "ac");
    finds_match("a(?=b{2})", "abb");
    finds_match("a(?=b?)", "a");
    finds_match("a(?=b*)", "a");
    finds_match("a(?=b+)", "ab");
    finds_match("a(?=b|cc)", "ab");
    finds_match("a(?=b|cc)", "acc");
    finds_match("a(?=b(?:c|dd))", "abc");
    finds_match("a(?=b(?:c|dd))", "abdd");

    // Lookbehind (fixed & variable length)
    finds_match("(?<=b)a", "ba");
    no_match("(?<=b)a", "ca");
    no_match("(?<!b)a", "ba");
    finds_match("(?<!b)a", "ca");
    finds_match("(?<=b{2})a", "bba");
    finds_match("(?<=b?)a", "a");
    finds_match("(?<=b*)a", "a");
    finds_match("(?<=b+)a", "ba");
    finds_match("(?<=b{0,2})a", "a");
    finds_match("(?<=b{0,})a", "a");
    finds_match("(?<=b|cc)a", "ba");
    finds_match("(?<=b|cc)a", "cca");
    no_match("(?<=b|cc)a", "ca");
    finds_match("(?<=b(?:c|dd))a", "bca");
    finds_match("(?<=b(?:c|dd))a", "bdda");

    // Invalid contents in lookbehind
    for pat in [
        "(?<=(?=))",
        "(?<=(?:a(?=)))",
        "(?<=(?!))",
        "(?<=(?<!))",
        "(?<!(?=))",
        "(?<!(?:a(?=)))",
        "(?<!(?!))",
        "(?<!())",
        "(?<!(?<n>))",
    ] {
        must_error(pat);
    }

    // Valid contents in lookbehind
    for pat in ["(?<=(?<=))", "(?<=())", "(?<=(?<n>))", "(?<!(?<=))", "(?<!(?<!))"] {
        assert!(OnigRegExp::new(pat).is_ok(), "expected /{pat}/ to compile");
    }
}

#[test]
fn spec_subroutines_and_recursion() {
    // Identity escape vs incomplete subroutine
    exact_match("\\g", "g");
    for pat in ["\\g<", "\\g'", "(?<aa>)\\g<aa", "()\\g<1"] {
        must_error(pat);
    }

    // Numbered, forward, relative, named
    exact_match("(a)\\g<1>", "aa");
    exact_match("(a)\\g'1'", "aa");
    exact_match("b(a)b\\g<1>b", "babab");
    exact_match("\\g<1>(a)", "aa");
    exact_match("(\\g<2>(a))", "aa");
    exact_match("(a)(b\\g<1>)\\g<2>", "ababa");
    exact_match("(a)\\g<2>(b\\g<1>)", "ababa");
    exact_match("\\g<2>(a)(b\\g<1>)", "baaba");
    exact_match("(a\\g<2>)(b\\g<3>)(c)", "abcbcc");

    exact_match("(a)\\g<-1>", "aa");
    exact_match("(a)\\g'-1'", "aa");
    exact_match("\\g<+1>(a)", "aa");
    exact_match("\\g'+1'(a)", "aa");
    exact_match("(?<a>a)\\g<a>", "aa");
    exact_match("(?<a>a)\\g'a'", "aa");

    // Missing group / numbered ref when named group exists
    for pat in [
        "\\g<1>",
        "()\\g<2>",
        "(\\g<2>)",
        "(?<a>)\\g<1>",
        "\\g<1>(?<a>)",
        "\\g<-1>",
        "\\g<+1>",
        "(?<a>)\\g<-1>",
    ] {
        must_error(pat);
    }

    // Capture transfer on subroutine calls
    let m = OnigRegExp::new("\\g<1>(.)").unwrap().find("ab").unwrap().unwrap();
    assert_eq!(m.get(1), Some(CaptureIndex::new(1, 2)));

    let m = OnigRegExp::new("(.)\\g<1>").unwrap().find("ab").unwrap().unwrap();
    assert_eq!(m.get(1), Some(CaptureIndex::new(1, 2)));

    let m = OnigRegExp::new("(.)\\g<1>\\g<1>").unwrap().find("abc").unwrap().unwrap();
    assert_eq!(m.get(1), Some(CaptureIndex::new(2, 3)));

    let m = OnigRegExp::new("\\g<1>(\\g<2>)\\g<1>(.)").unwrap().find("abcd").unwrap().unwrap();
    assert_eq!(m.get(1), Some(CaptureIndex::new(2, 3)));
    assert_eq!(m.get(2), Some(CaptureIndex::new(3, 4)));

    // Non-participating captures preserved across subroutine calls
    let m = OnigRegExp::new("(\\S+) (?:x|\\g<1>)").unwrap().find("a x").unwrap().unwrap();
    assert_eq!(m.get(1), Some(CaptureIndex::new(0, 1)));

    let m = OnigRegExp::new("(?i)(a|(b)) \\g<1>").unwrap().find("b a").unwrap().unwrap();
    assert_eq!(m.get(2), Some(CaptureIndex::new(0, 1)));

    let m = OnigRegExp::new("(?i)(a|(b)) \\g<1>").unwrap().find("b B").unwrap().unwrap();
    assert_eq!(m.get(2), Some(CaptureIndex::new(2, 3)));

    // Recursive balanced parentheses and palindrome with recursion-level backref
    exact_match("\\A(?<p>\\((?:[^()]|\\g<p>)*\\))\\z", "((a)(b(c)))");
    no_match("\\A(?<p>\\((?:[^()]|\\g<p>)*\\))\\z", "((a)(b(c))");
    exact_match("\\A(?<a>|.|(?:(?<b>.)\\g<a>\\k<b+0>))\\z", "reer");
    no_match("\\A(?<a>|.|(?:(?<b>.)\\g<a>\\k<b+0>))\\z", "reee");
    exact_match("\\A(?<a>|.|(?:(?<b>.)\\g<a>\\k<b>))\\z", "reee");

    // XML nested tags example from Oniguruma doc/RE
    let xml_re = OnigRegExp::with_options(
        "(?<element> \\g<stag> \\g<content>* \\g<etag> ){0}\n\
         (?<stag> < \\g<name> \\s* > ){0}\n\
         (?<name> [a-zA-Z_:]+ ){0}\n\
         (?<content> [^<&]+ (\\g<element> | [^<&]+)* ){0}\n\
         (?<etag> </ \\k<name+1> >){0}\n\
         \\g<element>",
        FindOption::EXTEND,
        Syntax::Oniguruma,
    )
    .unwrap();
    assert_eq!(xml_re.find("<foo>f<bar>bbb</bar>f</foo>").unwrap().unwrap().full(), CaptureIndex::new(0, 27));
    assert!(xml_re.find("<foo>f<bar>bbb</baz>f</foo>").unwrap().is_none());
}

#[test]
fn spec_search_start_g_anchor() {
    exact_match("[\\G]", "G");
    no_match("[\\G]", "\\");
    exact_match("\\Ga", "a");
    no_match("\\Ga", "ba");
    exact_match("\\K\\Ga", "a");
    exact_match("\\A\\Ga", "a");
    exact_match("(?=a)\\Ga", "a");
    exact_match("(?<=\\A)\\Ga", "a");
    exact_match("(?<!a)\\Ga", "a");
    exact_match("(?=\\G)a", "a");
    exact_match("(?<=\\G)a", "a");
    no_match("a\\G", "a");
    no_match("a+\\G", "a");
    exact_match("(?!a\\G)a", "a");
    exact_match("(?<!a\\G)a", "a");
    finds_match("(?<!a\\G)b", "ab");
}
