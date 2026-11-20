use nsh_core::element::FunctionKind;
use nsh_js::{Host, HostOptions};
use vibevalley_rich_ui::{VvPinyin, registry};

#[test]
fn registry_exports_sync_match_pinyin_function_and_declarations() {
    let set = registry();
    assert!(
        set.undocumented().is_empty(),
        "VvPinyin and matchPinyin must be documented: {:?}",
        set.undocumented()
    );

    let modules = set.module_specs();
    let pinyin_mod = modules
        .iter()
        .find(|m| m.name == "VvPinyin")
        .expect("vibevalley/rich registry must register VvPinyin module");
    assert!(
        pinyin_mod.flat,
        "VvPinyin must be flat so matchPinyin is exported directly on nativeModule(\"vibevalley/rich\")"
    );

    let func = pinyin_mod
        .functions
        .iter()
        .find(|f| f.name == "matchPinyin")
        .expect("VvPinyin must export matchPinyin");
    assert_eq!(func.kind, FunctionKind::Sync);
    assert!(!func.promises(), "matchPinyin must be synchronous (never return a Promise)");
    assert_eq!(func.params, vec![("text", "string".to_owned(), false), ("query", "string".to_owned(), false)]);
    assert_eq!(func.returns.as_deref(), Some("boolean"));

    let dts = nsh_core::element::declarations(&set, &[]);
    assert!(
        dts.contains("export declare function matchPinyin(text: string, query: string): boolean;"),
        "declarations missing sync matchPinyin signature:\n{dts}"
    );

    assert!(VvPinyin::match_pinyin("中文".into(), "zw".into()));
    assert!(!VvPinyin::match_pinyin("工单系统".into(), "gdt".into()));
}

#[test]
fn quickjs_native_module_calls_match_pinyin_synchronously() {
    let options = HostOptions {
        ui_sets: vec![nsh_base::registry(), registry()],
        ..HostOptions::default()
    };
    let host = Host::with_options(options).expect("QuickJS host with vibevalley/rich UI set");

    let script = r#"
        import { nativeModule } from "nsh";

        const rich = nativeModule("vibevalley/rich");
        if (typeof rich.matchPinyin !== "function") {
            throw new Error("expected matchPinyin function on vibevalley/rich");
        }

        const cases = [
            ["中文", "zw", true],
            ["中文", "zhongw", true],
            ["中文", "zhongwen", true],
            ["中文", "zhw", false],
            ["工单", "gd", true],
            ["工单", "gongdan", true],
            ["工单", "工d", true],
            ["AI帮工", "ai帮g", true],
            ["AI帮工", "aibangg", true],
            ["重新开始", "chongxin", true],
            ["重要", "zhongyao", true],
            ["银行", "yinhang", true],
            ["行为", "xingwei", true],
            ["成长", "chengzhang", true],
            ["长度", "changdu", true],
            ["绿色农场", "lvse", true],
            ["绿色农场", "lüse", true],
            ["工单系统", "gdt", false],
            ["中文 测试", "zwcs", true],
            ["中文-测试", "zwcs", false],
            ["中文", "", true],
            ["", "zw", false],
        ];

        for (const [text, query, expected] of cases) {
            const actual = rich.matchPinyin(text, query);
            if (typeof actual !== "boolean") {
                throw new Error(`expected synchronous boolean for (${text}, ${query}), got ${typeof actual}`);
            }
            if (actual !== expected) {
                throw new Error(`matchPinyin(${JSON.stringify(text)}, ${JSON.stringify(query)}) = ${actual}, expected ${expected}`);
            }
        }
    "#;

    host.eval_source(script)
        .expect("QuickJS eval calling nativeModule(\"vibevalley/rich\").matchPinyin should succeed");
}
