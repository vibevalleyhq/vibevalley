use std::cell::RefCell;
use std::collections::HashSet;
use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use vibevalley_pele::config::DiagramConfig;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::class::ClassDb;
use vibevalley_pele::diagram::class::graph::{NodeShape, build_class_graph};
use vibevalley_pele::diagram::class::lexer::tokenize;
use vibevalley_pele::diagram::class::members::{ClassMember, Classifier, MemberType, Visibility};
use vibevalley_pele::diagram::class::parser::parse_class_diagram;
use vibevalley_pele::diagram::class::types::{LineType, RelationEnd, RelationType};
use vibevalley_pele::diagram::common::parse_generic_types;
use vibevalley_pele::util::chars::is_space_char;
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{
    ErrorCode, LinkInfo, METRICS_MEASURER, MathSvg, MonospacePart, ParseOptions, ParsedModel, RenderOptions, detect_type, parse, render, supports,
};

use crate::support::{
    Lcg, Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture,
    resolved_options,
};

fn parse_class(src: &str) -> ClassDb {
    let mut db = ClassDb::new();
    parse_class_diagram(src, &mut db, None).unwrap();
    db
}

fn draw_css(body: &str, extra: RenderOptions<'_>) -> String {
    render(&format!("classDiagram\n{body}"), &extra).unwrap().svg
}

fn draw_default_css(body: &str) -> String {
    draw_css(body, css_options())
}

fn class_config(entries: Vec<(&str, YamlValue)>) -> DiagramConfig {
    let mut section = IndexMap::new();
    for (k, v) in entries {
        section.insert(k.to_string(), v);
    }
    let mut cfg = DiagramConfig::default();
    cfg.sections.insert("class".to_string(), section);
    cfg
}

