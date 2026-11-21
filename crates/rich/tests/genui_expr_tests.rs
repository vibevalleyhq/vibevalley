use std::collections::BTreeSet;

use vibevalley_rich::engine::genui::{
    EvalLimits, FormatKind, GenUiError, StateStore, StateValue, eval_expr, eval_template, format_value, parse_expr, parse_expr_with_limits, parse_template,
    parse_template_with_limits, referenced_keys, template_referenced_keys,
};

fn eval(src: &str, state: &StateStore) -> StateValue {
    let expr = parse_expr(src).unwrap_or_else(|e| panic!("parse failed for `{src}`: {e}"));
    eval_expr(&expr, state, EvalLimits::default()).unwrap_or_else(|e| panic!("eval failed for `{src}`: {e}"))
}

fn eval_err(src: &str, state: &StateStore) -> GenUiError {
    let expr = parse_expr(src).unwrap_or_else(|e| panic!("parse failed for `{src}`: {e}"));
    eval_expr(&expr, state, EvalLimits::default()).expect_err(&format!("expected error for `{src}`"))
}

fn expect_num(val: StateValue) -> f64 {
    val.as_f64().unwrap_or_else(|| panic!("expected number, got {val:?}"))
}

#[test]
fn arithmetic_precedence_and_power_associativity() {
    let state = StateStore::new();
    assert_eq!(expect_num(eval("1 + 2 * 3", &state)), 7.0);
    assert_eq!(expect_num(eval("(1 + 2) * 3", &state)), 9.0);
    assert_eq!(expect_num(eval("2 ^ 3 ^ 2", &state)), 512.0);
    assert_eq!(expect_num(eval("-2 ^ 2", &state)), -4.0);
    assert_eq!(expect_num(eval("(-2) ^ 2", &state)), 4.0);
    assert_eq!(expect_num(eval("2 ^ -3", &state)), 0.125);
    assert_eq!(expect_num(eval("17 % 5", &state)), 2.0);
    assert_eq!(expect_num(eval("1.5e2 + +5", &state)), 155.0);
    assert_eq!(eval("= 2 + 3 * 4", &state), StateValue::Number(14.0));
}

#[test]
fn comparisons_booleans_and_short_circuiting() {
    let mut state = StateStore::new();
    state.set("x", StateValue::from(0));
    state.set("name", StateValue::from("alpha"));

    assert_eq!(eval("1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3", &state), StateValue::Bool(true));
    assert_eq!(eval("name == 'alpha' && name != 'beta'", &state), StateValue::Bool(true));
    assert_eq!(eval("!false && !0 && !'' && !null", &state), StateValue::Bool(true));

    assert_eq!(eval("false && (1 / 0 == 0)", &state), StateValue::Bool(false));
    assert_eq!(eval("true || (1 / 0 == 0)", &state), StateValue::Bool(true));
    assert_eq!(eval("x != 0 ? 100 / x : 42", &state), StateValue::Number(42.0));
    assert_eq!(eval("if(x != 0, 100 / x, 99)", &state), StateValue::Number(99.0));
    assert_eq!(eval("coalesce(null, 7, 1 / 0)", &state), StateValue::Number(7.0));
    assert_eq!(eval("false ? 1 : true ? 2 : 3", &state), StateValue::Number(2.0));
}

#[test]
fn division_by_zero_and_non_finite_results_fail_cleanly() {
    let state = StateStore::new();
    assert_eq!(eval_err("1 / 0", &state), GenUiError::DivisionByZero);
    assert_eq!(eval_err("5 % 0", &state), GenUiError::DivisionByZero);
    assert!(matches!(eval_err("sqrt(-1)", &state), GenUiError::NonFiniteResult { .. }));
    assert!(matches!(eval_err("ln(0)", &state), GenUiError::NonFiniteResult { .. }));
    assert!(matches!(eval_err("ln(-5)", &state), GenUiError::NonFiniteResult { .. }));
    assert!(matches!(eval_err("log10(0)", &state), GenUiError::NonFiniteResult { .. }));
    assert!(matches!(eval_err("pow(-1, 0.5)", &state), GenUiError::NonFiniteResult { .. }));
    assert!(matches!(eval_err("pow(10, 1000)", &state), GenUiError::NonFiniteResult { .. }));
    assert_eq!(
        eval_err("missing_key + 1", &state),
        GenUiError::UndefinedVariable {
            name: "missing_key".to_owned()
        }
    );
}

