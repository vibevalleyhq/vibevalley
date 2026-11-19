mod support;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::{DiagramType, MermaidType};
use vibevalley_pele::diagram::common::parse_generic_types;
use vibevalley_pele::diagram::er::lexer::tokenize;
use vibevalley_pele::diagram::er::tokens::ErToken;
use vibevalley_pele::diagram::er::{Cardinality, DocItem, ErDb, Identification, RelSpec, build_er_graph, parse_er};
use vibevalley_pele::{ErrorCode, LinkInfo, MathSvg, MonospacePart, ParseOptions, ParsedModel, RenderOptions, detect_type, parse, render, supports};

use support::{
    Lcg, Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture,
    resolved_options,
};

fn parse_er_db(src: &str) -> ErDb {
    let mut db = ErDb::new();
    parse_er(src, &mut db, None).unwrap_or_else(|e| panic!("failed to parse ER:\n{src}\nerror: {e}"));
    db
}

fn try_render_css(src: &str) -> Option<String> {
    match render(src, &css_options()) {
        Ok(r) => Some(r.svg),
        Err(_) => None,
    }
}

fn try_render_resolved(src: &str) -> Option<String> {
    match render(src, &resolved_options()) {
        Ok(r) => Some(r.svg),
        Err(_) => None,
    }
}

fn svg_of(src: &str) -> String {
    render(src, &css_options()).unwrap().svg
}

fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
    assert!((a - b).abs() <= tol, "{msg}: {a} vs {b} (tol={tol})");
}

struct EntityBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn entity_box(svg: &str, name: &str) -> EntityBox {
    let re = Regex::new(&format!(
        r#"data-id="{}" transform="translate\(([-\d.]+),([-\d.]+)\)"><rect x="[-\d.]+" y="[-\d.]+" width="([\d.]+)" height="([\d.]+)""#,
        regex::escape(name)
    ))
    .unwrap();
    let cap = re.captures(svg).unwrap_or_else(|| panic!("no entity {name} in svg:\n{svg}"));
    EntityBox {
        x: cap[1].parse().unwrap(),
        y: cap[2].parse().unwrap(),
        w: cap[3].parse().unwrap(),
        h: cap[4].parse().unwrap(),
    }
}

fn edge_paths(svg: &str) -> Vec<String> {
    let re = Regex::new(r#"<g class="pele-edge [^>]*><path d="([^"]+)""#).unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn path_ends(d: &str) -> (f64, f64, f64, f64) {
    let re = Regex::new(r"-?\d+(?:\.\d+)?").unwrap();
    let nums: Vec<f64> = re.find_iter(d).map(|m| m.as_str().parse().unwrap()).collect();
    assert!(nums.len() >= 4, "path too short: {d}");
    (nums[0], nums[1], nums[nums.len() - 2], nums[nums.len() - 1])
}

#[test]
fn er_compat_db_subgraphs_and_graph() {
    // Add subgraph with id, title, and nodes.
    let mut db = ErDb::new();
    let id = db.add_subgraph(
        "sub1",
        &[DocItem::Name("A".to_string()), DocItem::Name("B".to_string())],
        "Group One",
        Some("text"),
    );
    assert_eq!(id, "sub1");
    assert_eq!(db.subgraphs.len(), 1);
    assert_eq!(db.subgraphs[0].id, "sub1");
    assert_eq!(db.subgraphs[0].title, "Group One");
    assert_eq!(db.subgraphs[0].nodes, vec!["A", "B"]);

    // Subgraph without explicit title keeps empty string.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("A".to_string())], "", Some("text"));
    assert_eq!(db.subgraphs[0].id, "sub1");
    assert_eq!(db.subgraphs[0].title, "");

    // Claimed nodes are not duplicated in subsequent subgraphs.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("A".to_string()), DocItem::Name("B".to_string())], "sub1", Some("text"));
    db.add_subgraph("sub2", &[DocItem::Name("A".to_string()), DocItem::Name("C".to_string())], "sub2", Some("text"));
    assert_eq!(db.subgraphs.len(), 2);
    assert_eq!(db.subgraphs[1].nodes, vec!["C"]);

    // Full removal if all nodes already exist elsewhere.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("A".to_string())], "sub1", Some("text"));
    db.add_subgraph("sub2", &[DocItem::Name("A".to_string())], "sub2", Some("text"));
    let sub2 = db.subgraphs.iter().find(|s| s.id == "sub2").unwrap();
    assert!(sub2.nodes.is_empty());

    // Relationships use subgraph id when endpoint is a subgraph.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("X".to_string())], "sub1", Some("text"));
    let spec = RelSpec {
        card_a: Cardinality::OnlyOne,
        rel_type: Identification::Identifying,
        card_b: Cardinality::ZeroOrOne,
    };
    db.add_relationship("sub1", "roleA", "Y", spec);
    assert_eq!(db.relationships.len(), 1);
    assert_eq!(db.relationships[0].entity_a, "sub1");
    assert_eq!(db.relationships[0].entity_b, db.entities["Y"].id);

    // build_er_graph nested clusters with parent relationships.
    let mut db = ErDb::new();
    let outer_id = db.add_subgraph(
        "sub1",
        &[DocItem::Name("sub1_1".to_string()), DocItem::Name("A".to_string())],
        "Group One",
        Some("text"),
    );
    let inner_id = db.add_subgraph("sub1_1", &[DocItem::Name("B".to_string())], "Group Two", Some("text"));
    db.add_entity("A", "");
    db.add_entity("B", "");
    let graph = build_er_graph(&db);
    assert_eq!(graph.nodes.len(), 4);
    let outer = graph.nodes.iter().find(|n| n.id == outer_id).unwrap();
    let inner = graph.nodes.iter().find(|n| n.id == inner_id).unwrap();
    let node_a = graph.nodes.iter().find(|n| n.label == "A").unwrap();
    let node_b = graph.nodes.iter().find(|n| n.label == "B").unwrap();
    assert!(outer.is_group);
    assert!(inner.is_group);
    assert_eq!(outer.label, "Group One");
    assert_eq!(inner.label, "Group Two");
    assert_eq!(inner.parent_id.as_deref(), Some(outer_id.as_str()));
    assert_eq!(node_a.parent_id.as_deref(), Some(outer_id.as_str()));
    assert!(!node_a.is_group);
    assert_eq!(node_b.parent_id.as_deref(), Some(inner_id.as_str()));
    assert!(!node_b.is_group);

    // Edges connected to subgraphs.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("A".to_string())], "Group One", Some("text"));
    db.add_entity("A", "");
    db.add_entity("B", "");
    db.add_relationship(
        "sub1",
        "roleA",
        "B",
        RelSpec {
            card_a: Cardinality::OnlyOne,
            rel_type: Identification::Identifying,
            card_b: Cardinality::ZeroOrMore,
        },
    );
    let graph = build_er_graph(&db);
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.edges[0].start, "sub1");
    assert_eq!(graph.edges[0].end, db.entities["B"].id);

    // Classes and styles on subgraphs.
    let mut db = ErDb::new();
    db.add_subgraph("sub1", &[DocItem::Name("A".to_string())], "sub1", Some("text"));
    db.set_class(&["sub1".to_string()], &["B".to_string()]);
    db.add_css_styles(&["sub1".to_string()], &["fill:red".to_string()]);
    assert!(db.subgraphs[0].classes.contains(&"B".to_string()));
    assert!(db.subgraphs[0].css_styles.contains(&"fill:red".to_string()));
}

