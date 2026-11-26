use nsh_core::element::FunctionKind;
use nsh_js::{Host, HostOptions};
use vibevalley_rich::{VvI18n, registry, translate_json};

#[test]
fn registry_exports_sync_translate_function_and_declarations() {
    let set = registry();
    assert!(
        set.undocumented().is_empty(),
        "VvI18n and translate must be documented: {:?}",
        set.undocumented()
    );

    let modules = set.module_specs();
    let i18n_mod = modules
        .iter()
        .find(|m| m.name == "VvI18n")
        .expect("vibevalley/rich registry must register VvI18n module");
    assert!(
        i18n_mod.flat,
        "VvI18n must be flat so translate is exported directly on nativeModule(\"vibevalley/rich\")"
    );

    let func = i18n_mod.functions.iter().find(|f| f.name == "translate").expect("VvI18n must export translate");
    assert_eq!(func.kind, FunctionKind::Sync);
    assert!(!func.promises(), "translate must be synchronous (never return a Promise)");
    assert_eq!(
        func.params,
        vec![
            ("locale", "string".to_owned(), false),
            ("key", "string".to_owned(), false),
            ("paramsJson", "string | null".to_owned(), true),
        ]
    );
    assert_eq!(func.returns.as_deref(), Some("string"));

    let dts = nsh_core::element::declarations(&set, &[]);
    assert!(
        dts.contains("export declare function translate(locale: string, key: string, paramsJson?: string | null): string;"),
        "declarations missing sync translate signature:\n{dts}"
    );
}

#[test]
fn translates_zh_and_en_across_shared_and_web_namespaces() {
    let static_cases = [
        ("shared.action.run_command", "跑命令", "running a command"),
        ("web.shell.sidebar.title", "仓库与终端", "Repos & terminals"),
        ("web.issue.family.children", "子工单", "Child issues"),
        ("web.artifact.page.delete", "删掉", "Delete"),
        ("web.setting.language.title", "语言", "Language"),
        ("web.farm.hud.workbench", "工作台", "Workbench"),
    ];

    for (key, expected_zh, expected_en) in static_cases {
        assert_eq!(translate_json("zh", key, None), expected_zh, "zh {key}");
        assert_eq!(translate_json("en", key, None), expected_en, "en {key}");
        assert_eq!(VvI18n::translate("zh".into(), key.into(), None), expected_zh);
        assert_eq!(VvI18n::translate("en".into(), key.into(), Some("{}".into())), expected_en);
    }

    // Verify all web.* catalogs beyond the default non-web Rust subset are embedded.
    for key in [
        "web.shell.sidebar.addRepo",
        "web.issue.reading",
        "web.setting.language.zh",
        "web.agent.title",
        "web.channel.title",
        "web.session.title",
    ] {
        // Every non-missing key resolves to localized text (never remains the literal dotted key
        // when present in the catalog; assert at least web.shell/web.issue/web.setting directly).
        if key.starts_with("web.shell.") || key.starts_with("web.issue.") || key.starts_with("web.setting.") {
            assert_ne!(translate_json("zh", key, None), key, "zh missing {key}");
            assert_ne!(translate_json("en", key, None), key, "en missing {key}");
        }
    }
}