#[test]
fn state_vars_field_index_and_collection_builtins() {
    let mut state = StateStore::new();
    state.set("principal", StateValue::from(10_000));
    state.set("rate", StateValue::from(7.5));
    state.set(
        "items",
        StateValue::List(vec![
            StateValue::Record(vec![("name".to_owned(), StateValue::from("Alpha")), ("score".to_owned(), StateValue::from(80))]),
            StateValue::Record(vec![("name".to_owned(), StateValue::from("Beta")), ("score".to_owned(), StateValue::from(95))]),
            StateValue::Record(vec![("name".to_owned(), StateValue::from("Gamma")), ("score".to_owned(), StateValue::from(60))]),
        ]),
    );

    assert_eq!(eval("$principal * ($rate / 100)", &state), StateValue::Number(750.0));
    assert_eq!(eval("items[1].name", &state), StateValue::Text("Beta".to_owned()));
    assert_eq!(eval("items[1]['score']", &state), StateValue::Number(95.0));
    assert_eq!(eval("coalesce(items[99].name, 'none')", &state), StateValue::Text("none".to_owned()));

    assert_eq!(
        eval("range(0, 5, 1)", &state),
        StateValue::List(vec![
            StateValue::Number(0.0),
            StateValue::Number(1.0),
            StateValue::Number(2.0),
            StateValue::Number(3.0),
            StateValue::Number(4.0),
        ])
    );
    assert_eq!(
        eval("range(5, 0, -2)", &state),
        StateValue::List(vec![StateValue::Number(5.0), StateValue::Number(3.0), StateValue::Number(1.0),])
    );
    assert!(matches!(eval_err("range(0, 10, 0)", &state), GenUiError::InvalidRange { .. }));

    assert_eq!(eval("sum(map(items, x, x.score))", &state), StateValue::Number(235.0));
    assert_eq!(eval("sum(map(items, x => x.score))", &state), StateValue::Number(235.0));
    assert_eq!(
        eval("map(range(3), (v, i) => v * 10 + i)", &state),
        StateValue::List(vec![StateValue::Number(0.0), StateValue::Number(11.0), StateValue::Number(22.0),])
    );
    assert_eq!(eval("len(filter(items, x, x.score >= 80))", &state), StateValue::Number(2.0));
    assert_eq!(
        eval("sort_by(items, x => x.score, 'desc')[0].name", &state),
        StateValue::Text("Beta".to_owned())
    );
    assert_eq!(eval("any(items, x => x.score > 90)", &state), StateValue::Bool(true));
    assert_eq!(eval("all(items, x => x.score >= 60)", &state), StateValue::Bool(true));
    assert_eq!(eval("avg(map(items, item.score))", &state), StateValue::Number(235.0 / 3.0));
    assert_eq!(eval("avg([])", &state), StateValue::Number(0.0));
    assert_eq!(eval("min(map(items, x, x.score))", &state), StateValue::Number(60.0));
    assert_eq!(eval("max(map(items, x, x.score))", &state), StateValue::Number(95.0));
}

