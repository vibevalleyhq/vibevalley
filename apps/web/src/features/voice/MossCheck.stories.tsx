import { stories, story } from "@vibevalley/stories";
import { MossCheckView } from "./MossCheck";

export default stories({
  title: "组件/语音/MOSS 钥匙检查",
  stories: {
    States: story({
      note: "插头按一下，服务端试连一次：在问、能用、不能用（原因在悬停里）。",
      args: { state: "ok" },
      grid: { rows: ["state", ["none", "checking", "ok", "refused"]] },
      render: (a) => (
        <MossCheckView
          busy={a.state === "checking"}
          result={a.state === "ok" ? { ok: true } : a.state === "refused" ? { ok: false, why: "钥匙不对：401 unauthorized" } : undefined}
          onCheck={() => undefined}
        />
      ),
    }),
  },
});