#[test]
fn interpolates_strings_numbers_booleans_plurals_and_handles_fallbacks() {
    // String parameter interpolation.
    assert_eq!(translate_json("zh", "shared.doneWith", Some(r#"{"what":"合并"}"#)), "已完成，合并");
    assert_eq!(translate_json("en", "shared.doneWith", Some(r#"{"what":"merged"}"#)), "Done, merged");
    assert_eq!(
        translate_json("en", "web.setting.source.configure", Some(r#"{"label":"DeepSeek"}"#)),
        "Set up DeepSeek"
    );
    assert_eq!(translate_json("zh", "web.farm.panel.harvest", Some(r#"{"name":"麦田"}"#)), "收获麦田的地");

    // Whole numbers print without `.0`, fractional numbers keep decimal, multi-param works.
    assert_eq!(translate_json("zh", "web.shell.sidebar.terminalCount", Some(r#"{"n":3}"#)), "3 个终端");
    assert_eq!(translate_json("en", "web.shell.sidebar.terminalCount", Some(r#"{"n":3.0}"#)), "3 terminals");
    assert_eq!(translate_json("en", "web.issue.board.spots", Some(r#"{"taken":2,"of":4}"#)), "2 / 4 spots");
    assert_eq!(translate_json("zh", "web.artifact.card.version", Some(r#"{"version":1.5}"#)), "第 1.5 稿");

    // ICU plural branches (`one` vs `other`) in English and plain count in Chinese.
    assert_eq!(translate_json("en", "web.issue.detail.runCount", Some(r#"{"n":1}"#)), "1 round");
    assert_eq!(translate_json("en", "web.issue.detail.runCount", Some(r#"{"n":4}"#)), "4 rounds");
    assert_eq!(translate_json("zh", "web.issue.detail.runCount", Some(r#"{"n":4}"#)), "4 次");
    assert_eq!(translate_json("en", "web.channel.replies", Some(r#"{"n":1}"#)), "1 reply");
    assert_eq!(translate_json("en", "web.channel.replies", Some(r#"{"n":5}"#)), "5 replies");

    // ICU boolean `select` branches.
    assert_eq!(
        translate_json("en", "web.issue.detail.noCriteria", Some(r#"{"answer":true}"#)),
        "This ticket has no criteria for done: judge by its answer when it comes back."
    );
    assert_eq!(
        translate_json("en", "web.issue.detail.noCriteria", Some(r#"{"answer":false}"#)),
        "This ticket has no criteria for done: judge by its changes when it comes back."
    );
    assert_eq!(
        translate_json("zh", "web.issue.detail.noCriteria", Some(r#"{"answer":true}"#)),
        "这个工单没写做完的标准：交回来时看结论判断。"
    );

    // Null values are skipped without discarding sibling params; empty / malformed JSON and
    // unknown locales or keys fall back safely without panicking.
    assert_eq!(translate_json("en", "shared.doneWith", Some(r#"{"what":"ready","extra":null}"#)), "Done, ready");
    assert_eq!(translate_json("zh", "web.shell.sidebar.title", Some("")), "仓库与终端");
    assert_eq!(translate_json("zh", "web.shell.sidebar.title", Some("{not-json")), "仓库与终端");
    assert_eq!(translate_json("fr", "web.shell.sidebar.title", None), "仓库与终端");
    assert_eq!(translate_json("en", "no.such.translation.key", Some(r#"{"x":1}"#)), "no.such.translation.key");
}

#[test]
fn quickjs_native_module_calls_translate_synchronously() {
    let options = HostOptions {
        ui_sets: vec![nsh_base::registry(), registry()],
        ..HostOptions::default()
    };
    let host = Host::with_options(options).expect("QuickJS host with vibevalley/rich UI set");

    let script = r#"
        import { nativeModule } from "nsh";

        const rich = nativeModule("vibevalley/rich");
        if (typeof rich.translate !== "function") {
            throw new Error("expected translate function on vibevalley/rich");
        }

        const checks = [
            // Omitted optional third argument
            [rich.translate("zh", "shared.action.run_command"), "跑命令"],
            [rich.translate("en", "web.shell.sidebar.title"), "Repos & terminals"],
            // Explicit undefined, null, and empty JSON object
            [rich.translate("zh", "web.issue.family.children", undefined), "子工单"],
            [rich.translate("en", "web.setting.language.title", null), "Language"],
            [rich.translate("en", "web.setting.language.title", "{}"), "Language"],
            // Parameterized strings, numbers, plurals, and booleans
            [rich.translate("en", "web.shell.sidebar.terminalCount", JSON.stringify({ n: 2 })), "2 terminals"],
            [rich.translate("en", "web.issue.detail.runCount", JSON.stringify({ n: 1 })), "1 round"],
            [rich.translate("en", "web.issue.detail.runCount", JSON.stringify({ n: 3 })), "3 rounds"],
            [rich.translate("en", "web.channel.replies", JSON.stringify({ n: 1 })), "1 reply"],
            [rich.translate("en", "web.channel.replies", JSON.stringify({ n: 7 })), "7 replies"],
            [rich.translate("zh", "web.farm.panel.sow", JSON.stringify({ plot: 4 })), "播种 · 第 4 块地"],
            [rich.translate("en", "web.issue.detail.noCriteria", JSON.stringify({ answer: true })), "This ticket has no criteria for done: judge by its answer when it comes back."],
            [rich.translate("en", "web.issue.detail.noCriteria", JSON.stringify({ answer: false })), "This ticket has no criteria for done: judge by its changes when it comes back."],
            // Fallbacks: unknown locale -> zh, malformed JSON -> no params, unknown key -> key
            [rich.translate("de", "web.farm.hud.workbench"), "工作台"],
            [rich.translate("en", "web.artifact.page.delete", "{broken"), "Delete"],
            [rich.translate("en", "missing.key.check", JSON.stringify({ a: 1 })), "missing.key.check"],
        ];

        for (const [actual, expected] of checks) {
            if (typeof actual !== "string") {
                throw new Error(`expected synchronous string, got ${typeof actual}`);
            }
            if (actual !== expected) {
                throw new Error(`translate mismatch: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
            }
        }
    "#;

    host.eval_source(script)
        .expect("QuickJS eval calling nativeModule(\"vibevalley/rich\").translate should succeed");
}
