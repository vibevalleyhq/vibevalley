use nsh_core::element::FunctionKind;
use nsh_js::{Host, HostOptions};
use vibevalley_rich::registry;

#[test]
fn registry_exports_sync_vv_core_functions() {
    let set = registry();
    assert!(
        set.undocumented().is_empty(),
        "VvCore and all exported methods must be documented: {:?}",
        set.undocumented()
    );

    let modules = set.module_specs();
    let core_mod = modules
        .iter()
        .find(|m| m.name == "VvCore")
        .expect("vibevalley/rich registry must register VvCore module");
    assert!(core_mod.flat, "VvCore must be flat on nativeModule(\"vibevalley/rich\")");

    for name in [
        "parseCompareSpec",
        "splitCompareBlocks",
        "formatCompareBlock",
        "computeSchedule",
        "projectTrajectory",
        "waterfallWidths",
        "projectChatSession",
        "parseBoardTokens",
        "extractToolTarget",
        "formatToolDetails",
        "parseTodoChecklist",
        "collapsedStepSummary",
        "readableInput",
        "mergeSteps",
        "markdownToBlocks",
    ] {
        let func = core_mod
            .functions
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("VvCore must export {name}"));
        assert_eq!(func.kind, FunctionKind::Sync, "{name} must be sync");
    }
}

#[test]
fn quickjs_native_module_calls_vv_core_synchronously() {
    let options = HostOptions {
        ui_sets: vec![nsh_base::registry(), registry()],
        ..HostOptions::default()
    };
    let host = Host::with_options(options).expect("QuickJS host with vibevalley/rich UI set");

    let script = r###"
        import { nativeModule } from "nsh";
        const rich = nativeModule("vibevalley/rich");

        const cmp = JSON.parse(rich.parseCompareSpec(JSON.stringify({ image: { url: "file:///a.png" } })));
        if (cmp.image?.url !== "file:///a.png") throw new Error("parseCompareSpec failed");
        if (rich.parseCompareSpec("{bad") !== null) throw new Error("expected null for malformed compare JSON");

        const segs = JSON.parse(rich.splitCompareBlocks("Hi\n\n```compare\n{\"image\":{\"url\":\"file:///a.png\"}}\n```"));
        if (segs.length !== 2 || segs[1].kind !== "compare") throw new Error("splitCompareBlocks failed");

        const widths = JSON.parse(rich.waterfallWidths(JSON.stringify([10000, 40000, 30000]), 800));
        if (widths.length !== 3 || Math.abs(widths[0] - 100) > 1e-6) throw new Error("waterfallWidths failed");

        const tokens = JSON.parse(rich.parseBoardTokens("@verifier [done] #12"));
        if (tokens[0].kind !== "mention" || tokens[2].kind !== "tag" || tokens[4].kind !== "seq") {
            throw new Error("parseBoardTokens failed");
        }

        const summary = rich.collapsedStepSummary("user/message", "【现在】10:00\n[来源：用户]\n用户说：修 bug");
        if (summary !== "修 bug") throw new Error("collapsedStepSummary failed: " + summary);

        const blocks = JSON.parse(rich.markdownToBlocks("## Roadmap\n- Ship UI\n- [x] Run checks\n> Ship small\n---\n$$E = mc^2$$\n"));
        if (!blocks.some((b) => b.type === "heading" && b.text === "Roadmap")) throw new Error("markdownToBlocks heading failed");
        if (!blocks.some((b) => b.type === "list" && b.items.includes("Ship UI"))) throw new Error("markdownToBlocks list failed");
        if (!blocks.some((b) => b.type === "todo" && b.checked && b.text === "Run checks")) throw new Error("markdownToBlocks todo failed");
        if (!blocks.some((b) => b.type === "quote" && b.text === "Ship small")) throw new Error("markdownToBlocks quote failed");
        if (!blocks.some((b) => b.type === "divider")) throw new Error("markdownToBlocks divider failed");
        if (!blocks.some((b) => b.type === "math" && b.expression === "E = mc^2")) throw new Error("markdownToBlocks math failed");
    "###;

    host.eval_source(script)
        .expect("QuickJS eval calling nativeModule(\"vibevalley/rich\") VvCore functions should succeed");
}