#[test]
fn er_compat_parser_entities_attributes_relationships_styles_and_subgraphs() {
    // Stand-alone entities.
    let db = parse_er_db("erDiagram\nISLAND\nMAINLAND");
    assert_eq!(db.entities.len(), 2);
    assert!(db.relationships.is_empty());

    // Empty quotes rejected as entity name.
    let mut db = ErDb::new();
    assert!(parse_er("erDiagram\n \"\"\n", &mut db, None).is_err());

    // Special characters in quoted entity names.
    let chars = "~ ` ! @ # $ ^ & * ( ) - = + [ ] { } | / ; : ' . ? ¡ ⁄ ™ € £ ‹ ¢ › ∞ ﬁ § ‡ • ° ª · º ‚ ≠ ± œ Œ ∑ „ ® † ˇ ¥ Á ¨ ˆ ˆ Ø π ∏ “ « » å Å ß Í ∂ Î ƒ Ï © ˙ Ó ∆ Ô ˚  ¬ Ò … Ú æ Æ Ω ¸ ≈ π ˛ ç Ç √ ◊ ∫ ı ˜ µ Â ≤ ¯ ≥ ˘ ÷ ¿";
    let allowed: Vec<&str> = chars.split(' ').collect();
    for ch in &allowed {
        let single = format!("Blo{ch}rf");
        let repeated = format!("Blo{ch}{ch}rf");
        let ends_with = format!("Blorf{ch}");
        for name in [&single, &repeated, &ends_with] {
            let db = parse_er_db(&format!("erDiagram\n \"{name}\"\n"));
            assert!(db.entities.contains_key(name), "missing quoted entity {name}");
        }
    }
    let all_combined = format!("a{}", allowed.concat());
    let db = parse_er_db(&format!("erDiagram\n \"{all_combined}\"\n"));
    assert!(db.entities.contains_key(&all_combined));

    // Disallowed characters in quoted entity names: %, \, \n, \r, \x08, \x0b.
    for bad in ["Blo%rf", "Blo\\rf", "Blo\nrf", "Blo\rrf", "Blo\x08rf", "Blo\x0brf"] {
        let mut db = ErDb::new();
        assert!(
            parse_er(&format!("erDiagram\n \"{bad}\"\n"), &mut db, None).is_err(),
            "expected error for {bad:?}"
        );
    }

    // Hyphens, underscores, aliases.
    let db = parse_er_db("erDiagram\nDUCK-BILLED_PLATYPUS\n_foo");
    assert!(db.entities.contains_key("DUCK-BILLED_PLATYPUS"));
    assert!(db.entities.contains_key("_foo"));

    let db = parse_er_db("erDiagram\nfoo[\"bar\"]\n");
    assert_eq!(db.entities["foo"].alias, "bar");

    let db = parse_er_db("erDiagram\nfoo ||--o| bar : rel\nbuzz foo[\"batman\"]\n");
    assert_eq!(db.entities["foo"].alias, "batman");
    assert_eq!(db.entities["bar"].alias, "");

    let db = parse_er_db("erDiagram\nbuzz foo[\"batman\"]\nfoo ||--o| bar : rel\n");
    assert_eq!(db.entities["foo"].alias, "batman");
    assert_eq!(db.entities["bar"].alias, "");

    // Attributes: names, asterisks, commas in types, invalid leading chars, backticks, nullable `?`.
    let db = parse_er_db("erDiagram\nBOOK {\nstring myBookTitle\nstring MYBOOKSUBTITLE_1\nstring author-ref[name](1)\n}");
    assert_eq!(db.entities["BOOK"].attributes.len(), 3);
    assert_eq!(db.entities["BOOK"].attributes[0].name, "myBookTitle");
    assert_eq!(db.entities["BOOK"].attributes[1].name, "MYBOOKSUBTITLE_1");
    assert_eq!(db.entities["BOOK"].attributes[2].name, "author-ref[name](1)");

    let db = parse_er_db("erDiagram\nBOOK{\nstring *title}");
    assert_eq!(db.entities["BOOK"].attributes[0].name, "*title");

    let db = parse_er_db("erDiagram\nBUILDING {\npublic.geometry(point,4326) location}");
    assert_eq!(db.entities["BUILDING"].attributes[0].attr_type, "public.geometry(point,4326)");
    assert_eq!(db.entities["BUILDING"].attributes[0].name, "location");

    for bad_lead in ['0', '-', '[', ']', '(', ')'] {
        let mut db = ErDb::new();
        assert!(
            parse_er(&format!("erDiagram\nBOOK {{\nstring {bad_lead}author\n}}"), &mut db, None).is_err(),
            "leading {bad_lead} should fail"
        );
    }

    let db = parse_er_db("erDiagram\nHOTEL {\nstring `geo.accuracy` PK \"the comment\"\n`my.type` address\n}");
    assert_eq!(db.entities["HOTEL"].attributes[0].name, "geo.accuracy");
    assert_eq!(db.entities["HOTEL"].attributes[0].keys, vec!["PK"]);
    assert_eq!(db.entities["HOTEL"].attributes[0].comment, "the comment");
    assert_eq!(db.entities["HOTEL"].attributes[1].attr_type, "my.type");
    assert_eq!(db.entities["HOTEL"].attributes[1].name, "address");

    let db = parse_er_db("erDiagram\nPERSON {\nstring? alias UK \"optional display name\"\n}");
    assert_eq!(db.entities["PERSON"].attributes[0].attr_type, "string?");
    assert_eq!(db.entities["PERSON"].attributes[0].keys, vec!["UK"]);
    assert_eq!(db.entities["PERSON"].attributes[0].comment, "optional display name");

    // Multiple constraints, generic types, arrays, split blocks, empty blocks.
    let db = parse_er_db(
        "erDiagram\nCUSTOMER {\nint customer_number PK, FK \"comment1\"\ndatetime s1 PK,UK, FK\ndatetime s2 PK , UK \"comment3\"\nstring first\nstring last \"comment5\"\n}",
    );
    let attrs = &db.entities["CUSTOMER"].attributes;
    assert_eq!(attrs[0].keys, vec!["PK", "FK"]);
    assert_eq!(attrs[0].comment, "comment1");
    assert_eq!(attrs[1].keys, vec!["PK", "UK", "FK"]);
    assert_eq!(attrs[2].keys, vec!["PK", "UK"]);
    assert_eq!(attrs[2].comment, "comment3");
    assert!(attrs[3].keys.is_empty());
    assert_eq!(attrs[4].comment, "comment5");

    let db = parse_er_db(
        "erDiagram\nBOOK {\ntype~T~ type\noption~T~ readable \"comment\"\nstring[] readers FK\ncharacter(10) isbn FK\n}\nBOOK {\nvarchar(5) postal_code\n}",
    );
    assert_eq!(db.entities["BOOK"].attributes.len(), 5);
    assert_eq!(db.entities["BOOK"].attributes[3].attr_type, "character(10)");
    assert_eq!(db.entities["BOOK"].attributes[4].attr_type, "varchar(5)");

    for empty_blk in ["erDiagram\nBOOK {}", "erDiagram\nBOOK{}", "erDiagram\nBOOK         {}"] {
        let db = parse_er_db(empty_blk);
        assert!(db.entities.contains_key("BOOK"));
        assert!(db.entities["BOOK"].attributes.is_empty());
    }
    let db = parse_er_db("erDiagram\nBOOK{string title}");
    assert_eq!(db.entities["BOOK"].attributes.len(), 1);

    // All 16 symbolic cardinality pairs + word aliases + identifying/non-identifying + issue #7472.
    let rel_cases: &[(&str, Cardinality, Cardinality, Identification)] = &[
        ("A ||--|{ B : has", Cardinality::OneOrMore, Cardinality::OnlyOne, Identification::Identifying),
        (
            "A ||..o{ B : has",
            Cardinality::ZeroOrMore,
            Cardinality::OnlyOne,
            Identification::NonIdentifying,
        ),
        (
            "A |o..o{ B : has",
            Cardinality::ZeroOrMore,
            Cardinality::ZeroOrOne,
            Identification::NonIdentifying,
        ),
        ("A |o--|{ B : has", Cardinality::OneOrMore, Cardinality::ZeroOrOne, Identification::Identifying),
        ("A }|--|| B : has", Cardinality::OnlyOne, Cardinality::OneOrMore, Identification::Identifying),
        ("A }o--|| B : has", Cardinality::OnlyOne, Cardinality::ZeroOrMore, Identification::Identifying),
        (
            "A }o..o| B : has",
            Cardinality::ZeroOrOne,
            Cardinality::ZeroOrMore,
            Identification::NonIdentifying,
        ),
        (
            "A }|..o| B : has",
            Cardinality::ZeroOrOne,
            Cardinality::OneOrMore,
            Identification::NonIdentifying,
        ),
        ("A |o..|| B : has", Cardinality::OnlyOne, Cardinality::ZeroOrOne, Identification::NonIdentifying),
        ("A ||..|| B : has", Cardinality::OnlyOne, Cardinality::OnlyOne, Identification::NonIdentifying),
        ("A ||--o| B : has", Cardinality::ZeroOrOne, Cardinality::OnlyOne, Identification::Identifying),
        (
            "A |o..o| B : has",
            Cardinality::ZeroOrOne,
            Cardinality::ZeroOrOne,
            Identification::NonIdentifying,
        ),
        (
            "A }o--o{ B : has",
            Cardinality::ZeroOrMore,
            Cardinality::ZeroOrMore,
            Identification::Identifying,
        ),
        (
            "A }|..|{ B : has",
            Cardinality::OneOrMore,
            Cardinality::OneOrMore,
            Identification::NonIdentifying,
        ),
        ("A }o--|{ B : has", Cardinality::OneOrMore, Cardinality::ZeroOrMore, Identification::Identifying),
        (
            "A }|..o{ B : has",
            Cardinality::ZeroOrMore,
            Cardinality::OneOrMore,
            Identification::NonIdentifying,
        ),
        (
            "A one or zero to many B : has",
            Cardinality::ZeroOrMore,
            Cardinality::ZeroOrOne,
            Identification::Identifying,
        ),
        (
            "A one or many optionally to zero or one B : has",
            Cardinality::ZeroOrOne,
            Cardinality::OneOrMore,
            Identification::NonIdentifying,
        ),
        (
            "A zero or more to zero or many B : has",
            Cardinality::ZeroOrMore,
            Cardinality::ZeroOrMore,
            Identification::Identifying,
        ),
        (
            "A many(0) to many(1) B : has",
            Cardinality::OneOrMore,
            Cardinality::ZeroOrMore,
            Identification::Identifying,
        ),
        (
            "A many optionally to one B : has",
            Cardinality::OnlyOne,
            Cardinality::ZeroOrMore,
            Identification::NonIdentifying,
        ),
        (
            "A only one optionally to 1+ B : has",
            Cardinality::OneOrMore,
            Cardinality::OnlyOne,
            Identification::NonIdentifying,
        ),
        (
            "A 0+ optionally to 1 B : has",
            Cardinality::OnlyOne,
            Cardinality::ZeroOrMore,
            Identification::NonIdentifying,
        ),
        (
            "CUSTOMER 1--one or more DELIVERY-ADDRESS : has",
            Cardinality::OneOrMore,
            Cardinality::OnlyOne,
            Identification::Identifying,
        ),
        (
            "CUSTOMER 1..one or more DELIVERY-ADDRESS : has",
            Cardinality::OneOrMore,
            Cardinality::OnlyOne,
            Identification::NonIdentifying,
        ),
        (
            "CUSTOMER 1.-one or more DELIVERY-ADDRESS : has",
            Cardinality::OneOrMore,
            Cardinality::OnlyOne,
            Identification::NonIdentifying,
        ),
        (
            "CUSTOMER 1-.one or more DELIVERY-ADDRESS : has",
            Cardinality::OneOrMore,
            Cardinality::OnlyOne,
            Identification::NonIdentifying,
        ),
        (
            "PROJECT u--o{ TEAM_MEMBER : \"parent\"",
            Cardinality::ZeroOrMore,
            Cardinality::MdParent,
            Identification::Identifying,
        ),
    ];
    for &(stmt, card_a, card_b, rel_type) in rel_cases {
        let db = parse_er_db(&format!("erDiagram\n{stmt}"));
        assert_eq!(db.entities.len(), 2, "{stmt}");
        assert_eq!(db.relationships.len(), 1, "{stmt}");
        assert_eq!(db.relationships[0].rel_spec.card_a, card_a, "{stmt}");
        assert_eq!(db.relationships[0].rel_spec.card_b, card_b, "{stmt}");
        assert_eq!(db.relationships[0].rel_spec.rel_type, rel_type, "{stmt}");
    }

    // Issue #7472: numeric entity "1" and "12" on right side with cardinality 1.
    for (src, rhs) in [("erDiagram\na many to 1 1: label", "1"), ("erDiagram\na many to 1 12: label", "12")] {
        let db = parse_er_db(src);
        assert!(db.entities.contains_key("a"));
        assert!(db.entities.contains_key(rhs));
        assert_eq!(db.relationships[0].rel_spec.card_a, Cardinality::OnlyOne);
        assert_eq!(db.relationships[0].rel_spec.card_b, Cardinality::ZeroOrMore);
        assert_eq!(db.relationships[0].rel_spec.rel_type, Identification::Identifying);
    }

    // Accessible title and multiline description.
    let db = parse_er_db("erDiagram\n  accTitle: graph title\n  accDescr: this graph is about stuff\n  A ||--|| B : x");
    assert_eq!(db.acc_title.as_deref(), Some("graph title"));
    assert_eq!(db.acc_descr.as_deref(), Some("this graph is about stuff"));

    let db = parse_er_db("erDiagram\n  accTitle: graph title\n  accDescr { this graph is\n    about\n    stuff\n    }\n  A ||--|| B : x");
    assert_eq!(db.acc_title.as_deref(), Some("graph title"));
    assert_eq!(db.acc_descr.as_deref(), Some("this graph is\nabout\nstuff"));

    // Styles, classes, classDef, and `:::` shorthand.
    let db = parse_er_db("erDiagram\nCUSTOMER\nstyle CUSTOMER color:red,stroke:blue,fill:#f9f\nstyle CUSTOMER stroke-width:2px\n");
    assert_eq!(
        db.entities["CUSTOMER"].css_styles,
        vec!["color:red", "stroke:blue", "fill:#f9f", "stroke-width:2px"]
    );
    let mut bad_style_db = ErDb::new();
    assert!(parse_er("erDiagram\nCUSTOMER\nstyle CUSTOMER opacity:0.5\n", &mut bad_style_db, None).is_err());

    let db = parse_er_db("erDiagram\nCUSTOMER\nclass CUSTOMER firstClass, secondClass\nclass CUSTOMER thirdClass");
    assert_eq!(db.entities["CUSTOMER"].css_classes, "default firstClass secondClass thirdClass");

    let db = parse_er_db("erDiagram\nclassDef firstClass,secondClass fill:#f9f, stroke: red, color: pink\n");
    assert_eq!(db.classes["firstClass"].styles, vec!["fill:#f9f", "stroke:red", "color:pink"]);
    assert_eq!(db.classes["firstClass"].text_styles, vec!["color:pink"]);
    assert_eq!(db.classes["secondClass"].styles, vec!["fill:#f9f", "stroke:red", "color:pink"]);

    let db = parse_er_db("erDiagram\nc[CUSTOMER]:::myClass\nA:::c1,c2 ||--o{ B:::c3 : allows");
    assert_eq!(db.entities["c"].alias, "CUSTOMER");
    assert_eq!(db.entities["c"].css_classes, "default myClass");
    assert_eq!(db.entities["A"].css_classes, "default c1 c2");
    assert_eq!(db.entities["B"].css_classes, "default c3");

    // Special standalone/block/relationship names (`1`, `u`, decimals).
    let db = parse_er_db(
        "erDiagram\nCUSTOMER ||--o{ 1 : places\n1 ||--|{ u : contains\nu {\nstring name\nint quantity\n}\n\"2.5\" ||--|| ORDER : processes\n2.5 ||--|| 5.5 : connects\n0.1\n99.99",
    );
    assert!(db.entities.contains_key("1"));
    assert!(db.entities.contains_key("u"));
    assert!(db.entities.contains_key("2.5"));
    assert!(db.entities.contains_key("5.5"));
    assert!(db.entities.contains_key("0.1"));
    assert!(db.entities.contains_key("99.99"));

    // Subgraph parser specs (`tests/compat/er/subgraph.spec.js`).
    let db = parse_er_db("erDiagram\nsubgraph Group\nA\nB\nend");
    assert_eq!(db.subgraphs.len(), 1);
    assert_eq!(db.subgraphs[0].id, "Group");
    assert_eq!(db.subgraphs[0].title, "Group");
    assert_eq!(db.subgraphs[0].nodes, vec!["A", "B"]);

    let db = parse_er_db("erDiagram\nsubgraph \"Some Title\"\nA\nB\nend");
    assert_eq!(db.subgraphs[0].id, "Some Title");
    assert_eq!(db.subgraphs[0].title, "Some Title");

    let db = parse_er_db("erDiagram\nsubgraph id [Title]\nA\nB\nend");
    assert_eq!(db.subgraphs[0].id, "id");
    assert_eq!(db.subgraphs[0].title, "Title");

    let db = parse_er_db("erDiagram\nsubgraph empty\nend   \n");
    assert!(db.subgraphs[0].nodes.is_empty());

    let db = parse_er_db("erDiagram subgraph WithRL\ndirection RL\nA\nB\nend");
    assert_eq!(db.subgraphs[0].dir.as_deref(), Some("RL"));
    assert_eq!(db.subgraphs[0].nodes, vec!["A", "B"]);

    let db = parse_er_db("erDiagram\nsubgraph G1\n  A\nend\nsubgraph G2\n  B\nend\nG1 }|--|| G2 : \"relates to\"\n");
    assert_eq!(db.relationships[0].entity_a, "G1");
    assert_eq!(db.relationships[0].entity_b, "G2");

    let db = parse_er_db("erDiagram\nsubgraph outer\n  A\n  subgraph inner\n    B\n  end\nend\nA }|--|| B : \"relates to\"\n");
    let outer = db.subgraphs.iter().find(|s| s.id == "outer").unwrap();
    let inner = db.subgraphs.iter().find(|s| s.id == "inner").unwrap();
    assert_eq!(outer.nodes, vec!["A", "inner"]);
    assert_eq!(inner.nodes, vec!["B"]);
}