#[test]
fn math_string_and_format_builtins() {
    let mut state = StateStore::new();
    state.set("total", StateValue::from(38_696.844_6));

    assert_eq!(expect_num(eval("min(5, 2, 9)", &state)), 2.0);
    assert_eq!(expect_num(eval("max(5, 2, 9)", &state)), 9.0);
    assert_eq!(expect_num(eval("clamp(15, 0, 10)", &state)), 10.0);
    assert_eq!(expect_num(eval("clamp(-3, 0, 10)", &state)), 0.0);
    assert_eq!(expect_num(eval("abs(-42.5)", &state)), 42.5);
    assert_eq!(expect_num(eval("round(2.71828, 2)", &state)), 2.72);
    assert_eq!(expect_num(eval("floor(3.9)", &state)), 3.0);
    assert_eq!(expect_num(eval("ceil(3.1)", &state)), 4.0);
    assert_eq!(expect_num(eval("pow(2, 10)", &state)), 1024.0);
    assert_eq!(expect_num(eval("sqrt(81)", &state)), 9.0);
    assert!((expect_num(eval("ln(2.718281828459045)", &state)) - 1.0).abs() < 1e-12);
    assert!((expect_num(eval("log10(1000)", &state)) - 3.0).abs() < 1e-12);
    assert_eq!(expect_num(eval("len('你好world')", &state)), 7.0);

    assert_eq!(
        eval("\"Total: ${format(total, 'currency')}\"", &state),
        StateValue::Text("Total: $38,696.84".to_owned())
    );
    assert_eq!(eval("format(-500.5, 'currency')", &state), StateValue::Text("-$500.50".to_owned()));
    assert_eq!(eval("format(-0.0, 'currency')", &state), StateValue::Text("$0.00".to_owned()));
    assert_eq!(eval("format(0.1567, 'percent')", &state), StateValue::Text("15.7%".to_owned()));
    assert_eq!(eval("format(1250000, 'compact')", &state), StateValue::Text("1.3M".to_owned()));
    assert_eq!(eval("format(1200, 'compact')", &state), StateValue::Text("1.2K".to_owned()));
    assert_eq!(eval("format(12345.6, 'integer')", &state), StateValue::Text("12,346".to_owned()));
    assert_eq!(eval("format(125, 'duration')", &state), StateValue::Text("2m 5s".to_owned()));
    assert_eq!(format_value(&StateValue::Number(12.5), FormatKind::PercentPoints, None).unwrap(), "12.5%");

    assert_eq!(eval("contains('VibeValley', 'Valley')", &state), StateValue::Bool(true));
    assert_eq!(eval("lower(trim('  HeLLo  '))", &state), StateValue::Text("hello".to_owned()));
    assert_eq!(eval("upper('ok')", &state), StateValue::Text("OK".to_owned()));
    assert_eq!(eval("concat('Yr ', 5)", &state), StateValue::Text("Yr 5".to_owned()));
    assert_eq!(eval("num('42.5')", &state), StateValue::Number(42.5));
    assert_eq!(eval("str(100)", &state), StateValue::Text("100".to_owned()));
}

#[test]
fn template_interpolation_escaping_and_latex_preservation() {
    let mut state = StateStore::new();
    state.set("total", StateValue::from(1234.5));
    state.set("ok", StateValue::from(true));

    let tpl = parse_template("Total: ${format(total, 'currency')} (${ok ? \"On\" : \"Off\"}) \\${literal} $\\frac{1}{2}$").unwrap();
    let rendered = eval_template(&tpl, &state, EvalLimits::default()).unwrap();
    assert_eq!(rendered, "Total: $1,234.50 (On) ${literal} $\\frac{1}{2}$");

    let deps = template_referenced_keys(&tpl);
    assert_eq!(deps, BTreeSet::from(["ok".to_owned(), "total".to_owned()]));
}

#[test]
fn referenced_keys_excludes_shadowed_loop_variables() {
    let expr = parse_expr("map(range(0, years + 1, 1), y, round($principal * pow(1 + rate / 100, y) + bonus))").unwrap();
    assert_eq!(
        referenced_keys(&expr),
        BTreeSet::from(["bonus".to_owned(), "principal".to_owned(), "rate".to_owned(), "years".to_owned(),])
    );

    let nested = parse_expr("filter(deals, d => any(tags, (t, idx) => d.tag == t && idx < max_idx && region == d.region))").unwrap();
    assert_eq!(
        referenced_keys(&nested),
        BTreeSet::from(["deals".to_owned(), "max_idx".to_owned(), "region".to_owned(), "tags".to_owned(),])
    );
}

