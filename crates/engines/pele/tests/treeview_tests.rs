mod support;

use std::cell::RefCell;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::treeview::NodeType;
use vibevalley_pele::{MonospacePart, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const TREE: &str = "treeView-beta\n    my-project/\n        src/\n            index.js\n        package.json\n    README.md\n";

fn check_both(src: &str) -> bool {
    let ok = match render(src, &css_options()) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };
    if let Ok(r) = render(src, &resolved_options()) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn treeview_renders_hierarchy_box_drawing_errors_icons_and_monospace() {
    let res = render(TREE, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::TreeView);
    assert!(supports(TREE));
    assert_eq!(Regex::new(r#"class="pele-node pele-tree-(dir|file)""#).unwrap().find_iter(&res.svg).count(), 5);
    assert_eq!(res.svg.matches(r#"class="pele-node pele-tree-dir""#).count(), 2);
    assert!(res.svg.contains(r#"font-weight="var(--_hw)" xml:space="preserve">my-project</text>"#));
    assert!(res.svg.contains(r#"xml:space="preserve">index.js</text>"#));
    assert_eq!(res.svg.matches(r#"<path d="M"#).count(), 2);
    assert!(!res.svg.contains(">/<"));

    let resolved = render(TREE, &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "treeview resolved");
    assert_resvg_parses(&resolved.svg, "treeview resolved");
    let dark = render(TREE, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "treeview dark");
    assert_resvg_parses(&dark.svg, "treeview dark");

    // Tree model equality between box-drawing and indented
    let boxed = parse(
        "treeView-beta\n├── src/\n│   ├── index.ts\n│   └── utils.ts\n├── package.json\n└── README.md\n",
        &ParseOptions::default(),
    )
    .unwrap();
    let indented = parse(
        "treeView-beta\n    src/\n        index.ts\n        utils.ts\n    package.json\n    README.md\n",
        &ParseOptions::default(),
    )
    .unwrap();
    match (&boxed.model, &indented.model) {
        (ParsedModel::TreeView(a), ParsedModel::TreeView(b)) => assert_eq!(a, b),
        _ => panic!("expected TreeView models"),
    }

    let model_res = parse(TREE, &ParseOptions::default()).unwrap();
    if let ParsedModel::TreeView(m) = model_res.model {
        let top: Vec<&str> = m.root.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(top, vec!["my-project", "README.md"]);
        let kids: Vec<(&str, NodeType)> = m.root.children[0].children.iter().map(|n| (n.name.as_str(), n.node_type)).collect();
        assert_eq!(kids, vec![("src", NodeType::Directory), ("package.json", NodeType::File)]);
        assert_eq!(m.count, 6);
    }

    // Box-drawing error line/column remapping against original lines
    let err_orig = render("treeView-beta\n│\n├── src/\n│\n│   └── \"a\n", &css_options()).unwrap_err();
    assert_eq!(err_orig.line, 5);
    assert!(err_orig.message.contains("line 5"), "err={err_orig}");

    assert!(
        render("treeView-beta\n├── \n", &css_options())
            .unwrap_err()
            .message
            .contains("Line 2: Empty node")
    );
    assert!(
        render("treeView-beta\n├── a\n   b\n", &css_options())
            .unwrap_err()
            .message
            .contains("Line 3: Unexpected indentation")
    );

    let err_fm = render("---\ntitle: T\n---\ntreeView-beta\n└─ \"bad", &css_options()).unwrap_err();
    assert_eq!(err_fm.line, 5);
    assert_eq!(err_fm.column, 4);
    assert_eq!(err_fm.snippet, "└─ \"bad\n---^");
    assert!(err_fm.message.starts_with("Lexical error on line 5."));

    assert!(
        render("---\ntitle: T\n---\ntreeView-beta\n├── \n", &css_options())
            .unwrap_err()
            .message
            .contains("Line 5: Empty node")
    );

    let err_tab1 = render("treeView-beta\n└─ \"ok\"\t\"bad", &css_options()).unwrap_err();
    assert_eq!((err_tab1.line, err_tab1.column), (2, 9));
    let err_tab2 = render("treeView-beta\n└── \"ok\"\t\t\"bad", &css_options()).unwrap_err();
    assert_eq!((err_tab2.line, err_tab2.column), (2, 11));
    assert_eq!(err_tab2.snippet, "└── \"ok\"\t\t\"bad\n----------^");

    let err_mix = render("---\ntitle: T\n---\ntreeView-beta\n\"bad\nhello ─ world\nx\ny", &css_options()).unwrap_err();
    assert_eq!((err_mix.line, err_mix.column), (5, 1));

    // Highlights, descriptions aligned, monospace files
    let hi = render(
        "treeView-beta\n    src/\n        App.tsx :::highlight ## main\n        index.js :::mine ## entry point\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(hi.matches(r#"class="pele-tree-highlight""#).count(), 1);
    assert!(hi.contains(r#"class="pele-node pele-tree-file highlight""#));
    assert!(hi.contains(r#"class="pele-node pele-tree-file mine""#));
    let re_dx = Regex::new(r#"class="pele-tree-description" x="([\d.]+)""#).unwrap();
    let xs: Vec<&str> = re_dx.captures_iter(&hi).map(|c| c.get(1).unwrap().as_str()).collect();
    assert_eq!(xs.len(), 2);
    assert_eq!(xs[0], xs[1]);

    let mono_src = "treeView-beta\n    src/\n        App.tsx ## main\n";
    let plain_m = render(mono_src, &css_options()).unwrap().svg;
    let mono_full = render(
        mono_src,
        &RenderOptions {
            monospace: vec![MonospacePart::Files],
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(
        Regex::new(r#"<text class="pele-label"[^>]* font-family="var\(--_fm\)""#)
            .unwrap()
            .find_iter(&mono_full)
            .count(),
        2
    );
    let dx_plain: f64 = re_dx.captures(&plain_m).unwrap()[1].parse().unwrap();
    let dx_mono: f64 = re_dx.captures(&mono_full).unwrap()[1].parse().unwrap();
    assert!(dx_mono > dx_plain);

    let mono_narrow = render(
        mono_src,
        &RenderOptions {
            max_width: Some(90.0),
            monospace: vec![MonospacePart::Files],
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(
        Regex::new(r#"<text class="pele-label"[^>]* font-family="var\(--_fm\)""#)
            .unwrap()
            .find_iter(&mono_narrow)
            .count(),
        3
    );

    // Icons + custom resolver + config mapping
    assert!(!res.svg.contains("pele-icon"));
    let shown = render(&format!("---\nconfig:\n  treeView:\n    showIcons: true\n---\n{TREE}"), &resolved_options())
        .unwrap()
        .svg;
    assert_eq!(shown.matches(r#"class="pele-icon""#).count(), 5);
    assert!(shown.contains(r#"data-icon="mermaid-treeview:folder""#));
    assert!(shown.contains(r#"data-icon="mermaid-treeview:file""#));
    assert_inert_resolved(&shown, "treeview icons");
    assert_resvg_parses(&shown, "treeview icons");

    let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let resolver = |name: &str| {
        asked.borrow_mut().push(name.to_string());
        (name == "logos:react").then(|| r#"<circle r="4"/>"#.to_string())
    };
    let custom = render(
        "treeView-beta\n  App.tsx icon(logos:react)\n  index.js\n  x.rs icon(rust)\n  y icon()\n",
        &RenderOptions {
            icons: Some(&resolver),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(*asked.borrow(), vec!["logos:react", "mermaid-treeview:rust"]);
    assert!(custom.contains(r#"data-icon="logos:react""#) && custom.contains(r#"<circle r="4"/>"#));
    assert_eq!(custom.matches(r#"class="pele-icon""#).count(), 2);

    let mapped = render(
        "---\nconfig:\n  treeView:\n    showIcons: true\n    defaultIconPack: material\n    filenameIcons:\n      Dockerfile: docker\n    extensionIcons:\n      .ts: typescript\n      txt: none\n---\ntreeView-beta\n  a.ts\n  Dockerfile\n  notes.txt\n  constructor\n  dir.ts/\n",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(mapped.contains(r#"data-icon="material:typescript""#));
    assert!(mapped.contains(r#"data-icon="material:docker""#));
    assert_eq!(mapped.matches(r#"data-icon="mermaid-treeview:file""#).count(), 1);
    assert_eq!(mapped.matches(r#"data-icon="mermaid-treeview:folder""#).count(), 1);
    assert_eq!(mapped.matches(r#"class="pele-icon""#).count(), 4);

    // Literal names & names starting with title & rejections
    let lit = render("treeView-beta\n  \"a  b   c\"\n  <T>.ts ## x <br> y\n  #35;hash\n", &css_options())
        .unwrap()
        .svg;
    assert!(
        lit.contains(">a  b   c</text>") && lit.contains(">&lt;T&gt;.ts</text>") && lit.contains(">x &lt;br&gt; y</text>") && lit.contains(">#hash</text>")
    );

    let tnames = render("treeView-beta\ntitles/\n├── title.txt\n└── title-page.md\n", &css_options())
        .unwrap()
        .svg;
    assert!(tnames.contains(">title.txt</text>") && !tnames.contains(">.txt</text>"));

    for bad in [
        "treeView-beta title x\n a",
        "treeView-beta\n a\ntitle late",
        "treeView-beta\n  \n  a",
        "treeView-beta\n :::x",
    ] {
        assert!(render(bad, &css_options()).is_err(), "expected error for {bad}");
    }
}

#[test]
fn treeview_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("treeview-corpus.json");
    assert!(corpus.len() >= 20);
    let mut corpus_ok = 0usize;
    for src in &corpus {
        if check_both(src) {
            corpus_ok += 1;
        }
    }
    assert!(corpus_ok > 10);

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let no_dq = p.replace(['"', '\\'], "");
        let no_sq = p.replace('\'', "");
        let templates = [
            format!("treeView-beta\n  {p}"),
            format!("treeView-beta\n  {p}/\n    child"),
            format!("treeView-beta\n  \"{p}\""),
            format!("treeView-beta\n  '{p}'"),
            format!("treeView-beta\n  a ## {p}"),
            format!("treeView-beta\n  a :::{p}"),
            format!("treeView-beta\n  a :::highlight ## {p}"),
            format!("treeView-beta\n  a icon({p})"),
            format!("treeView-beta\n  a icon(x:{p})"),
            format!("treeView-beta\ntitle {p}\n  a"),
            format!("treeView-beta\naccTitle: {p}\naccDescr: {p}\n  a"),
            format!("treeView-beta\naccDescr {{\n {p}\n}}\n  a"),
            format!("treeView-beta\n├── {p}\n│   └── {p} ## {p}\n└── x"),
            format!("---\ntitle: \"{no_dq}\"\n---\ntreeView-beta\n  a"),
            format!(
                "---\nconfig:\n  treeView:\n    showIcons: true\n    defaultIconPack: '{no_sq}'\n    filenameIcons:\n      a: '{no_sq}'\n    extensionIcons:\n      .b: '{no_sq}'\n---\ntreeView-beta\n  a\n  c.b\n  d icon(e)\n  {p}"
            ),
            format!(
                "---\nconfig:\n  treeView:\n    rowIndent: '{no_sq}'\n    paddingX: 1e999\n    paddingY: -5\n    lineThickness: .nan\n---\ntreeView-beta\n  a\n    b"
            ),
        ];
        for src in templates {
            if check_both(&src) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > PAYLOADS.len() * 8, "rendered={rendered}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[" :::", " icon(", " ## ", "\"", "'", "\n", "    ", "├── ", "/"]);
    let mut mutator = Mutator::new(&corpus, frags, 11);
    let mut fuzz_ok = 0usize;
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if check_both(&src) {
            fuzz_ok += 1;
        }
    }
    assert!(fuzz_ok > 300, "fuzz_ok={fuzz_ok}");
}

#[test]
fn treeview_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let head = "treeView-beta\n";
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let deep300: String = (0..300).map(|i| format!("{}d/\n", " ".repeat(i))).collect();
    let box_deep300: String = (0..300).map(|i| format!("{}├─ x\n", "│".repeat(i))).collect();
    let cases = [
        format!("{head}{}", "a\n".repeat(N / 2)),
        format!("{head}{deep300}"),
        format!("{head}{}", "a".repeat(N)),
        format!("{head}a{}b", " ".repeat(N)),
        format!("{head}{}1", format!("a :::{}", " ".repeat(95)).repeat(N / 100)),
        format!("{head}{}", "accDescr {\n".repeat(N / 11)),
        format!("{head}{}", format!("accDescr{}", "\n".repeat(40)).repeat(N / 48)),
        format!("{head}{}", "\"a\n".repeat(N / 3)),
        format!("{head}a{}", " :::highlight".repeat(N / 13)),
        format!("{head}{}", "├── a\n".repeat(N / 6)),
        format!("{head}{box_deep300}"),
        format!("{head}{}", "│   │   │\n".repeat(N / 10)),
        format!("{head}{}", "a ─ b\n".repeat(N / 6)),
    ];
    for (i, src) in cases.iter().enumerate() {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 2000, "slow treeview stress case #{i}: {:?}", started.elapsed());
    }
    let over = render(&format!("{head}{}", "a\n".repeat(30_000)), &css_options()).unwrap_err();
    assert!(over.message.contains("limit of 50000"));
}
