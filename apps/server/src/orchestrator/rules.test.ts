import { describe, expect, it } from "vite-plus/test";
import { orchestratorInboxLines, situationDelta, intake } from "./rules.ts";
import { patrolText } from "./prompts.ts";

describe("the orchestrator's rules", () => {
  it("say what changed in the farm, or the whole when most did", () => {
    const before =
      "【现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 小吴\n- 阿郑\n各频道里在场的帮工：\n#田头\n  （没有帮工）\n#clock-in\n  （没有帮工）\n你正在回话的频道：#田头";
    const cases: [string, string, string][] = [
      ["unchanged", before, ""],
      [
        "a line added",
        "【现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 小吴\n- 阿郑\n各频道里在场的帮工：\n#田头\n  （没有帮工）\n#clock-in\n- w1 在 clock-in\n你正在回话的频道：#田头",
        "【现状变了】\n#clock-in\n+ - w1 在 clock-in\n−   （没有帮工）",
      ],
      [
        "a line gone",
        "【现状】\n项目：demo\n可以派的帮工：\n- 老周\n- 阿郑\n各频道里在场的帮工：\n#田头\n  （没有帮工）\n#clock-in\n  （没有帮工）\n你正在回话的频道：#田头",
        "【现状变了】\n可以派的帮工：\n− - 小吴",
      ],
      [
        "most of it changed",
        "【现状】\n项目：notes\n可以派的帮工：\n- 老吴\n各频道里在场的帮工：\n#田头\n- w2\n你正在回话的频道：#clock-in",
        "【现状】\n项目：notes\n可以派的帮工：\n- 老吴\n各频道里在场的帮工：\n#田头\n- w2\n你正在回话的频道：#clock-in",
      ],
    ];
    for (const [name, now, want] of cases) expect({ name, got: situationDelta(before, now) }).toEqual({ name, got: want });
  });

  it("cut what others said long, never the owner's words", () => {
    const line = (text: string) =>
      orchestratorInboxLines([{ id: "m4", number: 4, target: "#田头:3", from: "w1", fromKind: "session", name: "测试小吴", text }]);
    const head = "[target=#田头:3 msg=4 from=w1 测试小吴] ";
    const cases: [string, string, string][] = [
      ["799", "a".repeat(799), "a".repeat(799)],
      ["800", "字".repeat(800), "字".repeat(800)],
      ["801", "字".repeat(801), "字".repeat(800) + "…（这条有 801 字，全文用 read_chat 读 #田头:3）"],
      ["an emoji is two units, never cut in half", "a".repeat(799) + "🌾🌾", "a".repeat(799) + "…（这条有 803 字，全文用 read_chat 读 #田头:3）"],
      ["spaces around do not count", "  " + "a".repeat(800) + "\n", "a".repeat(800)],
    ];
    for (const [name, text, want] of cases) expect({ name, got: line(text) }).toEqual({ name, got: head + want });
    const owner = orchestratorInboxLines([{ id: "m4", number: 4, target: "#ops", from: "owner", fromKind: "owner", name: "主人", text: "字".repeat(900) }]);
    expect(owner).toBe("[target=#ops msg=4 from=主人] " + "字".repeat(900));
  });

  it("give every source its head", () => {
    for (const s of Object.values(intake)) expect(s.head).toMatch(/^\[来源：.+\]/);
  });

  it("word the patrol's finds", () => {
    expect(
      patrolText("ops", [
        { key: "a", text: "一" },
        { key: "b", text: "二" },
      ]),
    ).toBe("【巡查】#ops 里有几件事放着没人管：\n- 一\n- 二\n\n看看要不要提醒主人（一两句，说在 #ops）、催帮工或者叫停；都不用管就什么也别说。");
  });
});
