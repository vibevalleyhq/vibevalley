use std::collections::HashSet;

use serde_json::Value;

use super::*;

/// What VibeValley's own packages/pkm said (golden/gen.ts).
fn golden() -> Value {
    serde_json::from_str(include_str!("../golden/golden.json")).unwrap()
}

/// As JSON with absent fields left out, the way TypeScript writes them.
fn json<T: serde::Serialize>(value: &T) -> Value {
    fn strip(v: Value) -> Value {
        match v {
            Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, strip(v))).collect()),
            Value::Array(a) => Value::Array(a.into_iter().map(strip).collect()),
            v => v,
        }
    }
    strip(serde_json::to_value(value).unwrap())
}

fn counter() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("new-{n}")
    }
}

#[test]
fn pages_parse_print_and_link_as_vibevalley_does() {
    let g = golden();
    for case in g["pages"].as_array().unwrap() {
        let file = case["file"].as_str().unwrap();
        let page = parse(case["text"].as_str().unwrap(), file, 1);
        assert_eq!(json(&page), case["page"], "{file}");
        assert_eq!(print(&page.props, &page.blocks, &HashSet::new()), case["printed"].as_str().unwrap(), "{file}");
        let first: HashSet<String> = page.blocks.first().map(|b| b.id.clone()).into_iter().collect();
        assert_eq!(print(&page.props, &page.blocks, &first), case["printedRef"].as_str().unwrap(), "{file}");
        assert_eq!(json(&edges_of(&page.blocks)), case["edges"], "{file}");
    }
}

#[test]
fn ids_carry_over_an_edit() {
    let g = golden();
    let was = parse("- keep me\n- also me\n  - child\n", "00_Inbox/x.md", 1);
    let now = parse("- new first\n- keep me\n- also me\n  - child\n", "00_Inbox/x.md", 2);
    assert_eq!(json(&was), g["was"]);
    assert_eq!(json(&now), g["now"]);
    assert_eq!(json(&carry_ids(&was, &now)), g["carried"]);
}

#[test]
fn pasted_text_becomes_an_outline() {
    let mut new_id = counter();
    let nodes = outline_of("first line\n  - nested\n    deeper\nback out\n* starred", &mut new_id);
    assert_eq!(json(&nodes), golden()["captured"]);
}

#[test]
fn block_ops_match() {
    let g = golden();
    let base = parse("- a\n- b\n  - b1\n- c\n", "00_Inbox/ops.md", 1).blocks;
    assert_eq!(json(&base), g["base"]);
    // One counter across the cases, as the generator has.
    let mut new_id = counter();
    for case in g["ops"].as_array().unwrap() {
        let ops: Vec<BlockOp> = serde_json::from_value(case["ops"].clone()).unwrap();
        let result = apply_ops(&base, &ops, &mut new_id);
        assert_eq!(json(&result), case["result"], "{}", case["ops"]);
    }
}

#[test]
fn slugs_and_tags_match() {
    let g = golden();
    for pair in g["slugs"].as_array().unwrap() {
        assert_eq!(slug_of(pair[0].as_str().unwrap()), pair[1].as_str().unwrap());
    }
    for pair in g["tags"].as_array().unwrap() {
        assert_eq!(json(&tags_in(pair[0].as_str().unwrap())), pair[1]);
    }
}

#[test]
fn para_files() {
    assert_eq!(tier_of_file("01_Projects/VibeValley__Design.md"), Tier::Project);
    assert_eq!(title_of_file("01_Projects/VibeValley__Design.md"), "VibeValley/Design");
    assert_eq!(file_of(Tier::Project, "VibeValley/Design"), "01_Projects/VibeValley__Design.md");
    assert_eq!(journal_day("journals/2026_11_13.md").as_deref(), Some("2026-11-13"));
    assert_eq!(journal_day("00_Inbox/plain.md"), None);
}

mod graph_golden {
    use std::collections::HashMap;

    use serde_json::Value;