#[test]
fn er_oracle_seeds_lexer_quirks_and_random_sequences() {
    // All 14 oracle seeds from upstream `tests/er/oracle.test.ts`.
    let seeds = [
        "erDiagram\nCUSTOMER ||--o{ ORDER : places\nORDER ||--|{ LINE-ITEM : contains\n",
        "erDiagram\nA |o--o| B : \"a b\"\nC }o..o{ D : \"\"\nE }|.-|{ F : x\nG ||-.|| H : y\nI u--o{ J : z\n",
        "erDiagram\nA one or zero to one or more B : r\nC zero or many optionally to many(1) D : r\nE only one to 1+ F : r\n",
        "erDiagram\nA 1 to zero or more B : r\nC many(0) optionally to 0+ D : r\nE 1--1 F : r\nG 1..many H : r\nx 1--1 12 : r\n",
        "erDiagram\nBOOK {\n  string title PK \"The title\"\n  string? subtitle\n  int *pages UK\n  List~string~ tags FK, UK \"many\"\n  `my type` `my name` PK,FK\n}\n",
        "erDiagram\nA{}\nB { }\nC {string name}\nD:::x { int id PK }\nE:::x,y\nF:::x {}\n",
        "erDiagram\np[Person] {\n string firstName\n}\na[\"Customer Account\"]:::big {\n string email\n}\nb[B]\nc[C]:::k\nd[D] {}\ne[E]:::k {}\np ||--o| a : has\n",
        "erDiagram\nA:::x ||--o{ B:::y,z : rel\nC:::x ||--o{ D : rel\nE ||--o{ F:::y : \"r\"\n",
        "erDiagram\nA\nB\nstyle A fill:#f9f,stroke:#333,stroke-width:4px\nstyle A,B color:red\nclassDef big,small font-size:12pt\nclassDef default fill:#f9f;\nclass A big\nclass A,B big,small\n",
        "erDiagram\ndirection LR\nsubgraph one1\n A\n B ||--|| C : x\n subgraph \"Two Words\"\n  direction TB\n  D { int id }\n end\n subgraph s3 [Title of three]\n  E\n end\nend\none1 ||--|| E : links\nstyle one1 fill:red\nclass s3 big\n",
        "erDiagram\naccTitle: A title\naccDescr: A description\nA\n",
        "erDiagram\naccDescr {\n several\n lines\n}\nsubgraph g\naccTitle: inside\nclassDef c fill:red\nstyle A fill:red\nclass A c\nA\nend\n",
        "erDiagram\n\"Quoted name\" ||--|| \"Other ❤ name\" : \"a label\"\n1.5 ||--|| 2 : n\n_x ||--|| y-z : n\nA.B ||--|| C*D : n\n",
        "erDiagram A B C\nD { a b c d } E\n",
    ];
    for src in seeds {
        let mut db = ErDb::new();
        parse_er(src, &mut db, None).unwrap_or_else(|e| panic!("seed failed: {src}\n{e}"));
        let res_css = render(src, &css_options()).unwrap();
        assert_inert(&res_css.svg, src);
        let res_resolved = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&res_resolved.svg, src);
        assert_resvg_parses(&res_resolved.svg, src);
    }

    // Lexer edge cases: multiline `DIRECTION\ntb`, greedy `direction TB ... direction\nTB`, `u`, `1`, micro sign `µ`.
    let toks = tokenize("erDiagram\nDIRECTION\ntb\nA");
    assert_eq!(toks.types[2], ErToken::DirectionTb);
    assert_eq!(toks.texts[2], "DIRECTION\ntb");

    let toks = tokenize("erDiagram\nfoo direction TB bar direction\nTB baz\nA");
    assert_eq!(toks.types[2], ErToken::DirectionTb);
    assert_eq!(toks.texts[2], "foo direction TB bar direction\nTB baz");

    let toks = tokenize("erDiagram\nA {\n  µsec time\n}");
    assert!(toks.types.contains(&ErToken::AttributeWord));
    let db = parse_er_db("erDiagram\nA {\n  µsec time\n}");
    assert_eq!(db.entities["A"].attributes[0].attr_type, "µsec");

    // Random token sequences (ported from `tests/er/oracle.test.ts`) never panic in lexer/parser/renderer.
    let fragments: &[&str] = &[
        " ",
        "\n",
        "\t",
        "\r\n",
        " \n",
        ";",
        ":",
        ":::",
        ",",
        "#",
        "\"",
        "\"\"",
        "`",
        "``",
        "~",
        "{",
        "}",
        "[",
        "]",
        "(",
        ")",
        "?",
        "*",
        ".",
        "-",
        "_",
        "|",
        "%",
        "\\",
        "||",
        "|o",
        "o|",
        "}o",
        "o{",
        "}|",
        "|{",
        "--",
        "..",
        ".-",
        "-.",
        "u",
        "u--",
        "u..",
        "||--o{",
        "}|..|{",
        "|o--o|",
        " 1 ",
        "1",
        "1+",
        "0+",
        "1.5",
        "12",
        "0",
        "7",
        "2",
        "4",
        "6",
        "9",
        " one ",
        " only one ",
        " one or zero ",
        " one or more ",
        " one or many ",
        " zero or one ",
        " zero or more ",
        " zero or many ",
        " many(0) ",
        " many(1) ",
        " many ",
        " to ",
        " optionally to ",
        "one",
        "only",
        "zero",
        "or",
        "many",
        "to",
        "optionally",
        "A",
        "B",
        "id1",
        "CUSTOMER",
        "LINE-ITEM",
        "é",
        "µ",
        "ö",
        "\u{00a0}",
        "\u{2028}",
        "PK",
        "FK",
        "UK",
        "pk",
        " PK, FK ",
        "string",
        "int",
        "type~T~",
        "List~int~",
        " \"comment\" ",
        "\"a b\"",
        "\"a%b\"",
        "erDiagram",
        "ERDIAGRAM",
        "style ",
        "style",
        "classDef ",
        "classDef",
        "class ",
        "class",
        "subgraph ",
        "subgraph",
        "end",
        "end\n",
        "END ",
        "direction TB",
        "direction BT",
        "direction RL",
        "direction LR",
        "direction",
        "DIRECTION\ntb",
        "accTitle: ",
        "accDescr: ",
        "accDescr { ",
        "acctitle:",
        "title",
        "fill:#f9f",
        "stroke-width:2px",
        "color:red",
        "default",
        " : ",
        " : label\n",
        "{\n",
        "\n}\n",
        "A { string b }",
        "p[Person]",
        "a[\"x y\"]",
        "%%",
        "\x0b",
        "\x0c",
    ];
    let openers = [
        "erDiagram\n",
        "erDiagram\nA {\n",
        "erDiagram\nstyle A ",
        "erDiagram\nA ",
        "erDiagram\nsubgraph s\n",
        "",
    ];
    let mut rng = Lcg::new(8);
    for _ in 0..1000 {
        let mut src = openers[rng.next_usize(openers.len())].to_string();
        let count = 1 + rng.next_usize(10);
        for _ in 0..count {
            src.push_str(fragments[rng.next_usize(fragments.len())]);
            if rng.next_f64() < 0.3 {
                src.push(' ');
            }
        }
        let _ = tokenize(&src);
        let mut db = ErDb::new();
        if parse_er(&src, &mut db, None).is_ok()
            && let Ok(r) = render(&src, &resolved_options())
        {
            assert_inert_resolved(&r.svg, &src[..src.len().min(80)]);
            assert_resvg_parses(&r.svg, &src[..src.len().min(80)]);
        }
    }
}

