use vibevalley_shiki::{InjectionPriority, create_matchers};

fn exact_name_matcher(identifiers: &[String], stack: &&[&str]) -> bool {
    let mut last_index = 0;
    for identifier in identifiers {
        let mut found = false;
        for (i, &scope) in stack.iter().enumerate().skip(last_index) {
            if scope == identifier {
                last_index = i + 1;
                found = true;
                break;
            }
        }
        if !found {
            return false;
        }
    }
    true
}

/// Ported directly from `microsoft/vscode-textmate/src/tests/matcher.test.ts` (all 27 cases).
#[test]
fn upstream_vscode_textmate_matcher_suite() {
    let cases: &[(&str, &[&str], bool)] = &[
        ("foo", &["foo"], true),
        ("foo", &["bar"], false),
        ("- foo", &["foo"], false),
        ("- foo", &["bar"], true),
        ("- - foo", &["bar"], false),
        ("bar foo", &["foo"], false),
        ("bar foo", &["bar"], false),
        ("bar foo", &["bar", "foo"], true),
        ("bar - foo", &["bar"], true),
        ("bar - foo", &["foo", "bar"], false),
        ("bar - foo", &["foo"], false),
        ("bar, foo", &["foo"], true),
        ("bar, foo", &["bar"], true),
        ("bar, foo", &["bar", "foo"], true),
        ("bar, -foo", &["bar", "foo"], true),
        ("bar, -foo", &["yo"], true),
        ("bar, -foo", &["foo"], false),
        ("(foo)", &["foo"], true),
        ("(foo - bar)", &["foo"], true),
        ("(foo - bar)", &["foo", "bar"], false),
        ("foo bar - (yo man)", &["foo", "bar"], true),
        ("foo bar - (yo man)", &["foo", "bar", "yo"], true),
        ("foo bar - (yo man)", &["foo", "bar", "yo", "man"], false),
        ("foo bar - (yo | man)", &["foo", "bar", "yo", "man"], false),
        ("foo bar - (yo | man)", &["foo", "bar", "yo"], false),
        ("R:text.html - (comment.block, text.html source)", &["text.html", "bar", "source"], false),
        (
            "text.html.php - (meta.embedded | meta.tag), L:text.html.php meta.tag, L:source.js.embedded.html",
            &["text.html.php", "bar", "source.js"],
            true,
        ),
    ];

    for (idx, &(expression, input, expected)) in cases.iter().enumerate() {
        let matchers = create_matchers(expression);
        let actual = matchers.iter().any(|m| m.matcher.matches_with(&input, &exact_name_matcher));
        assert_eq!(actual, expected, "Matcher Test #{idx} failed for `{expression}`");
    }
}

#[test]
fn matcher_priorities_are_parsed_and_ordered() {
    let matchers = create_matchers("R:source.js, source.ts, L:source.rs");
    assert_eq!(matchers.len(), 3);
    assert_eq!(matchers[0].priority, InjectionPriority::Right);
    assert_eq!(matchers[1].priority, InjectionPriority::Default);
    assert_eq!(matchers[2].priority, InjectionPriority::Left);
    assert!(InjectionPriority::Left < InjectionPriority::Default);
    assert!(InjectionPriority::Default < InjectionPriority::Right);
}
