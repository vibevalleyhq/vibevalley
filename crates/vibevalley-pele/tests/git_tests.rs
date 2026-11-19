mod support;

use std::collections::HashSet;
use std::time::Instant;

use regex::Regex;
use roxmltree::Document;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::git::{
    BranchDb, CherryPickDb, CommitDb, CommitType, CommitTypeName, GitDbParseProvider, GitDirection, GitGraphAst, MergeDb, StatementAst, parse_git,
    parse_statement, populate,
};
use vibevalley_pele::{ErrorCode, ParseOptions, ParsedModel, PeleError, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const FLOW: &str = r#"
  commit id: "init"
  commit type: REVERSE tag: "v0.1"
  branch develop
  commit id: "feat" msg: "A message"
  commit type: HIGHLIGHT
  checkout main
  commit tag: "v0.2" tag: "stable"
  merge develop id: "merged" tag: "v1.0"
  branch hotfix
  commit id: "fix"
  checkout develop
  commit
  cherry-pick id: "fix"
  checkout main
  merge hotfix
"#;

fn with_config(yaml: &str, body: &str) -> String {
    format!("---\nconfig:\n  gitGraph:\n{yaml}\n---\n{body}")
}

fn count_sub(svg: &str, needle: &str) -> usize {
    svg.matches(needle).count()
}

fn commit_centers(svg: &str) -> Vec<(f64, f64)> {
    let re_circle = Regex::new(r#"<circle cx="([-\d.]+)" cy="([-\d.]+)""#).unwrap();
    let re_rect = Regex::new(r#"^[^>]*>(?:<title>[^<]*</title>)?<rect x="([-\d.]+)" y="([-\d.]+)""#).unwrap();
    let mut out = Vec::new();
    for group in svg.split(r#"<g class="pele-commit "#).skip(1) {
        if let Some(cap) = re_rect.captures(group) {
            out.push((cap[1].parse::<f64>().unwrap() + 8.0, cap[2].parse::<f64>().unwrap() + 8.0));
        } else if let Some(cap) = re_circle.captures(group) {
            out.push((cap[1].parse().unwrap(), cap[2].parse().unwrap()));
        }
    }
    out
}

fn check_both_modes(src: &str) -> bool {
    let css = match render(src, &css_options()) {
        Ok(r) => r.svg,
        Err(_) => return false,
    };
    let ctx: String = src.chars().take(160).collect();
    assert_inert(&css, &ctx);
    assert!(!css.contains("NaN") && !css.contains("Infinity"), "non-finite coord in {ctx}");

    let resolved = render(src, &resolved_options()).expect("resolved render should succeed when css succeeded");
    assert_inert_resolved(&resolved.svg, &ctx);
    assert_resvg_parses(&resolved.svg, &ctx);
    true
}

#[test]
fn git_draws_lanes_symbols_labels_tags_edges_and_directions() {
    let src = format!("gitGraph\n{FLOW}");
    let res = render(&src, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::GitGraph);
    assert!(supports("gitGraph\n commit"));
    assert!(res.svg.contains(r#"class="pele pele-gitGraph""#));
    assert_eq!(count_sub(&res.svg, r#"class="pele-branch""#), 3);
    assert_eq!(count_sub(&res.svg, r#"class="pele-lane""#), 3);
    assert_eq!(count_sub(&res.svg, r#"<g class="pele-commit "#), 10);
    assert!(res.svg.contains(r#"data-id="develop""#));
    assert!(res.svg.contains(">hotfix<"));
    for k in [1, 2, 3] {
        assert!(res.svg.contains(&format!("var(--pele-series-{k},")));
    }

    // Commit types
    assert_eq!(count_sub(&res.svg, r#"pele-commit-normal""#), 5);
    assert_eq!(count_sub(&res.svg, r#"pele-commit-reverse""#), 1);
    assert_eq!(count_sub(&res.svg, r#"pele-commit-highlight""#), 1);
    assert_eq!(count_sub(&res.svg, r#"pele-commit-merge""#), 2);
    assert_eq!(count_sub(&res.svg, r#"pele-commit-cherry-pick""#), 1);
    let highlight = res.svg.split(r#"pele-commit-highlight""#).nth(1).unwrap().split("</g>").next().unwrap();
    assert!(highlight.contains("<rect"));
    let merge = res.svg.split(r#"pele-commit-merge""#).nth(1).unwrap().split("</g>").next().unwrap();
    assert_eq!(count_sub(merge, "<circle"), 2);

    // Merge with custom type still marked as merge
    let merge_rev = render(
        "gitGraph\n commit\n branch b\n commit\n checkout main\n commit\n merge b type: REVERSE",
        &css_options(),
    )
    .unwrap();
    assert!(merge_rev.svg.contains(r#"class="pele-commit pele-commit-reverse pele-commit-merge""#));

    // Labels + showCommitLabel
    assert!(res.svg.contains(">init<"));
    assert!(res.svg.contains(">merged<"));
    assert_eq!(count_sub(&res.svg, r#"class="pele-commit-label""#), 8);
    assert_eq!(count_sub(&res.svg, "rotate(-45 "), 8);
    let hidden = render(&with_config("    showCommitLabel: false", &src), &css_options()).unwrap().svg;
    assert!(!hidden.contains("pele-commit-label"));
    assert!(hidden.contains(">v0.1<"));

    // rotateCommitLabel: false
    let long_src = "gitGraph\n commit id: \"a rather long commit id\"\n commit id: \"another long commit id\"\n commit";
    let rotated = render(long_src, &css_options()).unwrap();
    let level = render(&with_config("    rotateCommitLabel: false", long_src), &css_options()).unwrap();
    assert!(!level.svg.contains("rotate("));
    assert!(level.width > rotated.width);
    assert!(level.height < rotated.height);

    // Tags + cherry-pick default tag + empty tag omitted
    assert_eq!(count_sub(&res.svg, r#"class="pele-tag""#), 5);
    assert!(res.svg.contains(">cherry-pick:fix<"));
    let none = render(
        "gitGraph\n commit id:\"a\" tag:\"\"\n branch b\n commit id:\"c\"\n checkout main\n commit\n cherry-pick id:\"c\" tag:\"\"",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(!none.contains("pele-tag"));

    // Edges: straight, curved merge, dashed cherry-pick
    assert_eq!(count_sub(&res.svg, r#"class="pele-edge""#), 9);
    assert_eq!(count_sub(&res.svg, r#"class="pele-edge pele-edge-merge""#), 2);
    assert_eq!(count_sub(&res.svg, r#"class="pele-edge pele-edge-cherry-pick""#), 1);
    let cherry = res.svg.split(r#"pele-edge-cherry-pick""#).nth(1).unwrap().split("/>").next().unwrap();
    assert!(cherry.contains("stroke-dasharray"));
    let merge_edge = res.svg.split(r#"pele-edge-merge""#).nth(1).unwrap().split("/>").next().unwrap();
    assert!(Regex::new(r#"d="M[^"]*C[^"]*""#).unwrap().is_match(merge_edge));
    assert!(merge_edge.contains("var(--pele-series-2,"));

    // Plain text escaping, entities, <br>, tooltip
    let lit = render(
        "gitGraph\n commit id:\"add <Button> #35;1\" tag:\"<i>t</i>\"\n branch \"one<br>two\"\n commit id:\"**a**\"",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(lit.contains(">add &lt;Button&gt; #1<"));
    assert!(lit.contains(">&lt;i&gt;t&lt;/i&gt;<"));
    assert!(lit.contains(">**a**<"));
    assert!(Regex::new(r"<tspan[^>]*>one</tspan><tspan[^>]*>two</tspan>").unwrap().is_match(&lit));
    assert!(lit.contains(r#"data-id="add &lt;Button&gt; #1""#));
    assert!(
        render("gitGraph\n commit id:\"a\" msg:\"Fix <the> bug\"", &css_options())
            .unwrap()
            .svg
            .contains("<title>Fix &lt;the&gt; bug</title>")
    );

    // LR, TB, BT directions
    let body = "\n commit\n commit\n branch b\n commit\n commit\n checkout main\n commit";
    let lr = render(&format!("gitGraph{body}"), &css_options()).unwrap();
    let tb = render(&format!("gitGraph TB:{body}"), &css_options()).unwrap();
    let bt = render(&format!("gitGraph BT:{body}"), &css_options()).unwrap();
    let (l, t, b) = (commit_centers(&lr.svg), commit_centers(&tb.svg), commit_centers(&bt.svg));
    assert_eq!(l.len(), 5);
    assert!(l[1].0 > l[0].0 && l[1].1 == l[0].1 && l[2].1 > l[0].1);
    assert!(t[1].1 > t[0].1 && t[1].0 == t[0].0 && t[2].0 > t[0].0);
    assert!(b[1].1 < b[0].1 && b[2].0 > b[0].0);
    assert!(tb.height > tb.width);
    assert_eq!(bt.height, tb.height);
    assert!(bt.svg.contains("rotate(45 "));

    // parallelCommits
    let p_src = "gitGraph\n commit\n branch develop\n commit\n commit\n checkout main\n commit\n commit";
    let serial = render(p_src, &css_options()).unwrap();
    let parallel = render(&with_config("    parallelCommits: true", p_src), &css_options()).unwrap();
    assert!(parallel.width < serial.width);
    let centers = commit_centers(&parallel.svg);
    assert_eq!(centers[3].0, centers[1].0);
    assert_eq!(centers[4].0, centers[2].0);

    // showBranches: false
    let no_br = render(&with_config("    showBranches: false", &src), &css_options()).unwrap().svg;
    assert!(!no_br.contains("pele-branch"));
    assert!(!no_br.contains(">develop<"));
    assert_eq!(count_sub(&no_br, r#"<g class="pele-commit "#), 10);

    // Light + dark resolved + resvg across all modes
    for header in ["gitGraph", "gitGraph TB:", "gitGraph BT:"] {
        for cfg in ["    parallelCommits: true", "    rotateCommitLabel: false", "    showBranches: false"] {
            let s = with_config(cfg, &format!("{header}\n{FLOW}"));
            let r_css = render(&s, &css_options()).unwrap();
            assert!(r_css.width.is_finite() && r_css.height.is_finite());
            assert!(!r_css.svg.contains("NaN") && !r_css.svg.contains("Infinity") && !r_css.svg.contains("undefined"));
            let doc = Document::parse(&r_css.svg).unwrap();
            for el in doc.descendants().filter(|n| n.is_element()) {
                for a in el.attributes() {
                    if matches!(a.name(), "cx" | "cy" | "x" | "y") {
                        assert!(a.value().parse::<f64>().unwrap().is_finite(), "non-finite {}", a.name());
                    }
                }
            }
            let r_light = render(&s, &resolved_options()).unwrap();
            assert_inert_resolved(&r_light.svg, &s[..40]);
            assert_resvg_parses(&r_light.svg, &s[..40]);
            let r_dark = render(&s, &dark_options()).unwrap();
            assert_inert_resolved(&r_dark.svg, &s[..40]);
            assert_resvg_parses(&r_dark.svg, &s[..40]);
        }
    }
}

#[test]
fn git_config_titles_ids_warnings_empty_and_semantic_errors() {
    // mainBranchName / mainBranchOrder / branch order
    let ord_src = "gitGraph\n commit\n branch b1\n commit\n branch b2 order: 3\n commit\n branch b3 order: 1\n commit";
    let cfg_src = with_config("    mainBranchName: trunk\n    mainBranchOrder: 2", ord_src);
    let ParsedModel::GitGraph(m) = parse(&cfg_src, &ParseOptions::default()).unwrap().model else {
        panic!("expected gitGraph");
    };
    assert_eq!(m.lanes, vec!["b1", "b3", "trunk", "b2"]);
    let ord_svg = render(&cfg_src, &css_options()).unwrap().svg;
    assert!(ord_svg.find(r#"data-id="b3""#).unwrap() < ord_svg.find(r#"data-id="trunk""#).unwrap());
    assert!(render(r#"%%{init: {"gitGraph": {"mainBranchName": "dev"}}}%%"#.to_string().as_str(), &css_options()).is_err());
    assert!(
        render("%%{init: {\"gitGraph\": {\"mainBranchName\": \"dev\"}}}%%\ngitGraph\n commit", &css_options())
            .unwrap()
            .svg
            .contains(">dev<")
    );

    // Branch names starting with title
    let ParsedModel::GitGraph(mt) = parse(
        "gitGraph\n commit\n branch titles\n commit\n branch title/x\n commit\n checkout main\n merge titles\n branch title-2.0\n",
        &ParseOptions::default(),
    )
    .unwrap()
    .model
    else {
        panic!("expected gitGraph");
    };
    assert_eq!(mt.lanes, vec!["main", "titles", "title/x", "title-2.0"]);
    assert_eq!(mt.title, None);
    assert!(parse("gitGraph\n commit\n branch title.v2\n checkout title.v2", &ParseOptions::default()).is_ok());

    // Front matter vs own title + accessibility
    assert!(
        render("---\ntitle: From front matter\n---\ngitGraph\n commit", &css_options())
            .unwrap()
            .svg
            .contains("From front matter")
    );
    let own = render("---\ntitle: From front matter\n---\ngitGraph\n title Own\n commit", &css_options())
        .unwrap()
        .svg;
    assert!(own.contains(">Own<") && !own.contains("From front matter"));
    let acc = render("gitGraph\n accTitle: History\n accDescr: Two branches\n commit", &css_options())
        .unwrap()
        .svg;
    assert!(acc.contains(r#"<title id="pele-title">History</title>"#));
    assert!(acc.contains(r#"<desc id="pele-desc">Two branches</desc>"#));

    // Deterministic Mermaid-shaped commit ids
    let id_src = "gitGraph\n commit\n commit\n branch b\n commit\n checkout main\n commit\n merge b";
    let ParsedModel::GitGraph(mi) = parse(id_src, &ParseOptions::default()).unwrap().model else {
        panic!("expected gitGraph");
    };
    let ids: Vec<String> = mi.commits.keys().cloned().collect();
    assert_eq!(ids.len(), 5);
    for (seq, id) in ids.iter().enumerate() {
        let re = Regex::new(&format!("^{seq}-[0-9a-f]{{7}}$")).unwrap();
        assert!(re.is_match(id), "bad generated id {id}");
    }
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 5);
    assert_eq!(render(id_src, &css_options()).unwrap().svg, render(id_src, &css_options()).unwrap().svg);

    // Generated id never replaces existing commit with same id
    let ParsedModel::GitGraph(m1) = parse("gitGraph\n commit", &ParseOptions::default()).unwrap().model else {
        panic!("expected gitGraph");
    };
    let first_id = m1.commits.keys().next().unwrap();
    let taken = format!("1{}", &first_id[1..]);
    let ParsedModel::GitGraph(m2) = parse(&format!("gitGraph\n commit id:\"{taken}\"\n commit"), &ParseOptions::default())
        .unwrap()
        .model
    else {
        panic!("expected gitGraph");
    };
    assert_eq!(m2.commits.len(), 2);
    assert!(m2.warnings.is_empty());

    // Duplicate commit id replaces earlier with warning
    let ParsedModel::GitGraph(mdup) = parse("gitGraph\n commit id:\"a\"\n commit id:\"b\"\n commit id:\"a\"", &ParseOptions::default())
        .unwrap()
        .model
    else {
        panic!("expected gitGraph");
    };
    assert_eq!(mdup.commits.keys().map(String::as_str).collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(mdup.commits.get("a").unwrap().seq, 2);
    assert_eq!(mdup.warnings, vec!["Commit ID a already exists"]);
    assert!(
        render("gitGraph\n commit id:\"a\"\n commit id:\"a\"\n branch b\n commit id:\"a\"", &css_options())
            .unwrap()
            .svg
            .contains("pele-commit")
    );

    // Empty / only branches
    assert!(render("gitGraph", &css_options()).unwrap().svg.contains(">main<"));
    let only_br = render("gitGraph\n branch a\n branch \"b c\"", &css_options()).unwrap().svg;
    assert_eq!(count_sub(&only_br, r#"class="pele-branch""#), 3);
    assert!(only_br.contains(">b c<") && !only_br.contains("NaN"));

    // All 15 Mermaid semantic error messages verbatim
    let errors: &[(&str, &str)] = &[
        (
            "gitGraph\n commit\n branch main",
            r#"Trying to create an existing branch. (Help: Either use a new name if you want create a new branch or try using "checkout main")"#,
        ),
        (
            "gitGraph\n commit\n checkout nope",
            r#"Trying to checkout branch which is not yet created. (Help try using "branch nope")"#,
        ),
        (
            "gitGraph\n commit\n branch b\n merge b",
            r#"Incorrect usage of "merge". Cannot merge a branch to itself"#,
        ),
        ("gitGraph\n commit\n branch b\n merge main", "Cannot merge branch 'main' into itself."),
        ("gitGraph\n merge b", r#"Incorrect usage of "merge". Current branch (main)has no commits"#),
        (
            "gitGraph\n commit\n merge b",
            r#"Incorrect usage of "merge". Branch to be merged (b) does not exist"#,
        ),
        (
            "gitGraph\n branch b\n checkout main\n commit\n merge b",
            r#"Incorrect usage of "merge". Branch to be merged (b) has no commits"#,
        ),
        (
            "gitGraph\n commit\n branch b\n checkout main\n merge b",
            r#"Incorrect usage of "merge". Both branches have same head"#,
        ),
        (
            "gitGraph\n commit id:\"a\"\n branch b\n commit\n checkout main\n commit\n merge b id:\"a\"",
            r#"Incorrect usage of "merge". Commit with id:a already exists, use different custom id"#,
        ),
        (
            "gitGraph\n commit\n cherry-pick id:\"nope\"",
            r#"Incorrect usage of "cherryPick". Source commit id should exist and provided"#,
        ),
        (
            "gitGraph\n commit\n cherry-pick",
            r#"Incorrect usage of "cherryPick". Source commit id should exist and provided"#,
        ),
        (
            "gitGraph\n commit id:\"a\"\n cherry-pick id:\"a\"",
            r#"Incorrect usage of "cherryPick". Source commit is already on current branch"#,
        ),
        (
            "gitGraph\n branch b\n commit id:\"a\"\n checkout main\n cherry-pick id:\"a\"",
            r#"Incorrect usage of "cherry-pick". Current branch (main)has no commits"#,
        ),
        (
            "gitGraph\n commit id:\"z\"\n branch b\n commit id:\"a\"\n checkout main\n commit\n cherry-pick id:\"a\" parent:\"q\"",
            "Invalid operation: The specified parent commit is not an immediate parent of the cherry-picked commit.",
        ),
        (
            "gitGraph\n commit\n branch b\n commit\n checkout main\n commit\n merge b id:\"m\"\n checkout b\n cherry-pick id:\"m\"",
            "Incorrect usage of cherry-pick: If the source commit is a merge commit, an immediate parent commit must be specified.",
        ),
    ];
    for &(src, expected_msg) in errors {
        let err = render(src, &css_options()).unwrap_err();
        assert_eq!(err.message, expected_msg, "for {src}");
        assert_eq!(err.code, ErrorCode::Semantic, "for {src}");
    }
}

#[test]
fn git_populate_and_parser_compat() {
    #[derive(Default)]
    struct MockDb {
        dir: Option<GitDirection>,
        commits: Vec<CommitDb>,
        branches: Vec<BranchDb>,
        merges: Vec<MergeDb>,
        picks: Vec<CherryPickDb>,
        checkouts: Vec<String>,
    }
    impl GitDbParseProvider for MockDb {
        fn set_direction(&mut self, dir: GitDirection) {
            self.dir = Some(dir);
        }
        fn commit(&mut self, c: CommitDb) -> Result<(), PeleError> {
            self.commits.push(c);
            Ok(())
        }
        fn branch(&mut self, b: BranchDb) -> Result<(), PeleError> {
            self.branches.push(b);
            Ok(())
        }
        fn merge(&mut self, m: MergeDb) -> Result<(), PeleError> {
            self.merges.push(m);
            Ok(())
        }
        fn cherry_pick(&mut self, c: CherryPickDb) -> Result<(), PeleError> {
            self.picks.push(c);
            Ok(())
        }
        fn checkout(&mut self, branch: &str) -> Result<(), PeleError> {
            self.checkouts.push(branch.to_string());
            Ok(())
        }
    }

    let mut db = MockDb::default();
    parse_statement(
        &StatementAst::Commit {
            id: Some("1".to_string()),
            message: Some("test".to_string()),
            tags: vec!["tag1".to_string(), "tag2".to_string()],
            commit_type: Some(CommitTypeName::Normal),
        },
        &mut db,
    )
    .unwrap();
    assert_eq!(
        db.commits[0],
        CommitDb {
            id: Some("1".to_string()),
            msg: "test".to_string(),
            tags: Some(vec!["tag1".to_string(), "tag2".to_string()]),
            commit_type: CommitType::Normal,
        }
    );

    let ast = GitGraphAst {
        dir: Some(GitDirection::Tb),
        title: None,
        acc_title: None,
        acc_descr: None,
        statements: vec![
            StatementAst::Commit {
                id: Some("1".to_string()),
                message: Some("test".to_string()),
                tags: vec!["tag1".to_string(), "tag2".to_string()],
                commit_type: Some(CommitTypeName::Normal),
            },
            StatementAst::Branch {
                name: "newBranch".to_string(),
                order: Some(1.0),
            },
            StatementAst::Merge {
                branch: "newBranch".to_string(),
                id: Some("1".to_string()),
                tags: vec!["tag1".to_string(), "tag2".to_string()],
                commit_type: Some(CommitTypeName::Normal),
            },
            StatementAst::Checkout {
                branch: "newBranch".to_string(),
            },
            StatementAst::CherryPicking {
                id: Some("1".to_string()),
                tags: vec!["tag1".to_string(), "tag2".to_string()],
                parent: Some("2".to_string()),
            },
        ],
    };
    let mut db2 = MockDb::default();
    populate(&ast, &mut db2).unwrap();
    assert_eq!(db2.dir, Some(GitDirection::Tb));
    assert_eq!(db2.commits.len(), 1);
    assert_eq!(
        db2.branches[0],
        BranchDb {
            name: "newBranch".to_string(),
            order: Some(1.0)
        }
    );
    assert_eq!(db2.merges[0].branch, "newBranch");
    assert_eq!(db2.checkouts, vec!["newBranch"]);
    assert_eq!(db2.picks[0].parent.as_deref(), Some("2"));

    // Parser compat
    let complex = parse_git(
        "gitGraph TB:\n accTitle: Complex Example\n commit id:\"init\" type:NORMAL\n branch feature\n commit id:\"feat1\" msg:\"Add feature\"\n checkout main\n merge feature tag:\"v1.0\"\n cherry-pick id:\"feat1\" tag:\"critical fix\"\n",
        None,
    )
    .unwrap();
    assert_eq!(complex.acc_title.as_deref(), Some("Complex Example"));
    assert_eq!(complex.statements.len(), 6);
}

#[test]
fn git_security_corpus_payloads_and_mutated_fuzz() {
    let quoted = |p: &str| -> [String; 3] {
        [
            format!("\"{p}\""),
            format!("'{p}'"),
            format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\"")),
        ]
    };
    let templates: Vec<fn(&str, &str) -> String> = vec![
        |q, _| format!("gitGraph\n commit id: {q}"),
        |q, _| format!("gitGraph\n commit id: {q} msg: {q} tag: {q} tag: {q} type: HIGHLIGHT"),
        |q, _| format!("gitGraph\n commit {q}"),
        |q, _| format!("gitGraph\n commit\n branch {q}\n commit\n checkout {q}\n commit"),
        |q, _| format!("gitGraph\n commit\n branch {q} order: 2\n commit\n switch main\n commit\n merge {q} id: {q} tag: {q} type: REVERSE"),
        |q, _| format!("gitGraph\n commit id: {q}\n branch b\n commit\n cherry-pick id: {q}"),
        |q, _| format!("gitGraph\n commit id: \"a\"\n branch b\n commit id: \"c\"\n checkout main\n commit\n cherry-pick id: \"c\" tag: {q}"),
        |q, _| {
            format!(
                "gitGraph\n commit id:\"z\"\n branch b\n commit id:\"a\"\n checkout main\n commit\n merge b id:\"m\"\n checkout b\n cherry-pick id:\"m\" parent:\"a\" tag: {q}"
            )
        },
        |q, _| format!("gitGraph TB:\n commit id: {q} tag: {q}\n branch {q}\n commit"),
        |q, _| format!("gitGraph BT:\n commit id: {q} tag: {q}\n branch {q}\n commit"),
        |_, p| format!("gitGraph\n commit\n branch {p}\n commit"),
        |_, p| format!("gitGraph\n title {p}\n commit"),
        |_, p| format!("gitGraph\n accTitle: {p}\n accDescr: {p}\n commit"),
        |_, p| format!("gitGraph\n accDescr {{\n {p}\n }}\n commit"),
        |_, p| format!("gitGraph {p}:\n commit"),
        |_, p| format!("gitGraph\n commit type: {p}"),
        |_, p| format!("gitGraph\n commit\n branch b order: {p}"),
        |q, p| {
            format!(
                "---\ntitle: {q}\nconfig:\n  gitGraph:\n    mainBranchName: {q}\n    mainBranchOrder: {q}\n    showBranches: {q}\n    rotateCommitLabel: {q}\n---\ngitGraph\n commit id: \"{}\"",
                p.replace(['"', '\\', '\n'], "")
            )
        },
        |q, _| {
            format!(
                "%%{{init: {{\"gitGraph\": {{\"mainBranchName\": {q}, \"showCommitLabel\": {q}, \"parallelCommits\": {q}}}}}}}%%\ngitGraph\n commit\n branch b\n commit"
            )
        },
    ];

    let mut payload_rendered = 0;
    let mut turn = 0usize;
    for &payload in PAYLOADS {
        let forms = quoted(payload);
        for tmpl in &templates {
            let form = &forms[turn % forms.len()];
            turn += 1;
            if check_both_modes(&tmpl(form, payload)) {
                payload_rendered += 1;
            }
        }
    }
    assert!(payload_rendered > 300, "expected >300 git payload renders, got {payload_rendered}");

    // Keeps payload text out of markup
    let esc = render(
        "gitGraph\n commit id: \"<script>alert(1)</script>\" tag: \"\\\"><img src=x onerror=alert(1)>\"\n branch \"</text><script>\"\n commit",
        &css_options(),
    )
    .unwrap();
    assert!(!esc.svg.contains("<script"));
    assert!(!esc.svg.contains("<img"));
    assert!(esc.svg.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));

    // Full 114-entry upstream corpus + dark mode + mutated fuzzing
    let corpus = load_fixture("git-corpus.json");
    let mut corpus_rendered = 0;
    for src in &corpus {
        if check_both_modes(src) {
            corpus_rendered += 1;
            let dark = render(src, &dark_options()).expect("dark mode");
            assert_inert_resolved(&dark.svg, src);
            assert_resvg_parses(&dark.svg, src);
        }
    }
    assert!(corpus_rendered > 60, "expected >60 git corpus renders, got {corpus_rendered}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        "'",
        "\n",
        "commit ",
        "branch ",
        "merge ",
        "id: \"",
        "tag: \"",
        "title ",
        "TB:",
        "cherry-pick id: \"",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 11);
    for _ in 0..800 {
        let src = mutator.next_sample();
        check_both_modes(&src);
    }
}

#[test]
fn git_stress_worst_cases() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let big = &big;
    let mut branches = String::from("gitGraph\ncommit\n");
    for i in 0..3000 {
        branches.push_str(&format!("branch b{i}\ncommit\n"));
    }
    let mut zigzag = String::from("gitGraph\ncommit\nbranch b\ncommit\n");
    for i in 0..1200 {
        let (a, b) = if i % 2 == 1 { ("main", "b") } else { ("b", "main") };
        zigzag.push_str(&format!("checkout {a}\ncommit\nmerge {b}\n"));
    }
    type StressCase<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let cases: Vec<StressCase<'_>> = vec![
        (
            "7,000 commits",
            Box::new(move || {
                let _ = render(&format!("gitGraph\n{}", "commit\n".repeat(7000)), big);
            }),
        ),
        (
            "3,000 branches",
            Box::new(move || {
                let _ = render(&branches, big);
            }),
        ),
        (
            "1,200 zigzag merges",
            Box::new(move || {
                let _ = render(&zigzag, big);
            }),
        ),
        (
            "4,000 tags",
            Box::new(move || {
                let _ = render(
                    &format!("gitGraph\ncommit{}\nbranch b\ncommit{}", " tag:\"t\"".repeat(4000), " tag:\"u\"".repeat(2000)),
                    big,
                );
            }),
        ),
        (
            "3,000 same id",
            Box::new(move || {
                let _ = render(&format!("gitGraph\n{}", "commit id:\"same\"\n".repeat(3000)), big);
            }),
        ),
        (
            "50k dots name",
            Box::new(move || {
                let _ = parse_git(&format!("gitGraph\nbranch a{}", ".".repeat(N)), None);
            }),
        ),
        (
            "50k order digits",
            Box::new(move || {
                let _ = render(&format!("gitGraph\ncommit\nbranch b order: {}\ncommit", "9".repeat(N)), big);
            }),
        ),
        (
            "unclosed strings",
            Box::new(move || {
                let _ = parse_git(&format!("gitGraph\ncommit id:{}", "\"a".repeat(N / 2)), None);
            }),
        ),
        (
            "unclosed accDescr",
            Box::new(move || {
                let _ = parse_git(&format!("gitGraph\n{}", "accDescr {\n".repeat(N / 11)), None);
            }),
        ),
    ];
    for (name, run) in cases {
        let start = Instant::now();
        run();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 3000, "git stress '{name}' took {elapsed}ms");
    }
}