fn count_str(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

fn group(svg: &str, id: &str) -> String {
    let needle = format!(r#"data-id="{id}""#);
    let start = svg.find(&needle).unwrap_or_else(|| panic!("group {id} not found in svg"));
    let from = svg[..start].rfind("<g").unwrap();
    let re = Regex::new(r"<(/?)g\b").unwrap();
    let mut depth = 0i32;
    for cap in re.captures_iter(&svg[from..]) {
        let m = cap.get(0).unwrap();
        if cap.get(1).unwrap().as_str().is_empty() {
            depth += 1;
        } else {
            depth -= 1;
        }
        if depth == 0 {
            return svg[from..from + m.start()].to_string();
        }
    }
    svg[from..].to_string()
}

fn translate(svg: &str, id: &str) -> (f64, f64) {
    let g = group(svg, id);
    let re = Regex::new(r#"transform="translate\(([-\d.]+),([-\d.]+)\)""#).unwrap();
    let cap = re.captures(&g).unwrap_or_else(|| panic!("no translate on group {id}: {g}"));
    (cap[1].parse().unwrap(), cap[2].parse().unwrap())
}

fn assert_close(a: f64, b: f64, tol: f64, ctx: &str) {
    assert!((a - b).abs() <= tol, "{ctx}: {a} vs {b} (tol={tol})");
}

fn trim_js(s: &str) -> &str {
    s.trim_matches(is_space_char)
}

#[derive(Debug, PartialEq, Eq)]
struct OracleMethod {
    visibility: String,
    id: String,
    parameters: String,
    classifier: String,
    return_type: String,
}

fn mermaid_method_oracle(re: &Regex, input: &str) -> Option<OracleMethod> {
    let cap = re.captures(input)?;
    let visibility = cap.get(1).map_or("", |m| trim_js(m.as_str())).to_string();
    let id_raw = cap.get(2).map_or("", |m| m.as_str());
    let parameters = cap.get(3).map_or("", |m| trim_js(m.as_str())).to_string();
    let mut classifier = cap.get(4).map_or("", |m| trim_js(m.as_str())).to_string();
    let mut return_type = cap.get(5).map_or("", |m| trim_js(m.as_str())).to_string();
    if classifier.is_empty()
        && let Some(last) = return_type.chars().next_back()
        && matches!(last, '$' | '*')
    {
        classifier = last.to_string();
        return_type.pop();
    }
    let id = if id_raw.starts_with(' ') {
        format!(" {}", trim_js(id_raw))
    } else {
        trim_js(id_raw).to_string()
    };
    Some(OracleMethod {
        visibility,
        id,
        parameters,
        classifier,
        return_type,
    })
}

fn mermaid_generics_oracle(input: &str) -> String {
    let count = |text: &str| text.bytes().filter(|&b| b == b'~').count();
    let process_set = |mut set: &str| -> String {
        let tildes = count(set);
        let mut leading = false;
        if tildes <= 1 {
            return set.to_string();
        }
        if !tildes.is_multiple_of(2) && set.starts_with('~') {
            set = &set[1..];
            leading = true;
        }
        let mut chars: Vec<char> = set.chars().collect();
        loop {
            let first = chars.iter().position(|&c| c == '~');
            let last = chars.iter().rposition(|&c| c == '~');
            match (first, last) {
                (Some(f), Some(l)) if f != l => {
                    chars[f] = '<';
                    chars[l] = '>';
                }
                _ => break,
            }
        }
        let mut out = String::new();
        if leading {
            out.push('~');
        }
        for c in chars {
            out.push(c);
        }
        out
    };
    let mut sets: Vec<&str> = Vec::new();
    let mut start = 0;
    for (idx, _) in input.match_indices(',') {
        sets.push(&input[start..idx]);
        sets.push(",");
        start = idx + 1;
    }
    sets.push(&input[start..]);

    let mut output: Vec<String> = Vec::new();
    let mut i = 0;
    while i < sets.len() {
        let set = sets[i];
        if set == "," && i > 0 && i + 1 < sets.len() && count(sets[i - 1]) == 1 && count(sets[i + 1]) == 1 {
            let combined = format!("{},{}", sets[i - 1], sets[i + 1]);
            output.pop();
            output.push(process_set(&combined));
            i += 2;
            continue;
        }
        output.push(process_set(set));
        i += 1;
    }
    output.concat()
}

fn random_text(rng: &mut Lcg, pieces: &[&str], max: usize) -> String {
    let n = 1 + rng.next_usize(max);
    let mut out = String::new();
    for _ in 0..n {
        out.push_str(pieces[rng.next_usize(pieces.len())]);
    }
    out
}

#[test]
fn class_members_method_and_generics_fuzz_and_unit() {
    // JS `.` excludes \n, \r, \u2028, \u2029; match exact Mermaid METHOD regex semantics.
    let method_re = Regex::new(r"([#+~-])?([^\n\r\u{2028}\u{2029}]+)\(([^\n\r\u{2028}\u{2029}]*)\)([\s$*])?([^\n\r\u{2028}\u{2029}]*)([$*])?").unwrap();
    let pieces = [
        "(", ")", "()", "+", "-", "#", "~", "$", "*", " ", "  ", ":", ",", "a", "foo", "int", "List", "\r", "\n", "\u{2028}", "\t", "é",
    ];
    let mut rng = Lcg::new(11);
    let mut matched = 0usize;
    for _ in 0..40_000 {
        let input = random_text(&mut rng, &pieces, 9);
        let expected = mermaid_method_oracle(&method_re, &input);
        let member = ClassMember::parse(&input, MemberType::Method);
        match expected {
            None => assert_eq!(member.member_type, MemberType::Attribute, "input={input:?}"),
            Some(exp) => {
                matched += 1;
                let actual = OracleMethod {
                    visibility: member.visibility.as_str().to_string(),
                    id: member.id,
                    parameters: member.parameters,
                    classifier: member.classifier.as_str().to_string(),
                    return_type: member.return_type,
                };
                assert_eq!(actual, exp, "input={input:?}");
            }
        }
    }
    assert!(matched > 5000, "matched={matched}");

    let mut rng = Lcg::new(5);
    let generic_pieces = ["~", "~", ",", ", ", "a", "List", "K", " ", "<", ">", "~T~", "(", ")"];
    for _ in 0..40_000 {
        let input = random_text(&mut rng, &generic_pieces, 12);
        assert_eq!(parse_generic_types(&input), mermaid_generics_oracle(&input), "input={input:?}");
    }

    for input in ["run)", "(a)", "+x)", ")(", "a)b"] {
        let member = ClassMember::parse(input, MemberType::Method);
        assert_eq!(member.member_type, MemberType::Attribute);
        assert_eq!(member.get_display_details().display_text, input);
    }

    let member = ClassMember::parse("-List~int~ items$", MemberType::Attribute);
    assert_eq!(member.visibility, Visibility::Private);
    assert_eq!(member.classifier, Classifier::Static);
    let details = member.get_display_details();
    assert_eq!(details.display_text, "-List<int> items");
    assert_eq!(details.css_style, "text-decoration:underline;");
    assert_eq!(ClassMember::parse("", MemberType::Attribute).get_display_details().display_text, "");
}

#[test]
fn class_parser_unit_tests() {
    let db = parse_class(
        "classDiagram
          direction TB
          class Student {
            -idCard : IdCard
          }
          class IdCard{
            -id : int
            -name : string
          }
          class Bike{
            -id : int
            -name : string
          }
          Student \"1\" --o \"1\" IdCard : carries
          Student \"1\" --o \"1\" Bike : rides",
    );
    assert_eq!(db.direction, "TB");
    let student = db.classes.get("Student").unwrap();
    assert_eq!(student.id, "Student");
    assert_eq!(student.label, "Student");
    assert_eq!(student.generic_type, "");
    assert!(student.methods.is_empty());
    assert!(student.annotations.is_empty());
    assert_eq!(student.css_classes, "default");
    assert!(student.styles.is_empty());
    assert_eq!(student.members.len(), 1);
    assert_eq!(student.members[0].id, "idCard : IdCard");
    assert_eq!(student.members[0].visibility, Visibility::Private);
    assert_eq!(student.members[0].classifier, Classifier::None);
    assert_eq!(student.members[0].member_type, MemberType::Attribute);
    assert_eq!(db.relations.len(), 2);
    assert_eq!(db.relations[0].id1, "Student");
    assert_eq!(db.relations[0].id2, "IdCard");
    assert_eq!(db.relations[0].relation.line_type, LineType::Line);
    assert_eq!(db.relations[0].relation.type1, RelationEnd::None);
    assert_eq!(db.relations[0].relation.type2, RelationEnd::Type(RelationType::Aggregation));
    assert_eq!(db.relations[0].relation_title1, "1");
    assert_eq!(db.relations[0].relation_title2, "1");
    assert_eq!(db.relations[0].title.as_deref(), Some("carries"));
    assert_eq!(db.relations[1].id2, "Bike");
    assert_eq!(db.relations[1].title.as_deref(), Some("rides"));

    // Public parse function + front-matter title.
    let parsed = parse("---\ntitle: Animals\n---\nclassDiagram-v2\n  Animal <|-- Duck", &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Class);
    match parsed.model {
        ParsedModel::Class(model) => {
            assert_eq!(model.title.as_deref(), Some("Animals"));
            let keys: Vec<&str> = model.classes.keys().map(String::as_str).collect();
            assert_eq!(keys, vec!["Animal", "Duck"]);
        }
        other => panic!("expected Class model, got {:?}", other.diagram_type()),
    }

    // Annotation for undeclared class.
    let db = parse_class("classDiagram\n<<interface>> Shape\nclass Shape {\n  draw()\n}");
    assert_eq!(db.classes.get("Shape").unwrap().annotations, vec!["interface"]);
    assert_eq!(db.classes.get("Shape").unwrap().methods.len(), 1);

    // Annotation written as a member.
    let db = parse_class("classDiagram\nclass Shape {\n  <<interface>>\n  draw()\n}\nColor : <<enumeration>>");
    assert_eq!(db.classes.get("Shape").unwrap().annotations, vec!["interface"]);
    assert_eq!(db.classes.get("Color").unwrap().annotations, vec!["enumeration"]);

    // Whole-word classDef matching.
    let db = parse_class("classDiagram\nclass A:::defined\nclass B\nclassDef def fill:#f00\nclassDef defined fill:#0f0");
    assert_eq!(db.classes.get("A").unwrap().styles, vec!["fill:#0f0"]);
    assert!(db.classes.get("B").unwrap().styles.is_empty());

    // Default classDef applies to classes declared before it.
    let db = parse_class("classDiagram\nclass A\nclassDef default fill:#f00,stroke:#000\nclass B");
    assert_eq!(db.classes.get("A").unwrap().styles, vec!["fill:#f00", "stroke:#000"]);
    assert!(db.classes.get("B").unwrap().styles.is_empty());
    assert_eq!(db.style_classes.get("default").unwrap().styles, vec!["fill:#f00,stroke:#000"]);

    // Digit-prefixed ID ignored by cssClass and link.
    let db = parse_class("classDiagram\nclass 1A\nclass B\ncssClass \"1A,B\" hot\nlink 1A \"https://example.com\"");
    assert_eq!(db.classes.get("1A").unwrap().css_classes, "default");
    assert!(db.classes.get("1A").unwrap().link.is_none());
    assert_eq!(db.classes.get("B").unwrap().css_classes, "default hot");

    // Lollipop ends become interfaces.
    let db = parse_class("classDiagram\nbar ()-- foo\nfoo --() baz\nA ()--() B");
    assert_eq!(db.interfaces.len(), 2);
    assert_eq!(db.interfaces[0].id, "interface0");
    assert_eq!(db.interfaces[0].label, "bar");
    assert_eq!(db.interfaces[0].class_id, "foo");
    assert_eq!(db.interfaces[1].id, "interface1");
    assert_eq!(db.interfaces[1].label, "baz");
    assert_eq!(db.interfaces[1].class_id, "foo");
    let cls_keys: Vec<&str> = db.classes.keys().map(String::as_str).collect();
    assert_eq!(cls_keys, vec!["foo", "A", "B"]);
    let rel_pairs: Vec<(&str, &str)> = db.relations.iter().map(|r| (r.id1.as_str(), r.id2.as_str())).collect();
    assert_eq!(rel_pairs, vec![("interface0", "foo"), ("foo", "interface1"), ("A", "B")]);

    // Colliding ids across interfaces, notes, classes, namespaces.
    let db = parse_class("classDiagram\nclass interface0\nclass note0\nbar ()-- interface0\nnote for note0 \"n\"\nnamespace note0 {\n class X\n}");
    let graph = build_class_graph(&db, true);
    let edge_shapes: Vec<(NodeShape, NodeShape)> = graph
        .edges
        .iter()
        .map(|e| (graph.nodes[e.source as usize].shape, graph.nodes[e.target as usize].shape))
        .collect();
    assert_eq!(
        edge_shapes,
        vec![(NodeShape::Note, NodeShape::ClassBox), (NodeShape::Interface, NodeShape::ClassBox)]
    );
    let x_idx = graph.nodes.iter().position(|n| n.id == "X").unwrap();
    let group_idx = graph.nodes.iter().position(|n| n.is_group).unwrap();
    assert_eq!(graph.nodes[x_idx].parent, group_idx as i32);

    // Callback marks clickable without retaining callback payload.
    let db = parse_class("classDiagram\nclass A\nclick A call alert(\"x\") \"tip\"\ncallback A \"alert\"");
    let node = db.classes.get("A").unwrap();
    assert!(node.have_callback);
    assert_eq!(node.css_classes, "default clickable clickable");
    assert_eq!(node.tooltip.as_deref(), Some("tip"));
    assert!(!format!("{node:?}").contains("alert"));

    // Link sanitization.
    let db = parse_class("classDiagram\nclass A\nclass B\nlink A \"javascript:alert(1)\"\nclick B href \"https://example.com/a b\" \"tip\" _self");
    assert_eq!(db.classes.get("A").unwrap().link.as_deref(), Some("about:blank"));
    assert_eq!(db.classes.get("A").unwrap().link_target.as_deref(), Some("_blank"));
    assert_eq!(db.classes.get("B").unwrap().link.as_deref(), Some("https://example.com/a%20b"));
    assert_eq!(db.classes.get("B").unwrap().link_target.as_deref(), Some("_self"));

    // Nested & dotted namespaces.
    let db = parse_class("classDiagram\nnamespace A.B {\n class X\n}\nnamespace A {\n namespace C[\"See\"] {\n  class Y\n  note \"n\"\n }\n}");
    let ns_keys: Vec<&str> = db.namespaces.keys().map(String::as_str).collect();
    assert_eq!(ns_keys, vec!["A", "A.B", "A.C"]);
    let ac = db.namespaces.get("A.C").unwrap();
    assert_eq!(ac.label, "See");
    assert_eq!(ac.parent.as_deref(), Some("A"));
    assert!(ac.explicit);
    let a_children: Vec<&str> = db.namespaces.get("A").unwrap().children.iter().map(String::as_str).collect();
    assert_eq!(a_children, vec!["A.B", "A.C"]);
    assert_eq!(db.classes.get("Y").unwrap().parent.as_deref(), Some("A.C"));
    assert_eq!(db.notes.get("note0").unwrap().parent.as_deref(), Some("A.C"));

    // Headerless statements.
    let db = parse_class("B <|-- A~");
    let keys: Vec<&str> = db.classes.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["B", "A"]);
    let mut db = ClassDb::new();
    assert!(parse_class_diagram("class A", &mut db, None).is_err());

    // Exact Mermaid syntax error formatting.
    let err_of = |s: &str| {
        let mut db = ClassDb::new();
        parse_class_diagram(s, &mut db, None).unwrap_err()
    };
    let e1 = err_of("classDiagram\nnote link");
    assert_eq!(e1.code, ErrorCode::Syntax);
    assert!(
        e1.message.contains("Parse error on line 2:\nnote link\n-----^\nExpecting 'STR', got 'LINK'"),
        "msg={}",
        e1.message
    );
    assert!(err_of("classDiagram\nclass A { x").message.contains("got 'EOF_IN_STRUCT'"));
    assert!(
        err_of("classDiagram\nclass A\n@")
            .message
            .contains("Lexical error on line 3. Unrecognized text.")
    );
    assert!(err_of("classDiagram\n").code == ErrorCode::Syntax);
    assert!(
        err_of("classDiagram\nnamespace N {\n}")
            .message
            .contains("Expecting 'NAMESPACE', 'CLASS', 'NOTE_FOR', 'NOTE', got 'STRUCT_STOP'")
    );
}

#[test]
fn class_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("class-corpus.json");
    let re_bad = Regex::new(r"(?i)<script|<style|<foreignObject|\son\w+=|javascript:").unwrap();
    let mut rendered = 0usize;
    for src in &corpus {
        let Ok(css_res) = render(src, &css_options()) else {
            continue;
        };
        rendered += 1;
        let where_ctx: String = src.chars().take(120).collect();
        assert_inert(&css_res.svg, &where_ctx);
        assert!(!re_bad.is_match(&css_res.svg), "{where_ctx}: unsafe markup");
        assert!(!css_res.svg.contains("NaN"), "{where_ctx}: NaN");
        assert!(!css_res.svg.contains("undefined"), "{where_ctx}: undefined");
        assert_eq!(render(src, &css_options()).unwrap().svg, css_res.svg, "determinism");

        let res = render(src, &resolved_options()).expect("resolved mode failed where css succeeded");
        assert_inert_resolved(&res.svg, &where_ctx);
        assert_resvg_parses(&res.svg, &where_ctx);

        let dark = render(src, &dark_options()).expect("dark mode failed where css succeeded");
        assert_inert_resolved(&dark.svg, &where_ctx);
        assert_resvg_parses(&dark.svg, &where_ctx);
    }
    assert!(rendered > 70, "expected >70 rendered class samples, got {rendered}");
}

#[test]
fn class_render_layout_wrapping_boxes_members_annotations_and_monospace() {
    // Wraps disconnected class groups at maxWidth while keeping each relationship intact.
    let body = "classA <|-- classB\nclassC *-- classD\nclassE o-- classF\nclassG <-- classH\nclassI -- classJ\nclassK <.. classL\nclassM <|.. classN\nclassO .. classP";
    for dir in ["TB", "BT", "LR", "RL"] {
        let source = format!("classDiagram\ndirection {dir}\n{body}");
        let natural = render(
            &source,
            &RenderOptions {
                auto_direction: Some(false),
                ..css_options()
            },
        )
        .unwrap();
        for max_w in [320.0, 600.0] {
            let narrow = render(
                &source,
                &RenderOptions {
                    max_width: Some(max_w),
                    auto_direction: Some(false),
                    ..css_options()
                },
            )
            .unwrap();
            if natural.width <= max_w {
                assert_eq!(narrow.svg, natural.svg);
                continue;
            }
            assert!(narrow.width <= max_w, "dir={dir} max_w={max_w} width={}", narrow.width);
            assert!(narrow.height > natural.height);
            assert_eq!(count_str(&narrow.svg, r#"class="pele-node pele-class"#), 16);
            assert_eq!(count_str(&narrow.svg, r#"class="pele-edge pele-relation"#), 8);
            for (a, b) in [("A", "B"), ("C", "D"), ("E", "F"), ("G", "H"), ("I", "J"), ("K", "L"), ("M", "N"), ("O", "P")] {
                let from = translate(&narrow.svg, &format!("class{a}"));
                let to = translate(&narrow.svg, &format!("class{b}"));
                let old_from = translate(&natural.svg, &format!("class{a}"));
                let old_to = translate(&natural.svg, &format!("class{b}"));
                assert_close(to.0 - from.0, old_to.0 - old_from.0, 0.05, "dx preserved");
                assert_close(to.1 - from.1, old_to.1 - old_from.1, 0.05, "dy preserved");
            }
            assert_well_formed(&narrow.svg).unwrap();
            let again = render(
                &source,
                &RenderOptions {
                    max_width: Some(max_w),
                    auto_direction: Some(false),
                    ..css_options()
                },
            )
            .unwrap();
            assert_eq!(again.svg, narrow.svg);
        }
        let exact = render(
            &source,
            &RenderOptions {
                max_width: Some(natural.width),
                auto_direction: Some(false),
                ..css_options()
            },
        )
        .unwrap();
        assert_eq!(exact.svg, natural.svg);
    }

    // Connected and already fitting diagrams stay unchanged.
    for body in [
        "A --> B\nB --> C\nC --> A : uses",
        "A --> B\nclass C",
        "namespace N {\nclass A\nclass B\n}\nA --> B : calls",
    ] {
        let natural = draw_default_css(body);
        for max_w in [0.0, -1.0, f64::NAN, f64::INFINITY, 5000.0] {
            let out = draw_css(
                body,
                RenderOptions {
                    max_width: Some(max_w),
                    ..css_options()
                },
            );
            assert_eq!(out, natural);
        }
        if body.starts_with("A --> B\nB --> C") || body.starts_with("namespace") {
            let out = draw_css(
                body,
                RenderOptions {
                    max_width: Some(1.0),
                    ..css_options()
                },
            );
            assert_eq!(out, natural);
        }
    }

    // Keeps layout when wrapping would not make it narrower.
    let fan = "note \"From Duck till Zebra\"\nAnimal <|-- Duck\nAnimal <|-- Fish\nAnimal <|-- Zebra\nAnimal <|-- Cat\nAnimal <|-- Dog";
    assert_eq!(
        draw_css(
            fan,
            RenderOptions {
                max_width: Some(320.0),
                ..css_options()
            },
        ),
        draw_default_css(fan)
    );

    // Moves namespaces, notes, relationship labels, and self-links with their class groups.
    let multi: String = (0..4)
        .map(|i| {
            format!("namespace N{i} {{\nclass A{i}\nclass B{i}\n}}\nA{i} \"one\" --> \"many\" B{i} : uses\nnote for A{i} \"check\"\nB{i} --> B{i} : retry")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let natural = draw_default_css(&multi);
    let narrow = draw_css(
        &multi,
        RenderOptions {
            max_width: Some(600.0),
            ..css_options()
        },
    );
    assert_ne!(narrow, natural);
    let vb_re = Regex::new(r#"viewBox="0 0 ([\d.]+)"#).unwrap();
    let vw: f64 = vb_re.captures(&narrow).unwrap()[1].parse().unwrap();
    assert!(vw <= 600.0);
    for token in ["pele-class", "pele-namespace", "pele-note", "pele-cardinality", "pele-marker"] {
        assert_eq!(count_str(&narrow, token), count_str(&natural, token), "token={token}");
    }
    assert!(!narrow.contains("NaN") && !narrow.contains("Infinity") && !narrow.contains("undefined"));
    assert_well_formed(&narrow).unwrap();

    // Detection and both keywords.
    for kw in ["classDiagram", "classDiagram-v2"] {
        let src = format!("{kw}\n  Animal <|-- Duck");
        assert_eq!(detect_type(&src), Some(DiagramType::Class));
        assert!(supports(&src));
        let res = render(&src, &css_options()).unwrap();
        assert_eq!(res.diagram_type, DiagramType::Class);
        assert!(res.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-class""#));
        assert!(res.svg.contains(&format!(r#"viewBox="0 0 {} {}""#, res.width, res.height)));
    }

    // CSS custom property theming, zero <style>, only var(--_*) or none on fill/stroke.
    let themed = draw_default_css("class A {\n +x\n}\nA --> B : uses\nnote for A \"n\"");
    for token in ["--pele-bg", "--pele-fg", "--pele-line", "--pele-surface", "--pele-border", "--pele-muted"] {
        assert!(themed.contains(&format!("var({token},")), "missing {token}");
    }
    assert!(!themed.contains("<style"));
    let var_re = Regex::new(r"^(?:none|var\(--_\w+\))$").unwrap();
    let doc = roxmltree::Document::parse(&themed).unwrap();
    for node in doc.descendants().filter(|n| n.is_element()) {
        for name in ["fill", "stroke"] {
            if let Some(val) = node.attribute(name) {
                assert!(var_re.is_match(val), "unexpected {name}={val}");
            }
        }
    }

    // Direction layout.
    let at_dir = |dir: &str| {
        let svg = draw_default_css(&format!("direction {dir}\nA <|-- B"));
        (translate(&svg, "A"), translate(&svg, "B"))
    };
    let (tb_a, tb_b) = at_dir("TB");
    assert!(tb_b.1 > tb_a.1);
    let (bt_a, bt_b) = at_dir("BT");
    assert!(bt_b.1 < bt_a.1);
    let (lr_a, lr_b) = at_dir("LR");
    assert!(lr_b.0 > lr_a.0);
    assert_eq!(lr_b.1, lr_a.1);
    let (rl_a, rl_b) = at_dir("RL");
    assert!(rl_b.0 < rl_a.0);

    // Box structure: title, dividers, attributes, methods.
    let svg = draw_default_css("class Duck {\n  +String beakColor\n  -int age\n  +swim()\n  +quack() bool\n}");
    let duck = group(&svg, "Duck");
    assert!(duck.contains(r#"class="pele-node pele-class""#));
    assert_eq!(count_str(&duck, "<rect"), 1);
    assert!(
        Regex::new(r#"<text class="pele-label" font-weight="var\(--_hw\)"[^>]*><tspan[^>]*>Duck</tspan>"#)
            .unwrap()
            .is_match(&duck)
    );
    let member_re = Regex::new(r#"<text class="pele-member pele-(attribute|method)"[^>]* y="([-\d.]+)">([^<]*)</text>"#).unwrap();
    let members: Vec<(String, f64, String)> = member_re
        .captures_iter(&duck)
        .map(|c| (c[1].to_string(), c[2].parse().unwrap(), c[3].to_string()))
        .collect();
    assert_eq!(
        members.iter().map(|(k, _, t)| (k.as_str(), t.as_str())).collect::<Vec<_>>(),
        vec![
            ("attribute", "+String beakColor"),
            ("attribute", "-int age"),
            ("method", "+swim()"),
            ("method", "+quack() : bool"),
        ]
    );
    let ys: Vec<f64> = members.iter().map(|(_, y, _)| *y).collect();
    let mut sorted_ys = ys.clone();
    sorted_ys.sort_by(f64::total_cmp);
    assert_eq!(ys, sorted_ys);
    let div_re = Regex::new(r#"d="M[-\d.]+,([-\d.]+)H[-\d.]+M[-\d.]+,([-\d.]+)H"#).unwrap();
    let divs = div_re.captures(&duck).unwrap();
    let d1: f64 = divs[1].parse().unwrap();
    let d2: f64 = divs[2].parse().unwrap();
    assert!(d1 < ys[0]);
    assert!(d2 > ys[1] && d2 < ys[2]);

    // Box width scales with longest line.
    let rect_w = Regex::new(r#"<rect[^>]* width="([\d.]+)""#).unwrap();
    let narrow_w: f64 = rect_w.captures(&group(&draw_default_css("class A {\n  +x\n}"), "A")).unwrap()[1]
        .parse()
        .unwrap();
    let wide_w: f64 = rect_w
        .captures(&group(
            &draw_default_css("class A {\n  +aVeryLongMethodName(withParameter: SomeType) ReturnType\n}"),
            "A",
        ))
        .unwrap()[1]
        .parse()
        .unwrap();
    assert!(wide_w > narrow_w + 200.0);

    // Static underline & abstract italic.
    let svg = draw_default_css("class A {\n  +count()$ int\n  +draw()*\n  +String name$\n  +plain\n}");
    assert!(svg.contains(r#"<text class="pele-member pele-method pele-static" style="text-decoration:underline""#));
    assert!(svg.contains(r#"<text class="pele-member pele-method pele-abstract" font-style="italic""#));
    assert!(svg.contains(r#"<text class="pele-member pele-attribute pele-static" style="text-decoration:underline""#));
    assert!(
        Regex::new(r#"<text class="pele-member pele-attribute" x="[-\d.]+" y="[-\d.]+">\+plain<"#)
            .unwrap()
            .is_match(&svg)
    );
    assert!(svg.contains(">+count() : int<"));
    assert!(svg.contains(">+draw()<"));

    // Generics angle brackets.
    let svg = draw_default_css("class Shape~T~ {\n  +List~int~ position\n  +get(List~List~T~~ x) Map~K, V~\n}\nclass Pair~K, V~");
    assert!(svg.contains(">Shape&lt;T&gt;<"));
    assert!(svg.contains(">Pair&lt;K, V&gt;<"));
    assert!(svg.contains(">+List&lt;int&gt; position<"));
    assert!(svg.contains(">+get(List&lt;List&lt;T&gt;&gt; x) : Map&lt;K, V&gt;<"));
    assert!(svg.contains(r#"data-id="Shape""#));

    // Member text without markup.
    let svg = draw_default_css("class A {\n  +__init__(self)\n  +op(a *b, c *d)\n  +x <b>bold</b>\n  +amp #38; #lt;tag#gt;\n}");
    assert!(svg.contains(">+__init__(self)<"));
    assert!(svg.contains(">+op(a *b, c *d)<"));
    assert!(svg.contains(">+x &lt;b&gt;bold&lt;/b&gt;<"));
    assert!(svg.contains(">+amp &amp; &lt;tag&gt;<"));

    // Annotations above title.
    let svg = draw_default_css("class Shape {\n  <<interface>>\n  draw()\n}\nclass Color\n<<enumeration>> Color\nclass S <<Service>>");
    let shape = group(&svg, "Shape");
    let ann_y: f64 = Regex::new(r#"<text class="pele-annotation"[^>]* y="([-\d.]+)"[^>]*>«interface»</text>"#)
        .unwrap()
        .captures(&shape)
        .unwrap()[1]
        .parse()
        .unwrap();
    let title_y: f64 = Regex::new(r#"<tspan x="0" y="([-\d.]+)"[^>]*>Shape<"#).unwrap().captures(&shape).unwrap()[1]
        .parse()
        .unwrap();
    assert!(ann_y < title_y);
    assert!(group(&svg, "Color").contains("«enumeration»"));
    assert!(group(&svg, "S").contains("«Service»"));
    assert!(!shape.contains("&lt;&lt;"));

    // hideEmptyMembersBox.
    let rect_h = Regex::new(r#"<rect[^>]* height="([\d.]+)""#).unwrap();
    let shown = draw_default_css("class A");
    let hidden = render(
        "---\nconfig:\n  class:\n    hideEmptyMembersBox: true\n---\nclassDiagram\nclass A\nclass B {\n +x\n}",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(group(&shown, "A").contains("pele-divider"));
    assert!(!group(&hidden, "A").contains("pele-divider"));
    assert!(group(&hidden, "B").contains("pele-divider"));
    let h_shown: f64 = rect_h.captures(&group(&shown, "A")).unwrap()[1].parse().unwrap();
    let h_hidden: f64 = rect_h.captures(&group(&hidden, "A")).unwrap()[1].parse().unwrap();
    assert!(h_hidden < h_shown);
    let hidden_opt = draw_css(
        "class A",
        RenderOptions {
            config: Some(class_config(vec![("hideEmptyMembersBox", YamlValue::Bool(true))])),
            ..css_options()
        },
    );
    assert!(!hidden_opt.contains("pele-divider"));

    // Monospace members + font-family override.
    let plain = draw_default_css("class A {\n  +title: string\n}");
    let mono = draw_css(
        "class A {\n  +title: string\n}",
        RenderOptions {
            monospace: vec![MonospacePart::Members],
            ..css_options()
        },
    );
    assert!(mono.contains(r#"<g class="pele-members" font-size="14" font-family="var(--_fm)">"#));
    assert!(!plain.contains(r#"font-family="var(--_fm)""#));
    let w_plain: f64 = rect_w.captures(&group(&plain, "A")).unwrap()[1].parse().unwrap();
    let w_mono: f64 = rect_w.captures(&group(&mono, "A")).unwrap()[1].parse().unwrap();
    assert!(w_mono > w_plain);

    let other_mono = draw_css(
        "class A {\n  +title: string\n}",
        RenderOptions {
            monospace: vec![MonospacePart::Attributes],
            ..css_options()
        },
    );
    assert_eq!(other_mono, plain);

    let members_re = Regex::new(r#"<g class="pele-members".*?</g>"#).unwrap();
    for rule in [
        "style A color:black,font-family:serif",
        "classDef serif color:black,font-family:serif\nclass A:::serif",
    ] {
        let src = format!("class A {{\n  +title: string\n}}\nclass B {{\n  +title: string\n}}\n{rule}");
        let svg_mono = draw_css(
            &src,
            RenderOptions {
                monospace: vec![MonospacePart::Members],
                ..css_options()
            },
        );
        let svg_plain = draw_default_css(&src);
        assert_eq!(
            members_re.find(&group(&svg_mono, "A")).unwrap().as_str(),
            members_re.find(&group(&svg_plain, "A")).unwrap().as_str()
        );
        assert!(group(&svg_mono, "B").contains(r#"font-family="var(--_fm)""#));
    }

    // Class labels & backtick names.
    let svg = draw_default_css("class A[\"A class with a label\"]\nclass `Animal Class!`\nA --> `Animal Class!`");
    assert!(group(&svg, "A").contains(">A class with a label<"));
    assert!(svg.contains(r#"data-id="Animal Class!""#));
    assert!(svg.contains(">Animal Class!<"));
}

#[test]
fn class_render_relations_markers_cardinalities_loops_notes_namespaces_styles_links_and_math() {
    // All relation ends.
    let marker_re = Regex::new(r#"<(path|circle) class="pele-marker"([^>]*)>"#).unwrap();
    let markers_of = |relation: &str| -> Vec<String> {
        let edge = group(&draw_default_css(&format!("A {relation} B")), "id_A_B_1");
        marker_re
            .captures_iter(&edge)
            .map(|c| {
                let tag = &c[1];
                let attrs = &c[2];
                if attrs.contains(r#" fill="var(--_l)""#) {
                    format!("{tag} filled")
                } else {
                    tag.to_string()
                }
            })
            .collect()
    };
    assert_eq!(markers_of("--"), Vec::<String>::new());
    assert_eq!(markers_of(".."), Vec::<String>::new());
    assert_eq!(markers_of("<|--"), vec!["path"]);
    assert_eq!(markers_of("--|>"), vec!["path"]);
    assert_eq!(markers_of("*--"), vec!["path filled"]);
    assert_eq!(markers_of("--*"), vec!["path filled"]);
    assert_eq!(markers_of("o--"), vec!["path"]);
    assert_eq!(markers_of("-->"), vec!["path filled"]);
    assert_eq!(markers_of("<--"), vec!["path filled"]);
    assert_eq!(markers_of("..>"), vec!["path filled"]);
    assert_eq!(markers_of("..|>"), vec!["path"]);
    assert_eq!(markers_of("<|--|>"), vec!["path", "path"]);
    assert_eq!(markers_of("*--o"), vec!["path filled", "path"]);
    assert_eq!(markers_of("<-->"), vec!["path filled", "path filled"]);
    assert_eq!(markers_of("()--()"), vec!["circle", "circle"]);

    // Marker outline corner counts.
    let marker_d = Regex::new(r#"<path class="pele-marker" d="([^"]+)""#).unwrap();
    let corners = |rel: &str| -> usize {
        let edge = group(&draw_default_css(&format!("A {rel} B")), "id_A_B_1");
        count_str(&marker_d.captures(&edge).unwrap()[1], "L") + 1
    };
    assert_eq!(corners("--|>"), 3);
    assert_eq!(corners("--*"), 4);
    assert_eq!(corners("--o"), 4);
    assert_eq!(corners("-->"), 3);

    // Marker tip points into target class.
    let svg = draw_default_css("Animal <|-- Duck");
    let edge = group(&svg, "id_Animal_Duck_1");
    let tip = Regex::new(r#"<path class="pele-marker" d="M([-\d.]+),([-\d.]+)L"#)
        .unwrap()
        .captures(&edge)
        .unwrap();
    let (ax, ay) = translate(&svg, "Animal");
    let (_, dy) = translate(&svg, "Duck");
    let half = Regex::new(r#"<rect[^>]* height="([\d.]+)""#).unwrap().captures(&group(&svg, "Animal")).unwrap()[1]
        .parse::<f64>()
        .unwrap()
        / 2.0;
    assert_close(tip[1].parse().unwrap(), ax, 0.1, "tip x");
    assert_close(tip[2].parse().unwrap(), ay + half, 0.1, "tip y");
    assert!(dy > ay);

    // Line stops at the back of each marker.
    let ends_re = Regex::new(r#"<path d="M[-\d.]+,([-\d.]+)[^"]*?([-\d.]+)""#).unwrap();
    let ends_of = |rel: &str| -> (f64, f64) {
        let edge = group(&draw_default_css(&format!("A {rel} B")), "id_A_B_1");
        let cap = ends_re.captures(&edge).unwrap();
        (cap[1].parse().unwrap(), cap[2].parse().unwrap())
    };
    let (plain_start, plain_end) = ends_of("--");
    assert_eq!(ends_of("--|>"), (plain_start, plain_end - 12.0));
    assert_eq!(ends_of("<|--"), (plain_start + 12.0, plain_end));
    assert_eq!(ends_of("*--o"), (plain_start + 16.0, plain_end - 16.0));
    assert_eq!(ends_of("()--()"), (plain_start + 10.0, plain_end - 10.0));

    // Dashed lines on dotted relations only.
    assert!(
        Regex::new(r#"<path d="[^"]+" stroke-dasharray="6 4"/>"#)
            .unwrap()
            .is_match(&group(&draw_default_css("A ..> B"), "id_A_B_1"))
    );
    assert!(!group(&draw_default_css("A --> B"), "id_A_B_1").contains("stroke-dasharray"));
    assert!(
        !Regex::new(r"pele-marker[^>]*stroke-dasharray")
            .unwrap()
            .is_match(&group(&draw_default_css("A ..|> B"), "id_A_B_1"))
    );

    // Relation labels & cardinalities.
    let svg = draw_default_css("Customer \"1\" --> \"0..*\" Ticket : buys");
    assert!(group(&svg, "id_Customer_Ticket_1").contains("pele-relation"));
    let label_slice = &svg[svg.find(r#"<g class="pele-edge-label""#).unwrap()..];
    assert!(label_slice.contains(">buys<"));
    let card_re = Regex::new(r#"<text class="pele-cardinality" x="([-\d.]+)" y="([-\d.]+)" text-anchor="middle">([^<]*)</text>"#).unwrap();
    let cards: Vec<(f64, f64, String)> = card_re
        .captures_iter(&svg)
        .map(|c| (c[1].parse().unwrap(), c[2].parse().unwrap(), c[3].to_string()))
        .collect();
    assert_eq!(cards.iter().map(|c| c.2.as_str()).collect::<Vec<_>>(), vec!["1", "0..*"]);
    let (_, customer_y) = translate(&svg, "Customer");
    let (_, ticket_y) = translate(&svg, "Ticket");
    let mid = (customer_y + ticket_y) / 2.0;
    assert!(cards[0].1 < mid && cards[0].1 > customer_y);
    assert!(cards[1].1 > mid && cards[1].1 < ticket_y);

    // Straight end beside cardinality text & bending side.
    let svg = draw_default_css("Hub \"1\" --> \"a\" A\nHub \"2\" --> \"b\" B");
    let card_x = |txt: &str| -> f64 { card_re.captures_iter(&svg).find(|c| &c[3] == txt).unwrap()[1].parse().unwrap() };
    let path_re = Regex::new(r#"<path d="M([-\d.]+),([-\d.]+)L([-\d.]+),([-\d.]+)C[^"]*L([-\d.]+),([-\d.]+)""#).unwrap();
    for (id, own, far) in [("id_Hub_A_1", "1", "a"), ("id_Hub_B_2", "2", "b")] {
        let g = group(&svg, id);
        let cap = path_re.captures(&g).unwrap();
        let d: Vec<f64> = (1..=6).map(|i| cap[i].parse().unwrap()).collect();
        assert_eq!(d[2], d[0]);
        assert!(d[3] - d[1] >= 20.0);
        let left = d[4] < d[0];
        assert_eq!(card_x(own) < d[0], left);
        assert_eq!(card_x(far) < d[4], !left);
    }

    // Spreads relations sharing a side.
    let svg = draw_default_css("Hub \"1\" --> \"a\" A\nHub \"2\" --> \"b\" B\nHub \"3\" --> \"c\" C");
    let start_x_re = Regex::new(r#"<path d="M([-\d.]+),"#).unwrap();
    let starts: Vec<f64> = [(1, "A"), (2, "B"), (3, "C")]
        .iter()
        .map(|(n, name)| start_x_re.captures(&group(&svg, &format!("id_Hub_{name}_{n}"))).unwrap()[1].parse().unwrap())
        .collect();
    assert_eq!(starts.iter().map(|v| v.to_bits()).collect::<HashSet<_>>().len(), 3);
    let mut sorted_starts = starts.clone();
    sorted_starts.sort_by(f64::total_cmp);
    assert_eq!(starts, sorted_starts);
    let card_pos: HashSet<String> = card_re.captures_iter(&svg).map(|c| format!("{},{}", &c[1], &c[2])).collect();
    assert_eq!(card_pos.len(), 6);

    // Self-loop.
    let svg = draw_default_css("class Node\nNode \"1\" --> \"0..1\" Node : next");
    let edge = group(&svg, "id_Node_Node_1");
    assert!(Regex::new(r#"<path d="M[-\d.]+,[-\d.]+C[^"]+"/>"#).unwrap().is_match(&edge));
    assert_eq!(count_str(&edge, "pele-marker"), 1);
    assert!(svg.contains(">next<"));
    assert_eq!(count_str(&svg, r#"pele-cardinality""#), 2);

    // Lollipop interface.
    let svg = draw_default_css("bar ()-- foo\nfoo --() baz");
    assert!(group(&svg, "interface0").contains("pele-interface"));
    assert!(group(&svg, "interface0").contains(">bar<"));
    assert!(group(&svg, "interface1").contains(">baz<"));
    assert!(!group(&svg, "interface0").contains("<rect"));
    assert_eq!(count_str(&group(&svg, "id_interface0_foo_1"), r#"<circle class="pele-marker""#), 1);
    assert_eq!(count_str(&group(&svg, "id_foo_interface1_2"), r#"<circle class="pele-marker""#), 1);
    assert_eq!(count_str(&svg, "pele-class"), 2);

    // Notes & dotted note edges.
    let svg = draw_default_css("class MyClass\nnote \"General<br>note\"\nnote for MyClass \"About **it**\"");
    assert!(group(&svg, "note0").contains("pele-note"));
    assert!(Regex::new(r">General</tspan><tspan[^>]*>note<").unwrap().is_match(&group(&svg, "note0")));
    assert!(group(&svg, "note1").contains(r#"<tspan font-weight="var(--_w)">it</tspan>"#));
    let edge = group(&svg, "edgeNote1");
    assert!(edge.contains("pele-note-edge"));
    assert!(edge.contains(r#"stroke-dasharray="2 4""#));
    assert!(!edge.contains("pele-marker"));
    assert!(!svg.contains(r#"data-id="edgeNote0""#));
    assert!(!draw_default_css("note for Missing \"x\"").contains("pele-edge"));

    // Nested namespaces.
    let svg = draw_default_css("namespace Outer {\n  class A\n  namespace Inner[\"In here\"] {\n    class B\n  }\n}\nclass C\nA --> B\nB --> C");
    let rect_box_re = Regex::new(r#"<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    let ns_box = |id: &str| -> (f64, f64, f64, f64) {
        let g = group(&svg, id);
        let c = rect_box_re.captures(&g).unwrap();
        let x: f64 = c[1].parse().unwrap();
        let y: f64 = c[2].parse().unwrap();
        let w: f64 = c[3].parse().unwrap();
        let h: f64 = c[4].parse().unwrap();
        (x, y, x + w, y + h)
    };
    let inside = |id: &str, b: (f64, f64, f64, f64)| -> bool {
        let (x, y) = translate(&svg, id);
        x > b.0 && x < b.2 && y > b.1 && y < b.3
    };
    let outer = ns_box("Outer");
    let inner = ns_box("Outer.Inner");
    assert!(group(&svg, "Outer").contains("pele-cluster pele-namespace"));
    assert!(group(&svg, "Outer").contains(">Outer<"));
    assert!(group(&svg, "Outer.Inner").contains(">In here<"));
    assert!(inner.0 > outer.0 && inner.1 > outer.1 && inner.2 < outer.2 && inner.3 < outer.3);
    assert!(inside("A", outer));
    assert!(!inside("A", inner));
    assert!(inside("B", inner));
    assert!(!inside("C", outer));
    assert!(svg.find("pele-clusters").unwrap() < svg.find("pele-nodes").unwrap());

    // Dotted namespaces hierarchical vs flat.
    let dotted = "namespace Company.Engineering {\n  class Dev\n}";
    let nested = draw_default_css(dotted);
    assert_eq!(count_str(&nested, "pele-namespace"), 2);
    assert!(group(&nested, "Company").contains(">Company<"));
    assert!(group(&nested, "Company.Engineering").contains(">Engineering<"));
    let flat = draw_css(
        dotted,
        RenderOptions {
            config: Some(class_config(vec![("hierarchicalNamespaces", YamlValue::Bool(false))])),
            ..css_options()
        },
    );
    assert_eq!(count_str(&flat, "pele-namespace"), 1);
    assert!(flat.contains(">Company.Engineering<"));

    // Lollipop interface inside class's namespace.
    let svg = draw_default_css("namespace N {\n  class A\n}\nbar ()-- A");
    let gn = group(&svg, "N");
    let c = rect_box_re.captures(&gn).unwrap();
    let nx: f64 = c[1].parse().unwrap();
    let ny: f64 = c[2].parse().unwrap();
    let nw: f64 = c[3].parse().unwrap();
    let nh: f64 = c[4].parse().unwrap();
    let (ix, iy) = translate(&svg, "interface0");
    assert!(ix > nx && ix < nx + nw && iy > ny && iy < ny + nh);

    // Links, targets, tooltips, callbacks.
    let res = render(
        "classDiagram\nclass A\nclass B\nclass C\nlink A \"https://example.com/a\" \"Tip A\"\nclick B href \"https://example.com/b\" _self\ncallback C \"fn\" \"Tip C\"",
        &css_options(),
    )
    .unwrap();
    assert!(
        Regex::new(r#"<a href="https://example\.com/a" target="_blank" rel="noopener"><title>Tip A</title><rect"#)
            .unwrap()
            .is_match(&group(&res.svg, "A"))
    );
    assert!(group(&res.svg, "B").contains(r#"<a href="https://example.com/b" target="_self" rel="noopener">"#));
    assert!(!group(&res.svg, "C").contains("<a "));
    assert!(group(&res.svg, "C").contains("<title>Tip C</title>"));
    assert!(group(&res.svg, "C").contains(r#"class="pele-node pele-class clickable""#));
    assert_eq!(
        res.links,
        vec![
            LinkInfo {
                id: "A".to_string(),
                href: "https://example.com/a".to_string(),
                internal: false,
            },
            LinkInfo {
                id: "B".to_string(),
                href: "https://example.com/b".to_string(),
                internal: false,
            },
        ]
    );

    // Styles, classDef, cssClass, ::: shorthand.
    let svg = draw_default_css(
        "class A\nclass B:::hot\nclass C\nclass D {\n +x$\n}\nclassDef default stroke:#00f\nstyle A fill:#f9f,stroke:#333,stroke-width:4px\nclassDef hot fill:#fdd,color:#900\nclassDef cold fill:#ddf\ncssClass \"C,D\" cold\nstyle D color:#090",
    );
    assert!(
        Regex::new(r#"<rect[^>]* style="rx:var\(--_r\);stroke:#333;fill:#f9f;stroke-width:4px;""#)
            .unwrap()
            .is_match(&group(&svg, "A"))
    );
    assert!(group(&svg, "A").contains(r#"<path class="pele-divider""#));
    assert!(Regex::new(r#"pele-divider"[^>]* style="stroke:#333""#).unwrap().is_match(&group(&svg, "A")));
    assert!(group(&svg, "B").contains(r#"class="pele-node pele-class hot""#));
    assert!(
        Regex::new(r#"<rect[^>]* style="rx:var\(--_r\);stroke:#00f;fill:#fdd;""#)
            .unwrap()
            .is_match(&group(&svg, "B"))
    );
    assert!(
        Regex::new(r#"<text class="pele-label" font-weight="var\(--_hw\)" style="fill:#900;""#)
            .unwrap()
            .is_match(&group(&svg, "B"))
    );
    assert!(group(&svg, "C").contains(r#"class="pele-node pele-class cold""#));
    assert!(
        Regex::new(r#"<rect[^>]* style="rx:var\(--_r\);stroke:#00f;fill:#ddf;""#)
            .unwrap()
            .is_match(&group(&svg, "C"))
    );
    assert!(group(&svg, "D").contains(r#"pele-static" style="fill:#090;text-decoration:underline""#));

    // Contrasting ink color on dark fills.
    let svg = draw_default_css(
        "class A {\n  <<interface>>\n  +id int\n  +run()\n}\nclass B {\n  +x\n}\nclass C\nclassDef dark fill:#1f3a5f\nclass A:::dark\nstyle B fill:lightyellow,color:#900",
    );
    let dark_attr = r#" fill="var(--pele-fg-on-dark,#fff)""#;
    let ga = group(&svg, "A");
    assert!(
        Regex::new(r#"<text class="pele-annotation"[^>]* fill="var\(--pele-fg-on-dark,#fff\)">«interface»<"#)
            .unwrap()
            .is_match(&ga)
    );
    assert!(ga.contains(&format!(r#"<text class="pele-label" font-weight="var(--_hw)"{dark_attr}"#)));
    assert!(
        Regex::new(r#"<g class="pele-members" font-size="\d+" fill="var\(--pele-fg-on-dark,#fff\)">"#)
            .unwrap()
            .is_match(&ga)
    );
    assert_eq!(count_str(&ga, dark_attr), 3);
    assert!(!group(&svg, "B").contains("--pele-fg-on"));
    assert!(group(&svg, "B").contains(r#"<text class="pele-label" font-weight="var(--_hw)" style="fill:#900;""#));
    assert!(!group(&svg, "C").contains("--pele-fg-on"));

    // Later of style and classDef wins.
    let fill_re = Regex::new(r#"<rect[^>]* style="rx:var\(--_r\);fill:([^;]+);""#).unwrap();
    let fill_of = |b: &str| fill_re.captures(&group(&draw_default_css(b), "A")).unwrap()[1].to_string();
    assert_eq!(fill_of("class A:::c\nclassDef c fill:#111\nstyle A fill:#222"), "#222");
    assert_eq!(fill_of("class A:::c\nstyle A fill:#222\nclassDef c fill:#111"), "#111");
    assert_eq!(fill_of("classDef c fill:#111\nclass A:::c\nstyle A fill:#222"), "#222");
    assert_eq!(fill_of("classDef c fill:#111\nclass A:::c"), "#111");

    // Accessible names.
    let svg = draw_default_css("accTitle: The title\naccDescr: The description\nclass A");
    assert!(svg.contains(r#"<title id="pele-title">The title</title>"#));
    assert!(svg.contains(r#"<desc id="pele-desc">The description</desc>"#));

    // All expected classes & data-ids.
    let svg = draw_default_css("namespace N {\n class A\n}\nA \"1\" --> \"2\" B : x\nnote for A \"n\"\nfoo ()-- B");
    for name in [
        "pele-clusters",
        "pele-edges",
        "pele-edge-labels",
        "pele-cardinalities",
        "pele-nodes",
        "pele-cluster-label",
        "pele-edge-label",
        "pele-label",
    ] {
        assert!(svg.contains(name), "missing {name}");
    }
    let id_re = Regex::new(r#"data-id="([^"]*)""#).unwrap();
    let ids: HashSet<String> = id_re.captures_iter(&svg).map(|c| c[1].to_string()).collect();
    let expected: HashSet<String> = ["N", "A", "B", "note0", "interface0", "edgeNote0", "id_A_B_1", "id_interface0_B_2"]
        .into_iter()
        .map(str::to_string)
        .collect();
    assert_eq!(ids, expected);

    // Every cardinality stays inside viewBox.
    for src in [
        "direction LR\nA \"one\" --> \"a long cardinality\" B",
        "A \"left\" --> \"right\" A",
        "Hub \"1\" --> \"many many\" A\nHub --> B",
        "direction RL\nA \"x\" <|-- \"y\" B\nA \"z\" --> \"w\" C",
    ] {
        let res = render(&format!("classDiagram\n{src}"), &css_options()).unwrap();
        for cap in card_re.captures_iter(&res.svg) {
            let x: f64 = cap[1].parse().unwrap();
            let y: f64 = cap[2].parse().unwrap();
            assert!(x > 0.0 && x < res.width, "x={x} width={}", res.width);
            assert!(y > 0.0 && y < res.height, "y={y} height={}", res.height);
        }
    }

    // Math typesetting in annotations, notes, cardinalities, edge labels, titles — not members.
    let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let math = |tex: &str, _size: f64| -> Option<MathSvg> {
        asked.borrow_mut().push(tex.to_string());
        Some(MathSvg {
            svg: format!(r#"<path d="M0,0H{}"/>"#, tex.len().max(1)),
            width: 30.0,
            height: 24.0,
        })
    };
    let math_res = render(
        "classDiagram\n  class A {\n    <<$$a$$>>\n    +$$m$$ int\n  }\n  note for A \"$$b$$\"\n  A \"$$c$$\" --> \"1\" B : $$d$$\n  class C[\"$$e$$\"]",
        &RenderOptions {
            math: Some(&math),
            ..resolved_options()
        },
    )
    .unwrap();
    let seen: HashSet<String> = asked.borrow().iter().cloned().collect();
    for expected_tex in ["a", "b", "c", "d", "e"] {
        assert!(seen.contains(expected_tex), "missing math tex {expected_tex}, saw {seen:?}");
    }
    assert!(!seen.contains("m"), "members must not typeset math");
    assert!(math_res.svg.contains("+$$m$$ int"));
    assert!(!math_res.svg.contains("<foreignObject"));
    assert!(!math_res.svg.contains("var(--"));
    assert!(!math_res.svg.contains("color-mix("));
    assert_well_formed(&math_res.svg).unwrap();
    assert_resvg_parses(&math_res.svg, "class math");
}

#[test]
fn class_security_hostile_payloads_options_urls_and_mutated_corpus() {
    let check = |src: &str, opts: &RenderOptions<'_>, resolved: bool| -> bool {
        match render(src, opts) {
            Ok(r) => {
                let ctx: String = src.chars().take(160).collect();
                if resolved {
                    assert_inert_resolved(&r.svg, &ctx);
                    assert_resvg_parses(&r.svg, &ctx);
                } else {
                    assert_inert(&r.svg, &ctx);
                }
                true
            }
            Err(_) => false,
        }
    };

    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("classDiagram\n  class {p}"),
        |p| format!("classDiagram\n  class `{p}`"),
        |p| format!("classDiagram\n  class A[\"{p}\"]"),
        |p| format!("classDiagram\n  class A~{p}~"),
        |p| format!("classDiagram\n  class A:::{p}"),
        |p| format!("classDiagram\n  class A <<{p}>>"),
        |p| format!("classDiagram\n  <<{p}>> A"),
        |p| format!("classDiagram\n  class A {{\n    {p}\n  }}"),
        |p| format!("classDiagram\n  class A {{\n    +{p}()\n    -{p} x$\n    #f({p}) {p}*\n    <<{p}>>\n  }}"),
        |p| format!("classDiagram\n  class A {{\n    +List~{p}~ x\n    +f(Map~{p}, {p}~ m) List~{p}~\n  }}"),
        |p| format!("classDiagram\n  A : {p}"),
        |p| format!("classDiagram\n  A : +{p}()"),
        |p| format!("classDiagram\n  {p} <|-- B"),
        |p| format!("classDiagram\n  `{p}` <|-- `{p}2`"),
        |p| format!("classDiagram\n  A <|-- B : {p}"),
        |p| format!("classDiagram\n  A \"{p}\" --> \"{p}\" B : {p}"),
        |p| format!("classDiagram\n  A \"{p}\" --> \"{p}\" A : {p}"),
        |p| format!("classDiagram\n  {p} ()-- A"),
        |p| format!("classDiagram\n  A --() `{p}`"),
        |p| format!("classDiagram\n  note \"{p}\""),
        |p| format!("classDiagram\n  class A\n  note for A \"{p}\""),
        |p| format!("classDiagram\n  note for `{p}` \"x\""),
        |p| format!("classDiagram\n  namespace {p} {{\n    class A\n  }}"),
        |p| format!("classDiagram\n  namespace `{p}` {{\n    class A\n  }}"),
        |p| format!("classDiagram\n  namespace N[\"{p}\"] {{\n    class A\n    note \"{p}\"\n  }}"),
        |p| format!("classDiagram\n  class A\n  link A \"{p}\""),
        |p| format!("classDiagram\n  class A\n  link A \"{p}\" \"{p}\" _blank"),
        |p| format!("classDiagram\n  class A\n  link A \"https://example.com\" {p}"),
        |p| format!("classDiagram\n  class A\n  click A href \"{p}\" \"{p}\""),
        |p| format!("classDiagram\n  class A\n  click A href \"x\" \"{p}\" _top"),
        |p| format!("classDiagram\n  class A\n  click A call {p}()"),
        |p| format!("classDiagram\n  class A\n  click A call f({p}) \"{p}\""),
        |p| format!("classDiagram\n  class A\n  callback A \"{p}\" \"{p}\""),
        |p| format!("classDiagram\n  class A\n  style A fill:{p}"),
        |p| format!("classDiagram\n  class A\n  style A {p}:red"),
        |p| format!("classDiagram\n  class A\n  style A color:{p},stroke:{p},font-family:{p},font-size:{p}"),
        |p| format!("classDiagram\n  class A\n  style {p} fill:red"),
        |p| format!("classDiagram\n  class A:::c\n  classDef c fill:{p},color:{p}"),
        |p| format!("classDiagram\n  class A {{\n +x$\n}}\n  classDef default color:{p},stroke:{p}"),
        |p| format!("classDiagram\n  class A\n  classDef {p} fill:red\n  cssClass \"A\" {p}"),
        |p| format!("classDiagram\n  class A\n  cssClass \"{p}\" c"),
        |p| format!("classDiagram\n  class A\n  cssClass \"A\" {p}"),
        |p| format!("classDiagram\n  accTitle: {p}\n  accDescr: {p}\n  class A"),
        |p| format!("classDiagram\n  accDescr {{\n {p}\n }}\n  class A"),
        |p| format!("classDiagram\n  direction {p}\n  class A"),
        |p| format!("classDiagram\n  %% {p}\n  class A"),
        |p| format!("classDiagram {p}\n  class A"),
        |p| {
            format!(
                "---\ntitle: \"{p}\"\nconfig:\n  class:\n    hideEmptyMembersBox: \"{p}\"\n    nodeSpacing: \"{p}\"\n    hierarchicalNamespaces: \"{p}\"\n---\nclassDiagram\n  class A"
            )
        },
        |p| format!("%%{{init: {{\"class\": {{\"rankSpacing\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nclassDiagram\n  A --> B"),
    ];

    let css = css_options();
    let res = resolved_options();
    let mut rendered = 0usize;
    for template in &templates {
        for &payload in PAYLOADS {
            let src1 = template(payload);
            if check(&src1, &css, false) {
                rendered += 1;
                assert!(check(&src1, &res, true));
            }
            let src2 = template(&payload.replace('"', "#quot;"));
            if check(&src2, &css, false) {
                rendered += 1;
                assert!(check(&src2, &res, true));
            }
        }
    }
    assert!(rendered > 1500, "rendered={rendered}");

    // Hostile options.
    for &payload in PAYLOADS {
        assert!(check(
            "classDiagram\n  accTitle: t\n  A \"1\" --> \"2\" B : x",
            &RenderOptions {
                id_prefix: Some(payload.to_string()),
                font_family: Some(payload.to_string()),
                ..css_options()
            },
            false,
        ));
        assert!(check(
            "classDiagram\n  A --> B",
            &RenderOptions {
                config: Some(class_config(vec![
                    ("nodeSpacing", YamlValue::String(payload.to_string())),
                    ("rankSpacing", YamlValue::String(payload.to_string())),
                ])),
                ..resolved_options()
            },
            true,
        ));
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 1e308] {
        assert!(check(
            "classDiagram\n  A \"1\" --> \"2\" B : x",
            &RenderOptions {
                config: Some(class_config(vec![
                    ("nodeSpacing", YamlValue::Number(value)),
                    ("rankSpacing", YamlValue::Number(value)),
                ])),
                ..resolved_options()
            },
            true,
        ));
    }

    // Never emits a script URL or callback payload.
    for url in [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        " javascript:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html,x",
        "vbscript:x",
        "&#106;avascript:alert(1)",
    ] {
        let out = render(&format!("classDiagram\n  class A\n  link A \"{url}\""), &css_options()).unwrap();
        assert!(!out.svg.contains("<a "), "url={url}");
        assert!(out.links.is_empty(), "url={url}");
    }
    let out = render(
        "classDiagram\n  class A\n  click A call stealCookies(\"now\") \"tip\"\n  callback A \"stealCookies\"",
        &css_options(),
    )
    .unwrap();
    assert!(!out.svg.contains("stealCookies"));
    assert!(!out.svg.contains("<a "));
    assert!(out.links.is_empty());

    // Mutated corpus inputs.
    let corpus = load_fixture("class-corpus.json");
    let mut fragments: Vec<&str> = PAYLOADS.to_vec();
    fragments.extend([
        "\"",
        "`",
        "~",
        "<<",
        ">>",
        ":::",
        "{",
        "}",
        "\n",
        " : ",
        "link A \"",
        "style A fill:",
        "note \"",
        "namespace N {\n",
        "classDef c ",
        "()--",
        "\"1\" ",
    ]);
    let mut mutator = Mutator::new(&corpus, fragments, 3);
    let mut fuzz_rendered = 0usize;
    for _ in 0..1500 {
        let sample = mutator.next_sample();
        if check(&sample, &css, false) {
            fuzz_rendered += 1;
            assert!(check(&sample, &res, true));
        }
    }
    assert!(fuzz_rendered > 150, "fuzz_rendered={fuzz_rendered}");
}

#[test]
fn class_stress_worst_cases_and_default_limit() {
    let n = 50_000usize;
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big_render = || RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let diagram = |body: String| format!("classDiagram\n{body}");
    let repeat_fn = |count: usize, f: fn(usize) -> String| -> String { (0..count).map(f).collect() };

    type StressCase<'a> = (&'static str, Box<dyn FnOnce() + Send + 'a>);
    let p = &big_parse;
    let cases: Vec<StressCase<'_>> = vec![
        (
            "long line mentioning direction",
            Box::new(move || {
                tokenize(&diagram(format!("A --> B {}direction XX", "A ".repeat(n / 2))));
            }),
        ),
        (
            "direction on every line",
            Box::new(move || {
                tokenize(&diagram("direction\n".repeat(n / 10)));
            }),
        ),
        (
            "direction followed by blank lines",
            Box::new(move || {
                tokenize(&diagram(format!("direction{}XX\nclass A", "\n ".repeat(n / 2))));
            }),
        ),
        (
            "many directions on one line",
            Box::new(move || {
                tokenize(&diagram("direction X ".repeat(n / 12)));
            }),
        ),
        (
            "one line of spaced words",
            Box::new(move || {
                tokenize(&diagram("a ".repeat(n / 2)));
            }),
        ),
        (
            "whitespace run with no line break",
            Box::new(move || {
                tokenize(&diagram(format!("class A{}x", " ".repeat(n))));
            }),
        ),
        (
            "blank lines between statements",
            Box::new(move || {
                let _ = parse(&diagram(repeat_fn(2000, |i| format!("class C{i}{}\n", "\n \t".repeat(8)))), p);
            }),
        ),
        (
            "accTitle with no colon",
            Box::new(move || {
                tokenize(&diagram("accTitle ".repeat(n / 9)));
            }),
        ),
        (
            "accDescr followed by spaces",
            Box::new(move || {
                tokenize(&diagram(format!("accDescr{}", " ".repeat(n))));
            }),
        ),
        (
            "unclosed accDescr block",
            Box::new(move || {
                let _ = parse(&diagram(format!("accDescr {{{}", "x\n".repeat(n / 2))), p);
            }),
        ),
        (
            "call followed by spaces",
            Box::new(move || {
                tokenize(&diagram(format!("click A call{}f()", " ".repeat(n))));
            }),
        ),
        (
            "callback args unclosed",
            Box::new(move || {
                let _ = parse(&diagram(format!("click A call f({}", "a,".repeat(n / 2))), p);
            }),
        ),
        (
            "empty call parens over spaces",
            Box::new(move || {
                tokenize(&diagram(format!("click A call f({}x)", " ".repeat(n))));
            }),
        ),
        (
            "unclosed string",
            Box::new(move || {
                let _ = parse(&diagram(format!("note \"{}", "x".repeat(n))), p);
            }),
        ),
        (
            "unclosed generic",
            Box::new(move || {
                let _ = parse(&diagram(format!("class A~{}", "T".repeat(n))), p);
            }),
        ),
        (
            "unclosed backtick name",
            Box::new(move || {
                let _ = parse(&diagram(format!("class `{}", "a".repeat(n))), p);
            }),
        ),
        (
            "label of colons",
            Box::new(move || {
                tokenize(&diagram(format!("A {}", ":".repeat(n))));
            }),
        ),
        (
            "label of semicolons and colons",
            Box::new(move || {
                tokenize(&diagram(format!("A {}", ":;".repeat(n / 2))));
            }),
        ),
        (
            "runs of dashes and dots",
            Box::new(move || {
                tokenize(&diagram(format!("A {}{} B", "-".repeat(n / 2), ".".repeat(n / 2))));
            }),
        ),
        (
            "runs of relation ends",
            Box::new(move || {
                tokenize(&diagram(format!("A {}{}", "<|".repeat(n / 4), "()".repeat(n / 4))));
            }),
        ),
        (
            "class name of 25k parts",
            Box::new(move || {
                let _ = parse(&diagram(format!("class {}B", "A.".repeat(n / 2))), p);
            }),
        ),
        (
            "class name of 25k words",
            Box::new(move || {
                let _ = parse(&diagram(format!("{}--> B", "A ".repeat(n / 2))), p);
            }),
        ),
        (
            "namespace name of 12k parts",
            Box::new(move || {
                let _ = parse(&diagram(format!("namespace {}b {{\nclass X\n}}", "a.".repeat(12_000))), p);
            }),
        ),
        (
            "namespace name of 3k parts rendered",
            Box::new(move || {
                let _ = render(&diagram(format!("namespace {}b {{\nclass X\n}}", "a.".repeat(3_000))), &big_render());
            }),
        ),
        (
            "4k nested namespaces",
            Box::new(move || {
                let _ = parse(&diagram(format!("{}class X\n{}", "namespace n {\n".repeat(4_000), "}\n".repeat(4_000))), p);
            }),
        ),
        (
            "2k nested namespaces rendered",
            Box::new(move || {
                let _ = render(
                    &diagram(format!(
                        "{}class X\n{}",
                        repeat_fn(2_000, |i| format!("namespace n{i} {{\n")),
                        "}\n".repeat(2_000)
                    )),
                    &big_render(),
                );
            }),
        ),
        (
            "unclosed nested namespaces",
            Box::new(move || {
                let _ = parse(&diagram(format!("{}class X\n", "namespace n {\n".repeat(4_000))), p);
            }),
        ),
        (
            "closing braces with nothing open",
            Box::new(move || {
                let _ = parse(&diagram(format!("namespace n {{\nclass X\n{}", "}".repeat(n))), p);
            }),
        ),
        (
            "namespace keyword repeated",
            Box::new(move || {
                let _ = parse(&diagram(format!("{}x {{\nclass X\n}}", "namespace ".repeat(n / 10))), p);
            }),
        ),
        (
            "5k sibling namespaces",
            Box::new(move || {
                let _ = render(&diagram(repeat_fn(5_000, |i| format!("namespace n{i} {{\nclass C{i}\n}}\n"))), &big_render());
            }),
        ),
        (
            "class with 10k members",
            Box::new(move || {
                let _ = render(
                    &diagram(format!("class A {{\n{}}}\n", repeat_fn(10_000, |i| format!("+m{i}()\n")))),
                    &big_render(),
                );
            }),
        ),
        (
            "member of opening parens",
            Box::new(move || {
                let _ = render(&diagram(format!("class A {{\n+a){}\n}}\n", "(".repeat(n))), &big_render());
            }),
        ),
        (
            "member of nested parens",
            Box::new(move || {
                let _ = render(&diagram(format!("class A {{\n{}\n}}\n", "(a)".repeat(n / 3))), &big_render());
            }),
        ),
        (
            "member of tildes",
            Box::new(move || {
                let _ = render(&diagram(format!("class A {{\n+x {}\n}}\n", "~".repeat(n))), &big_render());
            }),
        ),
        (
            "member of tildes and commas",
            Box::new(move || {
                let _ = render(&diagram(format!("class A {{\n+x({})\n}}\n", "~a,".repeat(n / 3))), &big_render());
            }),
        ),
        (
            "method parser parens and CR",
            Box::new(move || {
                let _ = ClassMember::parse(&format!("{}a(b)", "(\r".repeat(n / 2)), MemberType::Method);
            }),
        ),
        (
            "generic types of commas",
            Box::new(move || {
                let _ = parse_generic_types(&format!("~{}~", ",".repeat(n)));
            }),
        ),
        (
            "50k char member",
            Box::new(move || {
                let _ = render(&diagram(format!("class A {{\n+{}\n}}\n", "word ".repeat(n / 5))), &big_render());
            }),
        ),
        (
            "50k char note",
            Box::new(move || {
                let _ = render(&diagram(format!("note \"{}\"\n", "word ".repeat(n / 5))), &big_render());
            }),
        ),
        (
            "note of emphasis and breaks",
            Box::new(move || {
                let _ = render(&diagram(format!("note \"{}\"\n", "*a _b <br>".repeat(n / 10))), &big_render());
            }),
        ),
        (
            "label of entities",
            Box::new(move || {
                let _ = render(&diagram(format!("class A[\"{}\"]\n", "#35;&amp;".repeat(n / 9))), &big_render());
            }),
        ),
        (
            "5k classes",
            Box::new(move || {
                let _ = render(&diagram(repeat_fn(5_000, |i| format!("class C{i}\n"))), &big_render());
            }),
        ),
        (
            "chain of 4k",
            Box::new(move || {
                let _ = render(&diagram(repeat_fn(4_000, |i| format!("C{i} <|-- C{}\n", i + 1))), &big_render());
            }),
        ),
        (
            "star of 4k with cardinalities",
            Box::new(move || {
                let _ = render(&diagram(repeat_fn(4_000, |i| format!("Hub \"1\" --> \"{i}\" C{i}\n"))), &big_render());
            }),
        ),
        (
            "2k parallel and 2k self relations",
            Box::new(move || {
                let _ = render(
                    &diagram(format!(
                        "{}{}",
                        "A \"1\" --> \"2\" B : x\n".repeat(2_000),
                        "A \"1\" --> \"2\" A : y\n".repeat(2_000)
                    )),
                    &big_render(),
                );
            }),
        ),
        (
            "complete graph of 50",
            Box::new(move || {
                let mut s = String::new();
                for i in 0..50 {
                    for j in i + 1..50 {
                        s.push_str(&format!("C{i} --> C{j}\n"));
                    }
                }
                let _ = render(&diagram(s), &big_render());
            }),
        ),
        (
            "3k lollipop interfaces",
            Box::new(move || {
                let _ = render(&diagram(repeat_fn(3_000, |i| format!("i{i} ()-- A\n"))), &big_render());
            }),
        ),
        (
            "3k notes for one class",
            Box::new(move || {
                let _ = render(
                    &diagram(format!("class A\n{}", repeat_fn(3_000, |i| format!("note for A \"n{i}\"\n")))),
                    &big_render(),
                );
            }),
        ),
        (
            "style with 12k declarations",
            Box::new(move || {
                let _ = render(&diagram(format!("class A\nstyle A fill:#fff{}\n", ",stroke:#000".repeat(4_000))), &big_render());
            }),
        ),
        (
            "3k classDefs on 100 classes",
            Box::new(move || {
                let _ = render(
                    &diagram(format!(
                        "{}{}",
                        repeat_fn(100, |i| format!("class C{i}:::k\n")),
                        "classDef k fill:#fff\n".repeat(3_000)
                    )),
                    &big_render(),
                );
            }),
        ),
        (
            "1600 classDefs on 1600 classes",
            Box::new(move || {
                let _ = render(
                    &diagram(format!(
                        "{}{}",
                        repeat_fn(1_600, |i| format!("class C{i}:::k\n")),
                        "classDef k fill:#fff\n".repeat(1_600)
                    )),
                    &big_render(),
                );
            }),
        ),
        (
            "5k decl classDef on 800 classes",
            Box::new(move || {
                let _ = render(
                    &diagram(format!(
                        "{}classDef k x:y{}\n",
                        repeat_fn(800, |i| format!("class C{i}:::k\nstyle C{i} x:{i}\n")),
                        repeat_fn(5_000, |i| format!(",a{i}:b"))
                    )),
                    &big_render(),
                );
            }),
        ),
        (
            "cssClass with 12k ids",
            Box::new(move || {
                let _ = render(&diagram(format!("class A\ncssClass \"{}A\" k\n", "A,".repeat(12_000))), &big_render());
            }),
        ),
        (
            "link wrapped in entity encoding",
            Box::new(move || {
                let _ = render(&diagram(format!("class A\nlink A \"&{}x\"\n", "#38;".repeat(n / 4))), &big_render());
            }),
        ),
        (
            "4k annotation statements",
            Box::new(move || {
                let _ = render(&diagram("<<a>> A\n".repeat(4_000)), &big_render());
            }),
        ),
    ];

    let queue = std::sync::Mutex::new(cases);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                while let Some((name, run)) = queue.lock().unwrap().pop() {
                    let started = Instant::now();
                    run();
                    assert!(started.elapsed().as_millis() < 5_000, "stress case `{name}` took {:?}", started.elapsed());
                }
            });
        }
    });

    let err = render(&diagram("class A\n".repeat(10_000)), &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("limit of 50000"), "msg={}", err.message);
}

#[test]
fn class_grammar_tour_renders_valid_and_rejects_invalid_cleanly() {
    let names = [
        "A", "A.B", "A-B", "A B", "`a b`", "A`b`", "A~T~", "`a`~T~", "A.`b`~T~", "é", "1", "A.", ".A", "A~T~~U~", "`a`B", "o", "link",
    ];
    let ends = ["", "<|", "|>", "<", ">", "*", "o", "()"];
    let mut out: Vec<String> = Vec::new();
    for a in names {
        out.push(a.to_string());
        out.push(format!("{a} : label"));
        out.push(format!("class {a}"));
        out.push(format!("namespace {a} {{\nclass X\n}}"));
        out.push(format!("<<i>> {a}"));
        out.push(format!("note for {a} \"n\""));
        out.push(format!("click {a} href \"u\""));
        for b in ["A", "B~T~", "`b`"] {
            out.push(format!("{a} --> {b}"));
            out.push(format!("{a} \"1\" --> \"2\" {b} : t"));
        }
    }
    for left in ends {
        for line in ["--", "..", "-", ""] {
            for right in ends {
                out.push(format!("A {left}{line}{right} B"));
                out.push(format!("A \"1\" {left}{line}{right} \"2\" B : t"));
                out.push(format!("A {left}{line}{right}"));
            }
        }
    }
    let bodies = [
        "",
        " {\n}",
        "{}",
        "{ x }",
        " {\n+a\n-b()\n}",
        " {\n\"q\"\n}",
        " {\n[*]\n}",
        " { {",
        " {\n+a",
        " }",
    ];
    for label in ["", "[\"L\"]", "[L]", "[\"L\""] {
        for mid in ["", ":::c", ":::", " <<i>>", " <<i", " : x", " B"] {
            for body in bodies {
                out.push(format!("class A{label}{mid}{body}"));
                out.push(format!("namespace N {{\nclass A{label}{mid}{body}\n}}"));
            }
        }
    }
    for head in [
        "callback A",
        "link A",
        "click A href",
        "click A call f()",
        "click A call f(1, \"a\")",
        "click A call f",
        "click A",
    ] {
        for tail in [
            "",
            " \"a\"",
            " \"a\" \"b\"",
            " \"a\" _blank",
            " \"a\" \"b\" _self",
            " \"a\" \"b\" \"c\"",
            " _top",
            " \"a\" _parent \"b\"",
        ] {
            out.push(format!("{head}{tail}"));
        }
    }
    for head in [
        "style A",
        "style",
        "classDef a",
        "classDef a,b",
        "classDef a,",
        "classDef",
        "cssClass \"A\"",
        "cssClass \"A,B\"",
        "cssClass A",
    ] {
        for tail in [
            "",
            " fill:#f9f",
            " fill:#f9f,stroke:#333,stroke-width:4px",
            " x,y",
            " c",
            " x:1;",
            " a % # : style",
            " \"s\"",
        ] {
            out.push(format!("{head}{tail}"));
        }
    }
    for text in ["\"n\"", "", "n", "\"a\" \"b\"", "\"\""] {
        out.push(format!("note {text}"));
        out.push(format!("note for A {text}"));
        out.push(format!("note for {text}"));
        out.push(format!("notefor A {text}"));
    }
    for line in [
        "direction TB",
        "direction BT",
        "direction RL",
        "direction LR",
        "direction TD",
        "x direction LR y",
        "direction\nTB",
        "direction LR direction TB",
        "accTitle: t",
        "accTitle:",
        "accTitle : t",
        "accDescr: d",
        "accDescr { a\nb }",
        "accDescr {}",
        "accDescr { a",
        "accTitle t",
        "<<i>> A",
        "<<i>>",
        "<<i> A",
        "<< i >> A~T~",
        "%% c",
        "A %% c",
        "[*] --> A",
        "A --> [*]",
        "call f()",
        "A::B",
        "A:::c",
        "A;",
    ] {
        out.push(line.to_string());
        out.push(format!("{line}\nclass A"));
        out.push(format!("class A\n{line}"));
    }

    let css = css_options();
    let res = resolved_options();
    let mut rendered = 0usize;
    let mut rejected = 0usize;
    for item in &out {
        let src = format!("classDiagram\n{item}");
        match render(&src, &res) {
            Ok(r) => {
                rendered += 1;
                assert_inert_resolved(&r.svg, item);
                assert_resvg_parses(&r.svg, item);
                let css_r = render(&src, &css).unwrap();
                assert_inert(&css_r.svg, item);
            }
            Err(_) => {
                rejected += 1;
            }
        }
    }
    assert!(rendered > 500, "rendered={rendered}");
    assert!(rejected > 300, "rejected={rejected}");
}
