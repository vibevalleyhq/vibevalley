import { stories, story } from "@vibevalley/stories";
import { Tag, type TagTone } from "./Tag";
import { icons, type IconName } from "./icons";

export default stories({
  title: "ui/Tag",
  stories: {
    Playground: story({
      args: { label: "完成", tone: "ok", icon: "check" },
      controls: { tone: { kind: "choice", options: ["ok", "bad", "wait"] }, icon: { kind: "choice", options: ["", ...Object.keys(icons)] } },
      render: (a) => <Tag label={a.label} tone={a.tone as TagTone} icon={(a.icon || undefined) as IconName | undefined} />,
    }),
    Tones: story({
      render: () => (
        <div class="flex gap-2">
          <Tag tone="ok" icon="check" label="完成" />
          <Tag tone="bad" icon="close" label="失败" />
          <Tag tone="wait" icon="send" label="已发" />
        </div>
      ),
    }),
  },
});