#[test]
fn er_renders_full_upstream_corpus_in_css_resolved_and_dark_resvg_modes() {
    let corpus = load_fixture("er-corpus.json");
    assert!(corpus.len() > 100, "expected >100 ER corpus entries, got {}", corpus.len());
    let mut rendered = 0usize;
    let re_bad = Regex::new(r"(?i)<script|<style|<foreignObject|<defs|<marker|\son\w+=|javascript:").unwrap();
    for src in &corpus {
        let Some(svg) = try_render_css(src) else {
            continue;
        };
        rendered += 1;
        let where_ctx = &src[..src.len().min(120)];
        assert_inert(&svg, where_ctx);
        assert!(!re_bad.is_match(&svg), "{where_ctx}: unsafe markup");
        assert!(!svg.contains("NaN"), "{where_ctx}: NaN");
        assert!(!svg.contains("undefined"), "{where_ctx}: undefined");
        assert_eq!(try_render_css(src).as_deref(), Some(svg.as_str()), "determinism");

        let res_svg = try_render_resolved(src).expect("resolved mode failed where css mode succeeded");
        assert_inert_resolved(&res_svg, where_ctx);
        assert_resvg_parses(&res_svg, where_ctx);

        let dark_svg = render(src, &dark_options()).expect("dark mode failed").svg;
        assert_inert_resolved(&dark_svg, where_ctx);
        assert_resvg_parses(&dark_svg, where_ctx);
    }
    assert!(rendered > 90, "expected >90 rendered ER samples, got {rendered}");
}