#[test]
fn security_limits_prevent_dos_and_arbitrary_calls() {
    let state = StateStore::new();

    assert_eq!(parse_expr("exec('rm -rf /')"), Err(GenUiError::UnknownFunction { name: "exec".to_owned() }));

    let small_limits = EvalLimits {
        max_steps: 50,
        max_depth: 12,
        max_collection_len: 20,
        max_string_len: 32,
    };

    let nested_parens = format!("{}1{}", "(".repeat(20), ")".repeat(20));
    assert_eq!(
        parse_expr_with_limits(&nested_parens, small_limits),
        Err(GenUiError::DepthLimitExceeded { limit: 12 })
    );

    let nested_tpl = format!("{}{}", "${\"".repeat(20), "\"}".repeat(20));
    assert_eq!(
        parse_template_with_limits(&nested_tpl, small_limits),
        Err(GenUiError::DepthLimitExceeded { limit: 12 })
    );

    let huge_range = parse_expr("range(0, 100000, 1)").unwrap();
    assert_eq!(
        eval_expr(&huge_range, &state, small_limits),
        Err(GenUiError::CollectionLimitExceeded { limit: 20 })
    );

    let step_bomb = parse_expr("map(range(0, 15, 1), a, map(range(0, 15, 1), b, a * b))").unwrap();
    assert_eq!(eval_expr(&step_bomb, &state, small_limits), Err(GenUiError::StepLimitExceeded { limit: 50 }));

    let big_str = parse_expr("'01234567890123456789' + '01234567890123456789'").unwrap();
    assert_eq!(eval_expr(&big_str, &state, small_limits), Err(GenUiError::StringLimitExceeded { limit: 32 }));

    let single_concat_str = parse_expr("concat('0123456789012345678901234567890123')").unwrap();
    assert_eq!(
        eval_expr(&single_concat_str, &state, small_limits),
        Err(GenUiError::StringLimitExceeded { limit: 32 })
    );

    let mut huge_list_state = StateStore::new();
    huge_list_state.set("big", StateValue::List((0..25).map(StateValue::from).collect()));
    let single_concat_list = parse_expr("concat(big)").unwrap();
    assert_eq!(
        eval_expr(&single_concat_list, &huge_list_state, small_limits),
        Err(GenUiError::CollectionLimitExceeded { limit: 20 })
    );
}

#[test]
fn record_structural_equality_is_symmetric_with_duplicate_keys() {
    let dup_x = StateValue::Record(vec![("x".to_owned(), StateValue::from(1)), ("x".to_owned(), StateValue::from(1))]);
    let xy = StateValue::Record(vec![("x".to_owned(), StateValue::from(1)), ("y".to_owned(), StateValue::from(2))]);
    assert!(!dup_x.structural_eq(&xy));
    assert!(!xy.structural_eq(&dup_x));

    let dup_a = StateValue::Record(vec![
        ("x".to_owned(), StateValue::from(1)),
        ("x".to_owned(), StateValue::from(1)),
        ("y".to_owned(), StateValue::from(2)),
    ]);
    let dup_b = StateValue::Record(vec![
        ("x".to_owned(), StateValue::from(1)),
        ("y".to_owned(), StateValue::from(2)),
        ("y".to_owned(), StateValue::from(2)),
    ]);
    assert!(!dup_a.structural_eq(&dup_b));
    assert!(!dup_b.structural_eq(&dup_a));

    let reordered = StateValue::Record(vec![("y".to_owned(), StateValue::from(2)), ("x".to_owned(), StateValue::from(1))]);
    assert!(xy.structural_eq(&reordered));
    assert!(reordered.structural_eq(&xy));
}

#[test]
fn malformed_expressions_and_type_errors_return_structured_errors() {
    let mut state = StateStore::new();
    state.set("xs", StateValue::List(vec![StateValue::from(1), StateValue::from(2)]));

    for bad in [
        "",
        "'unterminated",
        "\"unterminated",
        "\"${}\"",
        "\"${unclosed\"",
        "1 = 2",
        "1 & 2",
        "1 | 2",
        "1e",
        "1 2",
        "$",
        "xs.",
    ] {
        assert!(matches!(parse_expr(bad), Err(GenUiError::ExprParse { .. })), "expected ExprParse for `{bad}`");
    }

    assert!(matches!(eval_err("format(10, 'bogus')", &state), GenUiError::UnknownFormat { .. }));
    assert!(matches!(eval_err("clamp(5, 10, 1)", &state), GenUiError::InvalidRange { .. }));
    assert!(matches!(eval_err("round(1.5, -1)", &state), GenUiError::InvalidRange { .. }));
    assert!(matches!(eval_err("xs[-1]", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("xs[0.5]", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("'a' - 1", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("true < 5", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("len(42)", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("map(42, x, x)", &state), GenUiError::TypeMismatch { .. }));
    assert!(matches!(eval_err("clamp(1, 2)", &state), GenUiError::ArityMismatch { .. }));
}
