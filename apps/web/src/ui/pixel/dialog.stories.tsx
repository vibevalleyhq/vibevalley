import { stories, story } from "@vibevalley/stories";
import { PxButton } from "./button";
import { FarmDialog, type FarmDialogSize, FarmSection, PxDialog } from "./dialog";

export default stories({
  title: "pixel/dialog",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    "Farm dialog": story({
      note: "模态，盖在整页上。",
      args: { open: false, size: "sm" },
      controls: { size: { kind: "choice", options: ["sm", "md", "lg", "wide"] } },
      render: (a, set) => (
        <>
          <PxButton onClick={() => set({ open: true })}>打开</PxButton>
          <FarmDialog title="小屋" size={a.size as FarmDialogSize} icon="icon-shed" open={a.open} onClose={() => set({ open: false })}>
            <FarmSection title="帮工">
              <p>三个帮工在地里。</p>
            </FarmSection>
            <FarmSection title="农机">
              <p>Claude Code、Codex。</p>
            </FarmSection>
          </FarmDialog>
        </>
      ),
    }),
    "Small dialog": story({
      args: { open: false },
      render: (a, set) => (
        <>
          <PxButton onClick={() => set({ open: true })}>打开</PxButton>
          <PxDialog title="拔掉这块地？" open={a.open} onClose={() => set({ open: false })}>
            <div class="flex flex-col gap-3">
              <p>工单会关上，改动留在分支里。</p>
              <PxButton tone="danger" onClick={() => set({ open: false })}>
                拔掉
              </PxButton>
            </div>
          </PxDialog>
        </>
      ),
    }),
  },
});