#[test]
fn er_rendering_layout_table_monospace_stripes_aliases_and_markers() {
    // Detection, support, and typed model.
    let src = "erDiagram\n  A ||--o{ B : has";
    assert_eq!(detect_type(src), Some(DiagramType::Er));
    assert!(supports(src));
    let result = render(src, &css_options()).unwrap();
    assert_eq!(result.diagram_type, DiagramType::Er);
    assert_eq!(result.mermaid_type, MermaidType::Er);
    assert!(result.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-er""#));
    assert!(result.svg.contains(&format!("viewBox=\"0 0 {} {}\"", result.width, result.height)));
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    assert_eq!(parsed.diagram_type, DiagramType::Er);
    match &parsed.model {
        ParsedModel::Er(db) => {
            let keys: Vec<&str> = db.entities.keys().map(String::as_str).collect();
            assert_eq!(keys, vec!["A", "B"]);
        }
        other => panic!("expected Er model, got {other:?}"),
    }

    // Directions TB, LR, BT, RL.
    let tall = render("erDiagram\n  A ||--o{ B : x\n  B ||--o{ C : y", &css_options()).unwrap();
    let wide = render("erDiagram\n  direction LR\n  A ||--o{ B : x\n  B ||--o{ C : y", &css_options()).unwrap();
    assert!(tall.height > tall.width);
    assert!(wide.width > wide.height);
    let up = svg_of("erDiagram\n  direction BT\n  A ||--o{ B : x");
    assert!(entity_box(&up, "A").y > entity_box(&up, "B").y);
    let back = svg_of("erDiagram\n  direction RL\n  A ||--o{ B : x");
    assert!(entity_box(&back, "A").x > entity_box(&back, "B").x);

    // Entity without attributes is a plain box.
    let island = svg_of("erDiagram\n  ISLAND");
    assert_eq!(island.matches("<rect").count(), 1);
    assert!(island.contains(r#"<g class="pele-node pele-entity" data-id="ISLAND""#));
    assert!(island.contains(">ISLAND</text>"));
    assert!(!island.contains("pele-er-attributes"));

    // Attribute table with aligned columns.
    let car_svg = svg_of(
        "erDiagram\n  CAR {\n    string registrationNumber PK \"The plate\"\n    int wheels\n    string(99) make FK, UK\n    float? price \"In euros\"\n  }",
    );
    let column_xs = |cls: &str| -> Vec<f64> {
        Regex::new(&format!(r#"<text class="{cls}"[^>]* x="([-\d.]+)""#))
            .unwrap()
            .captures_iter(&car_svg)
            .map(|c| c[1].parse().unwrap())
            .collect()
    };
    for cls in ["pele-er-type", "pele-er-name", "pele-er-keys", "pele-er-comment"] {
        let xs = column_xs(cls);
        assert!(xs.len() > 1, "{cls}");
        let uniq: HashSet<String> = xs.iter().map(|v| format!("{v:.2}")).collect();
        assert_eq!(uniq.len(), 1, "{cls}");
    }
    assert_eq!(column_xs("pele-er-type").len(), 4);
    assert!(column_xs("pele-er-name")[0] > column_xs("pele-er-type")[0]);
    assert!(column_xs("pele-er-keys")[0] > column_xs("pele-er-name")[0]);
    assert!(column_xs("pele-er-comment")[0] > column_xs("pele-er-keys")[0]);
    for expected in [
        ">string</text>",
        ">registrationNumber</text>",
        ">PK</text>",
        ">FK, UK</text>",
        ">The plate</text>",
        ">float?</text>",
        ">string(99)</text>",
    ] {
        assert!(car_svg.contains(expected), "missing {expected}");
    }

    // Monospace attributes option.
    let mono_src = "erDiagram\n  CAR {\n    string registrationNumber PK \"The plate number, as issued by the registration office of the country\"\n    int wheels FK, UK\n  }";
    let plain = svg_of(mono_src);
    let mono_opts = RenderOptions {
        monospace: vec![MonospacePart::Attributes],
        ..css_options()
    };
    let mono = render(mono_src, &mono_opts).unwrap().svg;
    let re_comment = Regex::new(r#"<text class="pele-er-comment".*?</text>"#).unwrap();
    let re_x = Regex::new(r#" x="[-\d.]+""#).unwrap();
    for cls in ["pele-er-type", "pele-er-name", "pele-er-keys"] {
        assert!(
            Regex::new(&format!(r#"<text class="{cls}"[^>]* font-family="var\(--_fm\)""#))
                .unwrap()
                .is_match(&mono),
            "missing mono font on {cls}"
        );
    }
    assert!(!plain.contains(r#"font-family="var(--_fm)""#));
    let mono_comment = re_comment.find(&mono).unwrap().as_str();
    let plain_comment = re_comment.find(&plain).unwrap().as_str();
    assert!(!mono_comment.contains("font-family"));
    assert_eq!(re_x.replace_all(mono_comment, ""), re_x.replace_all(plain_comment, ""));
    assert_eq!(mono_comment.matches("<tspan").count(), 2);
    assert!(entity_box(&mono, "CAR").w > entity_box(&plain, "CAR").w);

    let re_spaced = Regex::new(r#"<text class="pele-er-name" font-family="var\(--_fm\)" xml:space="preserve"><tspan[^>]*>a {2}b</tspan>"#).unwrap();
    for name in ["`a  b`", "`<code>a  b</code>`"] {
        let spaced = render(&format!("erDiagram\n  A {{\n    string {name}\n  }}"), &mono_opts).unwrap().svg;
        assert!(re_spaced.is_match(&spaced), "double spaces not preserved for {name}: {spaced}");
    }

    // Non-Attributes MonospacePart values are ignored.
    let other_mono = render(
        mono_src,
        &RenderOptions {
            monospace: vec![MonospacePart::Members, MonospacePart::Files, MonospacePart::Messages],
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(other_mono, plain);

    // Entity's own font-family overrides monospace on attributes.
    let re_a_attrs = Regex::new(r#"data-id="A".*?(<g class="pele-er-attributes".*?</g>)"#).unwrap();
    for rule in [
        "style A color:black,font-family:serif",
        "classDef serif color:black,font-family:serif\n  class A serif",
    ] {
        let rule_src = format!("erDiagram\n  A {{\n    string name PK\n  }}\n  B {{\n    string name PK\n  }}\n  {rule}");
        let svg_mono = render(&rule_src, &mono_opts).unwrap().svg;
        let svg_plain = svg_of(&rule_src);
        assert_eq!(re_a_attrs.captures(&svg_mono).unwrap()[1], re_a_attrs.captures(&svg_plain).unwrap()[1]);
        assert!(svg_mono.split(r#"data-id="B""#).nth(1).unwrap().contains(r#"font-family="var(--_fm)""#));
    }

    // Alternate row shading and rounded last row.
    let three = svg_of("erDiagram\n  A {\n int a\n int b\n int c\n }");
    let re_stripes = Regex::new(r#"<g class="pele-er-stripes" fill="var\(--_bg\)">(.*?)</g>"#).unwrap();
    let stripes = &re_stripes.captures(&three).unwrap()[1];
    assert_eq!(stripes.matches("<rect").count(), 3);
    assert_eq!(stripes.matches("rx:var(--_r)").count(), 1);
    let two = svg_of("erDiagram\n  A {\n int a\n int b\n }");
    assert_eq!(re_stripes.captures(&two).unwrap()[1].matches("<rect").count(), 1);

    // Rows inside box and equal height.
    let four = svg_of("erDiagram\n  A {\n int a\n int b\n int c\n int d\n }");
    let b = entity_box(&four, "A");
    let ys: Vec<f64> = Regex::new(r#"<text class="pele-er-type"[^>]* y="([-\d.]+)""#)
        .unwrap()
        .captures_iter(&four)
        .map(|c| c[1].parse().unwrap())
        .collect();
    assert_eq!(ys.len(), 4);
    let gaps: HashSet<String> = ys.windows(2).map(|w| format!("{:.2}", w[1] - w[0])).collect();
    assert_eq!(gaps.len(), 1);
    assert!(ys[0] > -b.h / 2.0);
    assert!(ys[3] < b.h / 2.0);

    // Alias displayed in place of name.
    let aliased = svg_of("erDiagram\n  p[Person] {\n string name\n }\n  a[\"Customer Account\"]\n  p ||--o| a : has");
    assert!(aliased.contains(">Person</text>"));
    assert!(aliased.contains(">Customer Account</text>"));
    assert!(!aliased.contains(">p</text>"));
    assert!(aliased.contains(r#"data-id="p""#));

    // Cardinality markers and ring placement.
    let shapes = |s: &str| -> Vec<String> {
        let svg = svg_of(s);
        let group = Regex::new(r#"<g class="pele-edge [^>]*>(.*?)</g>"#).unwrap().captures(&svg).unwrap()[1].to_string();
        Regex::new(r#"<(path|circle) class="pele-marker""#)
            .unwrap()
            .captures_iter(&group)
            .map(|c| c[1].to_string())
            .collect()
    };
    assert_eq!(shapes("erDiagram\n A ||--|| B : x"), vec!["path", "path"]);
    assert_eq!(shapes("erDiagram\n A |o--o| B : x"), vec!["path", "circle", "path", "circle"]);
    assert_eq!(shapes("erDiagram\n A }o--o{ B : x"), vec!["path", "circle", "path", "circle"]);
    assert_eq!(shapes("erDiagram\n A }|--|{ B : x"), vec!["path", "path"]);
    assert_eq!(shapes("erDiagram\n A ||--o{ B : x"), vec!["path", "path", "circle"]);
    assert_eq!(shapes("erDiagram\n A u--|| B : x"), vec!["path", "path"]);

    let one_to_many = svg_of("erDiagram\n A ||--o{ B : x");
    let ring = Regex::new(r#"<circle class="pele-marker" cx="([-\d.]+)" cy="([-\d.]+)""#)
        .unwrap()
        .captures(&one_to_many)
        .unwrap();
    let ring_y: f64 = ring[2].parse().unwrap();
    let box_a = entity_box(&one_to_many, "A");
    let box_b = entity_box(&one_to_many, "B");
    assert!((ring_y - box_b.y).abs() < (ring_y - box_a.y).abs());

    // Word aliases match symbolic markers.
    let edge_block = |s: &str| -> String {
        let svg = svg_of(s);
        let raw = Regex::new(r#"<g class="pele-edges".*?</g></g>"#).unwrap().find(&svg).unwrap().as_str();
        Regex::new(r#"data-id="[^"]*""#).unwrap().replace_all(raw, "").to_string()
    };
    assert_eq!(
        edge_block("erDiagram\n A one or zero to one or more B : x"),
        edge_block("erDiagram\n A |o--|{ B : x")
    );
    assert_eq!(
        edge_block("erDiagram\n A only one to zero or many B : x"),
        edge_block("erDiagram\n A ||--o{ B : x")
    );
    assert_eq!(
        edge_block("erDiagram\n A 1 optionally to many(1) B : x"),
        edge_block("erDiagram\n A ||..|{ B : x")
    );
    assert_eq!(edge_block("erDiagram\n A zero or one to 0+ B : x"), edge_block("erDiagram\n A |o--o{ B : x"));
    assert_eq!(edge_block("erDiagram\n A 1+ to many(0) B : x"), edge_block("erDiagram\n A }|--o{ B : x"));

    // Identifying solid vs non-identifying dashed.
    let solid = svg_of("erDiagram\n A ||--|| B : x");
    let dashed = svg_of("erDiagram\n A ||..|| B : x");
    assert!(solid.contains(r#"class="pele-edge pele-er-identifying""#));
    assert!(!solid.contains("stroke-dasharray"));
    assert!(dashed.contains(r#"class="pele-edge pele-er-non-identifying""#));
    assert_eq!(dashed.matches("stroke-dasharray").count(), 1);
}

#[test]
fn er_rendering_routes_loops_styles_contrast_clusters_casings_math_and_errors() {
    // Lines run all the way to both box borders in all 4 directions.
    for dir in ["TB", "BT", "LR", "RL"] {
        let svg = svg_of(&format!("erDiagram\n direction {dir}\n A ||--o{{ B : x"));
        let (sx, sy, ex, ey) = path_ends(&edge_paths(&svg)[0]);
        let a = entity_box(&svg, "A");
        let b = entity_box(&svg, "B");
        let on_border = |x: f64, y: f64, e: &EntityBox| -> bool {
            (((x - e.x).abs() - e.w / 2.0).abs() < 0.02 && (y - e.y).abs() <= e.h / 2.0)
                || (((y - e.y).abs() - e.h / 2.0).abs() < 0.02 && (x - e.x).abs() <= e.w / 2.0)
        };
        assert!(on_border(sx, sy, &a), "{dir} start");
        assert!(on_border(ex, ey, &b), "{dir} end");
    }

    // Multiple lines meeting one side of an entity are spaced out.
    let fan = svg_of("erDiagram\n A ||--o{ B : x\n A ||--o{ C : y\n A ||--o{ D : z");
    let mut starts: Vec<f64> = edge_paths(&fan).iter().map(|d| path_ends(d).0).collect();
    let uniq: HashSet<String> = starts.iter().map(|x| format!("{x:.2}")).collect();
    assert_eq!(uniq.len(), 3);
    starts.sort_by(f64::total_cmp);
    assert!(starts[1] - starts[0] >= 12.0);
    let a = entity_box(&fan, "A");
    for x in starts {
        assert!((x - a.x).abs() < a.w / 2.0);
    }

    // Edge labels and empty labels omitted.
    let labels = svg_of("erDiagram\n A ||--o{ B : \"places an order\"\n B ||--o{ C : \"\"");
    assert_eq!(labels.matches(r#"<g class="pele-edge-label""#).count(), 1);
    assert!(labels.contains(">places an order</text>"));
    assert_eq!(labels.matches(r#"<g class="pele-edge "#).count(), 2);

    // Self-loop on right in TB and on bottom in LR, stacking multiple loops.
    let self_tb = svg_of("erDiagram\n EMPLOYEE ||--o{ EMPLOYEE : manages");
    let re_h_loop = Regex::new(r"^M([-\d.]+),([-\d.]+)H.*,([-\d.]+)H([-\d.]+)$").unwrap();
    let self_tb_paths = edge_paths(&self_tb);
    let cap = re_h_loop.captures(&self_tb_paths[0]).unwrap();
    let emp = entity_box(&self_tb, "EMPLOYEE");
    assert_close(cap[1].parse().unwrap(), emp.x + emp.w / 2.0, 0.1, "loop start x");
    assert_close(cap[4].parse().unwrap(), emp.x + emp.w / 2.0, 0.1, "loop end x");
    let y1: f64 = cap[2].parse().unwrap();
    let y2: f64 = cap[3].parse().unwrap();
    assert!(y1 < emp.y && y2 > emp.y && y2 < emp.y + emp.h / 2.0);
    assert_eq!(self_tb.matches(r#"class="pele-marker""#).count(), 3);
    assert!(self_tb.contains(">manages</text>"));

    let self_lr = svg_of("erDiagram\n direction LR\n A ||--o{ A : self\n A ||--o{ B : x");
    let loop_d = edge_paths(&self_lr).into_iter().find(|d| d.contains('V')).unwrap();
    let re_v_loop = Regex::new(r"^M([-\d.]+),([-\d.]+)V.*V([-\d.]+)$").unwrap();
    let cap = re_v_loop.captures(&loop_d).unwrap();
    let a = entity_box(&self_lr, "A");
    assert_close(cap[2].parse().unwrap(), a.y + a.h / 2.0, 0.1, "lr loop start y");
    assert_close(cap[3].parse().unwrap(), a.y + a.h / 2.0, 0.1, "lr loop end y");
    assert!((cap[1].parse::<f64>().unwrap() - a.x).abs() < a.w / 2.0);

    let two_loops = svg_of("erDiagram\n A ||--o{ A : first\n A |o--|| A : second");
    let re_y = Regex::new(r"^M[-\d.]+,([-\d.]+)H").unwrap();
    let ys: Vec<f64> = edge_paths(&two_loops).iter().map(|d| re_y.captures(d).unwrap()[1].parse().unwrap()).collect();
    let e = entity_box(&two_loops, "A");
    assert_eq!(ys.len(), 2);
    assert!(ys[1] - ys[0] >= 30.0);
    for y in ys {
        assert!((y - e.y).abs() < e.h / 2.0);
    }
    assert!(two_loops.contains(">first</text>") && two_loops.contains(">second</text>"));

    // Styles, classDef, class, `:::`, and tinted stripes.
    let styled = svg_of(
        "erDiagram\n A:::hot { int id }\n B\n C\n class B hot\n classDef hot fill:#f96,stroke:#333\n style C fill:#bbf,color:#fff\n classDef default stroke-width:2px",
    );
    assert!(styled.contains(r#"<g class="pele-node pele-entity hot" data-id="A""#));
    assert!(styled.contains(r#"<g class="pele-node pele-entity hot" data-id="B""#));
    assert!(styled.contains(r#"style="rx:var(--_r);stroke-width:2px;fill:#f96;stroke:#333;""#));
    assert!(
        Regex::new(r#"data-id="C"[^>]*><rect[^>]* style="rx:var\(--_r\);stroke-width:2px;fill:#bbf;""#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(
        Regex::new(r#"<text class="pele-label" style="fill:#fff;"[^>]*>C</text>"#)
            .unwrap()
            .is_match(&styled)
    );
    assert!(styled.contains(r#"<g class="pele-er-stripes" fill="var(--pele-fg-on-dark,#fff)" opacity="0.6">"#));

    // Contrasting ink colors on fills.
    let contrast_src = "erDiagram\n A { int id PK \"key\" }\n B { int id }\n C { int id }\n D { int id }\n subgraph G\n  E\n end\n style A fill:navy\n style B fill:#BBDEFB\n style C fill:#BBDEFB,color:#333\n style G fill:#FFF9C4";
    let contrast = svg_of(contrast_src);
    let entity_body = |id: &str| -> String {
        Regex::new(&format!(r#"data-id="{id}"[^>]*>(.*?)</g></g>"#))
            .unwrap()
            .captures(&contrast)
            .unwrap()[1]
            .to_string()
    };
    let a_body = entity_body("A");
    assert!(a_body.contains(r#"<g class="pele-er-stripes" fill="var(--pele-fg-on-light,#1f1f1f)" opacity="0.6">"#));
    for cell in ["pele-label", "pele-er-type", "pele-er-name", "pele-er-keys", "pele-er-comment"] {
        assert!(
            Regex::new(&format!(r#"<text class="{cell}"[^>]* fill="var\(--pele-fg-on-dark,#fff\)""#))
                .unwrap()
                .is_match(&a_body),
            "missing dark-bg ink on {cell}"
        );
    }
    let b_body = entity_body("B");
    assert!(b_body.contains(r#"<text class="pele-label" fill="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(b_body.contains(r#"<g class="pele-er-stripes" fill="var(--pele-fg-on-dark,#fff)" opacity="0.6">"#));
    let c_body = entity_body("C");
    assert!(!c_body.contains("--pele-fg-on-light"));
    assert!(c_body.contains(r#"<text class="pele-er-type" fill="var(--_m)" style="fill:#333;""#));
    let d_body = entity_body("D");
    assert!(d_body.contains(r#"<g class="pele-er-stripes" fill="var(--_bg)">"#));
    assert!(!d_body.contains("--pele-fg-on"));
    assert!(
        Regex::new(r#"data-id="G">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)""#)
            .unwrap()
            .is_match(&contrast)
    );

    // Markdown & unicode.
    let md = svg_of("erDiagram\n \"This **is** _Markdown_\" ||--o{ \"Ünïcödé ❤ 日本語\" : \"**bold** label\"\n T {\n string x \"a *b* c\"\n }");
    assert!(md.contains(r#"<tspan font-weight="var(--_w)">is</tspan>"#));
    assert!(md.contains(r#"<tspan font-style="italic">Markdown</tspan>"#));
    assert!(md.contains("Ünïcödé ❤ 日本語"));
    assert!(
        Regex::new(r#"<tspan[^>]* font-weight="var\(--_w\)">bold</tspan><tspan> label</tspan>"#)
            .unwrap()
            .is_match(&md)
    );
    assert!(md.contains(r#"<tspan font-style="italic">b</tspan>"#));

    // Generic types `~` -> `<...>`.
    assert_eq!(parse_generic_types("List~int~"), "List<int>");
    assert_eq!(parse_generic_types("Map~K,V~"), "Map<K,V>");
    assert_eq!(parse_generic_types("Array~Array~string~~"), "Array<Array<string>>");
    assert_eq!(parse_generic_types("a~b"), "a~b");
    assert_eq!(parse_generic_types("plain"), "plain");
    assert!(svg_of("erDiagram\n A {\n List~string~ tags\n }").contains(">List&lt;string&gt;</text>"));

    // Nested subgraphs as clusters.
    let clusters = svg_of(
        "erDiagram\n subgraph outer [Outer title]\n  A\n  subgraph inner\n   B { int id }\n  end\n end\n subgraph \"Empty One\"\n end\n outer ||--o{ C : links\n C ||--|| inner : x",
    );
    assert_eq!(clusters.matches(r#"<g class="pele-cluster""#).count(), 3);
    assert!(clusters.contains(r#"data-id="outer""#));
    assert!(clusters.contains(">Outer title</text>"));
    assert!(clusters.contains(">inner</text>"));
    assert!(clusters.contains(">Empty One</text>"));
    assert_eq!(clusters.matches(r#"<g class="pele-edge "#).count(), 2);
    let re_cluster = Regex::new(r#"<g class="pele-cluster" data-id="(\w+)"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    let cluster_rect = |id: &str| -> [f64; 4] {
        let cap = re_cluster.captures_iter(&clusters).find(|c| &c[1] == id).unwrap();
        [
            cap[2].parse().unwrap(),
            cap[3].parse().unwrap(),
            cap[4].parse().unwrap(),
            cap[5].parse().unwrap(),
        ]
    };
    let outer = cluster_rect("outer");
    let inner = cluster_rect("inner");
    assert!(inner[0] > outer[0] && inner[1] > outer[1]);
    assert!(inner[0] + inner[2] < outer[0] + outer[2] && inner[1] + inner[3] < outer[1] + outer[3]);
    let b = entity_box(&clusters, "B");
    assert!(b.x > inner[0] && b.x < inner[0] + inner[2]);

    // Subgraph fill opacity.
    let sub_fill = svg_of("erDiagram\n subgraph g\n  A\n end\n subgraph h\n  B\n end\n style g fill:#fee");
    assert!(Regex::new(r#"data-id="g"><rect [^>]*fill="var\(--_a\)" stroke="#).unwrap().is_match(&sub_fill));
    assert!(Regex::new(r#"data-id="h"><rect [^>]*fill-opacity="0\.5""#).unwrap().is_match(&sub_fill));

    // Edge casings across subgraph fills, edge ink inside fills, and hollow ring fill.
    let casing_src = "erDiagram\n subgraph g\n  A ||--o{ B : has\n end\n B ||--|| C : is\n C ||--|| D : of\n C ||--o{ C : self\n style g fill:#BBDEFB";
    let casing_svg = svg_of(casing_src);
    let casings = Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap().captures(&casing_svg).unwrap()[1].to_string();
    let edges: Vec<String> = Regex::new(r#"class="pele-edge [^"]*" data-id="[^"]+"[^>]*><path d="([^"]+)""#)
        .unwrap()
        .captures_iter(&casing_svg)
        .map(|c| c[1].to_string())
        .collect();
    let cased_flags: Vec<bool> = edges.iter().map(|d| casings.contains(&format!(r#"<path d="{d}"/>"#))).collect();
    assert_eq!(cased_flags, vec![false, true, false, false]);
    assert!(
        Regex::new(r#"class="pele-edge [^"]*" data-id="[^"]+" stroke="var\(--pele-fg-on-light,#1f1f1f\)"><path d="[^"]+""#)
            .unwrap()
            .is_match(&casing_svg)
    );
    assert_eq!(casing_svg.matches(r#"stroke="var(--pele-fg-on"#).count(), 1);
    assert!(!casings.contains("pele-marker"));

    let ring_src = "erDiagram\n subgraph S\n  A ||--o{ B : has\n end\n style S fill:black";
    let ring_css = svg_of(ring_src);
    assert!(Regex::new(r#"<circle class="pele-marker"[^>]* fill="black"/>"#).unwrap().is_match(&ring_css));
    let ring_res = render(ring_src, &resolved_options()).unwrap().svg;
    assert_inert_resolved(&ring_res, "hollow ring resolved");
    assert_resvg_parses(&ring_res, "hollow ring resvg");
    assert!(Regex::new(r#"<circle class="pele-marker"[^>]* fill="black"/>"#).unwrap().is_match(&ring_res));

    let unstyled = svg_of(&casing_src.replace("\n style g fill:#BBDEFB", ""));
    assert!(!unstyled.contains("pele-casings") && !unstyled.contains(r#"stroke="var(--pele-fg-on"#));

    // Early relationship before subgraph connects to subgraph.
    let early = svg_of("erDiagram\n g ||--o{ X : early\n subgraph g\n  A\n end");
    assert_eq!(early.matches(r#"<g class="pele-edge "#).count(), 1);
    assert!(!early.contains(r#"data-id="g" transform"#));

    // Styled subgraph with its own direction.
    let sub_dir = svg_of("erDiagram\n subgraph g\n  direction LR\n  A ||--|| B : x\n end\n style g fill:#fee\n classDef k stroke:#c33\n class g k");
    assert!(
        Regex::new(r#"<g class="pele-cluster k" data-id="g"><rect[^>]* style="rx:var\(--_r\);stroke:#c33;fill:#fee;""#)
            .unwrap()
            .is_match(&sub_dir)
    );
    assert!(entity_box(&sub_dir, "B").x > entity_box(&sub_dir, "A").x);
    assert_close(entity_box(&sub_dir, "B").y, entity_box(&sub_dir, "A").y, 0.1, "subgraph LR same y");

    // Title and accessible title/desc.
    let titled = svg_of("---\ntitle: Order example\n---\nerDiagram\n accTitle: Orders\n accDescr: How orders relate\n A ||--o{ B : x");
    assert!(titled.contains(r#"<text class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.contains(">Order example</tspan></text>"));
    assert!(titled.contains(r#"<title id="pele-title">Orders</title>"#));
    assert!(titled.contains(r#"<desc id="pele-desc">How orders relate</desc>"#));

    // Internal link.
    let linked = render(
        "erDiagram\n Note:::internal-link { string body }\n p[\"My page\"]:::internal-link",
        &css_options(),
    )
    .unwrap();
    assert!(linked.svg.contains(r#"<a class="internal-link" href="Note" rel="noopener" data-href="Note">"#));
    assert_eq!(
        linked.links,
        vec![
            LinkInfo {
                id: "Note".to_string(),
                href: "Note".to_string(),
                internal: true,
            },
            LinkInfo {
                id: "p".to_string(),
                href: "My page".to_string(),
                internal: true,
            },
        ]
    );

    // Uses only theme aliases for its own colors in CSS mode.
    let themed = svg_of("erDiagram\n A ||--o{ B : x\n A { int id PK \"c\" }\n subgraph g\n C\n end");
    let doc = roxmltree::Document::parse(&themed).unwrap();
    let re_theme_alias = Regex::new(r"^(?:none|var\(--_\w+\)|currentColor)$").unwrap();
    for node in doc.descendants().filter(|n| n.is_element()) {
        for attr in node.attributes() {
            if attr.name() == "fill" || attr.name() == "stroke" {
                assert!(
                    re_theme_alias.is_match(attr.value()),
                    "unexpected {}={} on <{}>",
                    attr.name(),
                    attr.value(),
                    node.tag_name().name()
                );
            }
        }
    }

    // Honors spacing and useMaxWidth in configuration.
    let tight = render("erDiagram\n A ||--o{ B : x", &css_options()).unwrap();
    let loose = render("---\nconfig:\n  er:\n    rankSpacing: 200\n---\nerDiagram\n A ||--o{ B : x", &css_options()).unwrap();
    assert!(loose.height > tight.height + 100.0);

    let fixed = render(
        "---\nconfig:\n  er:\n    useMaxWidth: false\n---\nerDiagram\n A ||--o{ B : x",
        &resolved_options(),
    )
    .unwrap();
    assert!(!fixed.svg.contains("max-width:100%"));
    assert_resvg_parses(&fixed.svg, "useMaxWidth false");

    // turn_to_fit turns narrow LR diagram into TB.
    let wide_chain = "erDiagram\n direction LR\n A ||--o{ B : first\n B ||--o{ C : second\n C ||--o{ D : third\n D ||--o{ E : fourth";
    let across = render(wide_chain, &css_options()).unwrap();
    let turned = render(
        wide_chain,
        &RenderOptions {
            max_width: Some(320.0),
            ..css_options()
        },
    )
    .unwrap();
    assert!(across.width > 320.0);
    assert!(turned.width < across.width);
    assert!(turned.height > across.height);

    // Math in ER entity alias, attribute comment, and relationship label (from `tests/render/math.test.ts`).
    let asked: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let asked_clone = Arc::clone(&asked);
    let math_fn = move |tex: &str, _size: f64| -> Option<MathSvg> {
        asked_clone.lock().unwrap().push(tex.to_string());
        Some(MathSvg {
            svg: format!(r#"<path d="M0,0H{}"/>"#, tex.len()),
            width: 30.0,
            height: 18.0,
        })
    };
    let math_src = "erDiagram\n  p[\"$$a$$\"] {\n    string name \"$$b$$\"\n  }\n  p ||--o{ q : \"$$c$$\"";
    let math_res = render(
        math_src,
        &RenderOptions {
            math: Some(&math_fn),
            ..css_options()
        },
    )
    .unwrap();
    let mut seen_tex = asked.lock().unwrap().clone();
    seen_tex.sort();
    assert_eq!(seen_tex, vec!["a", "b", "c"]);
    assert!(!math_res.svg.contains("$$"));
    assert_well_formed(&math_res.svg).unwrap();

    // Dark theme full ER diagram renders cleanly to resvg.
    let dark_src = "---\ntitle: Dark ER\n---\nerDiagram\n  subgraph G [Domain]\n    A ||--o{ B : owns\n    A { int id PK \"Primary\"\n string name \"Label\"\n float? score }\n  end\n  B ||..|{ C : links\n  C ||--o{ C : self\n  style G fill:#223344";
    let dark_res = render(dark_src, &dark_options()).unwrap();
    assert_inert_resolved(&dark_res.svg, "dark theme er");
    assert_resvg_parses(&dark_res.svg, "dark theme er");
    assert!(dark_res.svg.contains("#2a2a2a"));

    // Rejects what Mermaid rejects with PeleError.
    let err1 = render("erDiagram\n A ||--o{ B", &css_options()).unwrap_err();
    assert_eq!(err1.code, ErrorCode::Syntax);
    let err2 = render("erDiagram\n A { int }", &css_options()).unwrap_err();
    assert!(err2.message.contains("Expecting 'ATTRIBUTE_WORD'"), "msg={}", err2.message);
    let err3 = render("erDiagram\n style A fill:rgb(1,2,3)\n", &css_options()).unwrap_err();
    assert!(err3.message.contains("Lexical error"), "msg={}", err3.message);
    let err4 = render("erDiagram\n subgraph g\n A", &css_options()).unwrap_err();
    assert_eq!(err4.code, ErrorCode::Syntax);
}

#[test]
fn er_security_hostile_payloads_options_and_mutated_fuzz() {
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(|p| format!("erDiagram\n  {p}")),
        Box::new(|p| format!("erDiagram\n  \"{p}\"")),
        Box::new(|p| format!("erDiagram\n  \"{p}\" ||--o{{ B : has")),
        Box::new(|p| format!("erDiagram\n  A ||--o{{ \"{p}\" : has")),
        Box::new(|p| format!("erDiagram\n  A ||--o{{ B : {p}")),
        Box::new(|p| format!("erDiagram\n  A ||--o{{ B : \"{p}\"")),
        Box::new(|p| format!("erDiagram\n  A ||--o{{ A : \"{p}\"")),
        Box::new(|p| format!("erDiagram\n  A {p} B : has")),
        Box::new(|p| format!("erDiagram\n  A[{p}]")),
        Box::new(|p| format!("erDiagram\n  A[\"{p}\"] {{\n    string name\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    {p} name\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    string {p}\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    `{p}` `{p}`\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    {p}~{p}~ ~{p}~ PK \"c\"\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    string name PK \"{p}\"\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    string name {p}\n  }}")),
        Box::new(|p| format!("erDiagram\n  A {{\n    string name PK, {p}\n  }}")),
        Box::new(|p| format!("erDiagram\n  A:::{p}")),
        Box::new(|p| format!("erDiagram\n  A:::{p} ||--o{{ B:::{p} : has")),
        Box::new(|p| format!("erDiagram\n  A\n  class A {p}")),
        Box::new(|p| format!("erDiagram\n  A\n  class {p} x")),
        Box::new(|p| format!("erDiagram\n  A\n  classDef {p} fill:red\n  class A {p}")),
        Box::new(|p| format!("erDiagram\n  A\n  classDef c fill:{p}\n  class A c")),
        Box::new(|p| format!("erDiagram\n  A\n  classDef c {p}:red\n  class A c")),
        Box::new(|p| format!("erDiagram\n  A\n  classDef default fill:{p},color:{p},stroke:{p}\n")),
        Box::new(|p| format!("erDiagram\n  A\n  style A fill:{p}\n")),
        Box::new(|p| format!("erDiagram\n  A {{ int id }}\n  style A {p}:red\n")),
        Box::new(|p| format!("erDiagram\n  A {{ int id }}\n  style A color:{p},stroke:{p},font-family:{p},font-size:{p}\n")),
        Box::new(|p| format!("erDiagram\n  A\n  style {p} fill:red\n")),
        Box::new(|p| format!("erDiagram\n  subgraph {p}\n  A\n  end")),
        Box::new(|p| format!("erDiagram\n  subgraph \"{p}\"\n  A\n  end")),
        Box::new(|p| format!("erDiagram\n  subgraph s [{p}]\n  A\n  end")),
        Box::new(|p| format!("erDiagram\n  subgraph s [\"{p}\"]\n  A\n  end\n  s ||--|| B : \"{p}\"")),
        Box::new(|p| format!("erDiagram\n  subgraph s\n  A\n  end\n  style s fill:{p}\n  class s {p}")),
        Box::new(|p| format!("erDiagram\n  A[\"{p}\"]:::internal-link")),
        Box::new(|p| format!("erDiagram\n  \"{p}\":::internal-link")),
        Box::new(|p| format!("erDiagram\n  accTitle: {p}\n  accDescr: {p}\n  A")),
        Box::new(|p| format!("erDiagram\n  accDescr {{\n {p}\n }}\n  A")),
        Box::new(|p| format!("erDiagram\n  direction {p}\n  A")),
        Box::new(|p| format!("erDiagram\n  direction TB {p}\n  A")),
        Box::new(|p| format!("---\ntitle: \"{p}\"\nconfig:\n  er:\n    nodeSpacing: \"{p}\"\n    rankSpacing: \"{p}\"\n---\nerDiagram\n  A ||--|| B : x")),
        Box::new(|p| format!("---\ntitle: {p}\n---\nerDiagram\n  A")),
        Box::new(|p| format!("%%{{init: {{\"er\": {{\"layoutDirection\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nerDiagram\n  A")),
        Box::new(|p| format!("erDiagram {p}\n  A")),
        Box::new(|p| format!("erDiagram\n  %% {p}\n  A")),
    ];

    let mut rendered = 0usize;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            let src = tmpl(payload);
            if let Some(svg) = try_render_css(&src) {
                assert_inert(&svg, &src);
                rendered += 1;
            }
            if let Some(svg) = try_render_resolved(&src) {
                assert_inert_resolved(&svg, &src);
                assert_resvg_parses(&svg, &src);
            }
        }
    }
    assert!(rendered > 450, "expected >450 rendered security templates, got {rendered}");

    // Escapes what it shows.
    let esc_svg = svg_of("erDiagram\n  \"<img src=x onerror=alert(1)>\" {\n    `<script>` `a&b` PK \"</text><script>alert(1)</script>\"\n  }");
    assert!(!esc_svg.contains("<img"));
    assert!(!esc_svg.contains("<script"));
    assert!(esc_svg.contains("a&amp;b"));
    assert!(esc_svg.contains(r#"data-id="&lt;img src=x onerror=alert(1)&gt;""#));

    // Hostile option values.
    for &payload in PAYLOADS {
        let opts = RenderOptions {
            id_prefix: Some(payload.to_string()),
            font_family: Some(payload.to_string()),
            ..resolved_options()
        };
        let svg = render("erDiagram\n  accTitle: t\n  A ||--o{ B : x\n  A { int id }", &opts).unwrap().svg;
        assert_inert_resolved(&svg, payload);
        assert_resvg_parses(&svg, payload);
    }

    // Never gives an unsafe href to an internal link.
    let unsafe_link = render("erDiagram\n  \"javascript:alert(1)\":::internal-link", &css_options()).unwrap();
    assert!(unsafe_link.svg.contains(r#"<a class="internal-link" data-href="javascript:alert(1)">"#));
    assert_eq!(
        unsafe_link.links,
        vec![LinkInfo {
            id: "javascript:alert(1)".to_string(),
            href: "javascript:alert(1)".to_string(),
            internal: true,
        }]
    );

    // Prototype property names.
    for proto_src in [
        "erDiagram\n  __proto__ ||--o{ constructor : toString\n  __proto__ {\n    __proto__ __proto__ PK \"__proto__\"\n  }",
        "erDiagram\n  A\n  classDef __proto__ fill:red\n  class A __proto__\n  class __proto__ constructor\n  style __proto__ fill:red\n",
        "erDiagram\n  subgraph __proto__ [constructor]\n  hasOwnProperty\n  end\n  __proto__ ||--|| prototype : x",
    ] {
        let svg = render(proto_src, &resolved_options()).unwrap().svg;
        assert_inert_resolved(&svg, proto_src);
        assert_resvg_parses(&svg, proto_src);
    }

    // Mutated fuzzing over corpus.
    let corpus = load_fixture("er-corpus.json");
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"",
        "`",
        "~",
        "{",
        "}",
        "[",
        "]",
        "\n",
        ":::",
        " : ",
        "||--o{",
        "style A fill:",
        "classDef c ",
        "subgraph ",
        "end\n",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..1000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            if let Some(svg) = try_render_css(&src) {
                assert_inert(&svg, &src[..src.len().min(120)]);
            }
            if let Some(svg) = try_render_resolved(&src) {
                assert_inert_resolved(&svg, &src[..src.len().min(120)]);
                assert_resvg_parses(&svg, &src[..src.len().min(120)]);
            }
        }
    }
}

#[test]
fn er_stress_worst_cases_and_default_limit() {
    const N: usize = 50_000;
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big_render = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let repeat_fn = |count: usize, f: &dyn Fn(usize) -> String| -> String {
        let mut out = String::new();
        for i in 0..count {
            out.push_str(&f(i));
        }
        out
    };

    // Lexer stress cases.
    let lexer_cases: Vec<(&str, String)> = vec![
        ("long line mentioning direction", format!("erDiagram\n{}direction XX", "A ".repeat(N / 2))),
        ("one line of direction words", format!("erDiagram\n{}", "direction ".repeat(N / 10))),
        (
            "direction followed by blank lines",
            format!("erDiagram\n{}TB", format!("direction{}", "\n".repeat(9)).repeat(N / 18)),
        ),
        ("many lines mentioning direction", format!("erDiagram\n{}", "A direction B\n".repeat(N / 14))),
        ("direction after long spaces", format!("erDiagram\ndirection{}XX", " ".repeat(N))),
        (
            "accTitle with no colon",
            format!("erDiagram\n{}", format!("accTitle{}", " ".repeat(40)).repeat(N / 48)),
        ),
        (
            "ones followed by long spaces",
            format!("erDiagram\n{}!", format!("1{}", " ".repeat(99)).repeat(N / 100)),
        ),
        ("runs of cardinality symbols", format!("erDiagram\n{}", "|o}o}|o{|{||--..".repeat(N / 16))),
        ("unclosed quotes", format!("erDiagram\n{}", "\"a%".repeat(N / 3))),
        (
            "block of single tildes on one line",
            format!("erDiagram\nA {{\n{}~{}", "! ".repeat(N / 4), " !".repeat(N / 4)),
        ),
        ("block of unmatched chars before two tildes", format!("erDiagram\nA {{\n{}~~", "!".repeat(N))),
        ("block with tilde on every line", format!("erDiagram\nA {{\n{}}}", "a~ b\n".repeat(N / 5))),
        ("block of tilde pairs", format!("erDiagram\nA {{\n{}}}", "~a~ ".repeat(N / 4))),
        ("unclosed backtick in block", format!("erDiagram\nA {{\n`{}", "a ".repeat(N / 2))),
        ("block of backtick pairs", format!("erDiagram\nA {{\n{}}}", "`a``b` ".repeat(N / 7))),
        ("unclosed comment quotes in block", format!("erDiagram\nA {{\n{}", "a b \"".repeat(N / 5))),
        ("unclosed multi-line description", format!("erDiagram\naccDescr {{{}", " text\n".repeat(N / 6))),
    ];
    for (name, src) in &lexer_cases {
        let started = Instant::now();
        let toks = tokenize(src);
        assert!(!toks.types.is_empty(), "{name}");
        assert!(started.elapsed().as_millis() < 3000, "{name} took {:?}", started.elapsed());
    }

    // Parse-only stress cases.
    let parse_cases: Vec<(&str, String)> = vec![
        (
            "style statement of colons and hashes",
            format!("erDiagram\nA\nstyle A {}\n", ":#".repeat(N / 2)),
        ),
        (
            "style statement with 10,000 ids",
            format!("erDiagram\nstyle {}z fill:red\n", repeat_fn(10_000, &|i| format!("e{i},"))),
        ),
        (
            "class statement with 10,000 ids and classes",
            format!(
                "erDiagram\nclass {}z {}z\n",
                repeat_fn(10_000, &|i| format!("e{i},")),
                repeat_fn(10_000, &|i| format!("c{i},"))
            ),
        ),
        (
            "20,000 nested subgraphs",
            format!("erDiagram\n{}A\n{}", "subgraph s\n".repeat(20_000), "end\n".repeat(20_000)),
        ),
        (
            "one subgraph of 10,000 entities",
            format!("erDiagram\nsubgraph s\n{}end\n", repeat_fn(10_000, &|i| format!("n{i}\n"))),
        ),
        ("unclosed subgraphs", format!("erDiagram\n{}", "subgraph s\n".repeat(N / 11))),
    ];
    for (name, src) in &parse_cases {
        let started = Instant::now();
        let _ = parse(src, &big_parse);
        assert!(started.elapsed().as_millis() < 3000, "{name} took {:?}", started.elapsed());
    }

    // Generic type stress.
    let started = Instant::now();
    let _ = parse_generic_types(&format!("{}{}{}", "a~".repeat(N / 2), ",".repeat(1000), "~b".repeat(N / 2)));
    assert!(started.elapsed().as_millis() < 3000, "generic types stress took {:?}", started.elapsed());

    // Render stress cases.
    let mut complete_50 = String::from("erDiagram\n");
    for i in 0..50 {
        for j in (i + 1)..50 {
            complete_50.push_str(&format!("n{i} }}o--o{{ n{j} : r\n"));
        }
    }
    let render_cases: Vec<(&str, String)> = vec![
        (
            "style list of 10,000 declarations",
            format!("erDiagram\nA\nstyle A {}fill:red\n", repeat_fn(10_000, &|i| format!("x{i}:1,"))),
        ),
        (
            "20,000 class names on one entity",
            format!("erDiagram\nA:::{}z\n", repeat_fn(20_000, &|i| format!("c{i},"))),
        ),
        (
            "3,000 nested subgraphs rendered",
            format!(
                "erDiagram\n{}A ||--|| B : x\n{}",
                repeat_fn(3000, &|i| format!("subgraph s{i}\n")),
                "end\n".repeat(3000)
            ),
        ),
        (
            "5,000 sibling subgraphs",
            format!("erDiagram\n{}", repeat_fn(5000, &|i| format!("subgraph s{i}\nn{i}\nend\n"))),
        ),
        (
            "5,000 subgraphs listing same entities",
            format!("erDiagram\n{}", "subgraph s\nA\nB\nC\nend\n".repeat(5000)),
        ),
        (
            "entity with 5,000 attributes",
            format!("erDiagram\nA {{\n{}}}", repeat_fn(5000, &|i| format!("t{i} n{i}\n"))),
        ),
        (
            "attribute with 10,000 keys",
            format!("erDiagram\nA {{\n string id {}FK\n}}", "PK,".repeat(10_000)),
        ),
        (
            "5,000 attribute blocks for one entity",
            format!("erDiagram\n{}", repeat_fn(5000, &|i| format!("A {{ t n{i} }}\n"))),
        ),
        (
            "one 50,000 char comment",
            format!("erDiagram\nA {{\n string id \"{}\"\n}}", "word ".repeat(N / 5)),
        ),
        ("one 50,000 char attribute name", format!("erDiagram\nA {{\n string {}\n}}", "a".repeat(N))),
        ("attribute type of 50,000 tildes", format!("erDiagram\nA {{\n {} name\n}}", "~".repeat(N))),
        (
            "attribute type of tilde and comma pairs",
            format!("erDiagram\nA {{\n {} name\n}}", "a~b,".repeat(N / 4)),
        ),
        (
            "comment of emphasis markers",
            format!("erDiagram\nA {{\n string id \"{}\"\n}}", "*a _b ".repeat(N / 6)),
        ),
        (
            "entity name of entities and line breaks",
            format!("erDiagram\n\"{}\"", "#35;&amp;<br>".repeat(N / 13)),
        ),
        (
            "one 50,000 char relationship label",
            format!("erDiagram\nA ||--o{{ B : \"{}\"", "word ".repeat(N / 5)),
        ),
        ("5,000 entities", format!("erDiagram\n{}", repeat_fn(5000, &|i| format!("n{i}\n")))),
        (
            "chain of 5,000",
            format!("erDiagram\n{}", repeat_fn(5000, &|i| format!("n{i} ||--o{{ n{} : r\n", i + 1))),
        ),
        ("star of 5,000", format!("erDiagram\n{}", repeat_fn(5000, &|i| format!("c ||--o{{ n{i} : r\n")))),
        (
            "2,000 parallel and 2,000 self relationships",
            format!("erDiagram\n{}{}", "A ||--o{ B : r\n".repeat(2000), "A ||--|| A : s\n".repeat(2000)),
        ),
        ("complete graph of 50", complete_50),
        (
            "2,000 relationships between subgraphs",
            format!(
                "erDiagram\nsubgraph a\nA\nend\nsubgraph b\nB\nend\n{}",
                "a ||--|| b : r\nA ||--|| b : s\n".repeat(1000)
            ),
        ),
        ("alias repeated 10,000 times", format!("erDiagram\n{}", "a[\"Some Alias\"]\n".repeat(10_000))),
    ];
    for (name, src) in &render_cases {
        let started = Instant::now();
        let _ = render(src, &big_render);
        assert!(started.elapsed().as_millis() < 5000, "{name} took {:?}", started.elapsed());
    }

    // Default limit refusal.
    let err = render(&format!("erDiagram\n{}", "A ||--o{ B : r\n".repeat(5000)), &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("limit of 50000"), "msg={}", err.message);
}