    use super::json;
    use crate::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../golden/graph.json")).unwrap()
    }

    fn vault(g: &Value) -> Vec<Page> {
        g["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| parse(f[1].as_str().unwrap(), f[0].as_str().unwrap(), f[2].as_i64().unwrap()))
            .collect()
    }

    /// Numbers by value: TypeScript writes a whole score as 6, serde as 6.0.
    fn by_value(v: Value) -> Value {
        match v {
            Value::Number(n) => serde_json::json!(n.as_f64()),
            Value::Array(a) => Value::Array(a.into_iter().map(by_value).collect()),
            Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (k, by_value(v))).collect()),
            v => v,
        }
    }

    fn pairs(v: &Value) -> Vec<(Value, Value)> {
        v.as_array().unwrap().iter().map(|p| (p[0].clone(), p[1].clone())).collect()
    }

    #[test]
    fn lookups_and_summaries() {
        let g = golden();
        let v = vault(&g);
        for (name, slug) in pairs(&g["pageOf"]) {
            assert_eq!(json(&page_of(&v, name.as_str().unwrap()).map(|p| &p.slug)), slug, "{name}");
        }
        for (id, want) in pairs(&g["blockOf"]) {
            let got = block_of(&v, id.as_str().unwrap()).map(|at| serde_json::json!({ "page": at.page.slug, "block": at.block }));
            assert_eq!(json(&got), want, "{id}");
        }
        let mut refs: Vec<String> = refs_into(&v).into_iter().collect();
        refs.sort();
        assert_eq!(json(&refs), g["refsInto"]);
        assert_eq!(json(&v.iter().map(summary_of).collect::<Vec<_>>()), g["summaries"]);
        assert_eq!(json(&v.iter().map(wire_of).collect::<Vec<_>>()), g["wire"]);
        assert_eq!(json(&v.iter().map(|p| flat_blocks(&p.blocks)).collect::<Vec<_>>()), g["flat"]);
        assert_eq!(g["clipOf"][0][1], "clip");
        assert_eq!(clip_of(&v, "https://example.com/gpu").map(|p| p.slug.as_str()), Some("clip"));
        assert!(clip_of(&v, "https://none").is_none());
    }

    #[test]
    fn links_between_pages() {
        let g = golden();
        let v = vault(&g);
        let circular = |id: &str| format!("(循环 {})", &id[..4]);
        let broken = |id: &str| format!("(断了 {})", &id[..4]);
        let words = RefWords {
            circular: &circular,
            broken: &broken,
        };
        let shown = vec![("x".to_string(), "shown ((6a1b2c3d-0000-4000-a000-000000000002))".to_string())];
        for (page, (slug, want)) in v.iter().zip(pairs(&g["transclusions"])) {
            assert_eq!(json(&transclusions(&v, page, &words, &shown)), want, "{slug}");
        }
        for (slug, want) in pairs(&g["backlinks"]) {
            assert_eq!(json(&backlinks(&v, slug.as_str().unwrap())), want, "{slug}");
        }
        for (page, (slug, want)) in v.iter().zip(pairs(&g["renamed"])) {
            assert_eq!(json(&rename_links(page, "vibevalley/design", "VibeValley/Plan")), want, "{slug}");
        }
        let kept = [("a [[X]] and ((6a1b2c3d-0000-4000-a000-000000000001))", "a rewrite"), ("[[ Y ]]", "has [[Y]]")];
        assert_eq!(json(&kept.iter().map(|(o, p)| keep_links(o, p)).collect::<Vec<_>>()), g["keepLinks"]);
        for (topic, want) in pairs(&g["clustered"]) {
            let got: Vec<(String, String)> = clustered(&v, topic.as_str().unwrap())
                .into_iter()
                .map(|(p, n)| (p.slug.clone(), n.id.clone()))
                .collect();
            assert_eq!(json(&got), want, "{topic}");
        }
    }

    #[test]
    fn plain_words_and_search() {
        let g = golden();
        let v = vault(&g);
        for (text, want) in pairs(&g["plainOf"]) {
            assert_eq!(plain_of(&v, text.as_str().unwrap()), want.as_str().unwrap(), "{text}");
        }
        for (text, want) in pairs(&g["plainText"]) {
            assert_eq!(plain_text(text.as_str().unwrap()), want.as_str().unwrap(), "{text}");
        }
        for (text, want) in pairs(&g["queryWords"]) {
            assert_eq!(json(&query_words(text.as_str().unwrap(), &default_tokenize)), want, "{text}");
        }
        for (req, want) in pairs(&g["search"]) {
            let request: SearchRequest = serde_json::from_value(req.clone()).unwrap();
            assert_eq!(by_value(json(&search(&v, &request, None, &default_tokenize))), by_value(want), "{req}");
        }
        let ranked = HashMap::from([
            ("6a1b2c3d-0000-4000-a000-000000000001".to_string(), 3.0),
            ("6a1b2c3d-0000-4000-a000-000000000002".to_string(), 1.0),
        ]);
        let req = SearchRequest {
            text: Some("anything".into()),
            ..Default::default()
        };
        assert_eq!(
            by_value(json(&search(&v, &req, Some(&ranked), &default_tokenize))),
            by_value(g["ranked"].clone())
        );
    }

    #[test]
    fn radar_and_export() {
        let g = golden();
        let v = vault(&g);
        // 2026-11-13 12:00 UTC, as the generator's Date.UTC(2026, 10, 13, 12).
        assert_eq!(json(&radar(&v, 1_794_571_200_000, 7)), g["radar"]);
        for (page, (slug, want)) in v.iter().zip(pairs(&g["export"])) {
            assert_eq!(export_markdown(&v, page, &|t| format!("> {t}")), want.as_str().unwrap(), "{slug}");
        }
    }
}

#[test]
fn journal_titles() {
    let at = jiff::civil::date(2026, 11, 3)
        .at(10, 0, 0, 0)
        .to_zoned_datetime(jiff::tz::TimeZone::system())
        .unwrap()
        .timestamp()
        .as_millisecond();
    assert_eq!(journal_title(at), "2026_11_03");
    assert_eq!(day_of(at), "2026-11-03");
    assert_eq!(journal_title_of("2026-11-03"), "2026_11_03");
}
