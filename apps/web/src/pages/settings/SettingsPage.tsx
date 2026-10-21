// 设置: its parts in a menu on the left, each its own address so a link lands on it; the
// first four are the server's settings in a card, the rest whole pages of their own.

import { Navigate, useParams } from "react-router";
import { Card, ListCard, ListRow } from "../kit";
import { ConnectorsPage } from "./ConnectorsPage";
import { LanPage } from "./LanPage";
import { GitHub, SettingsForm } from "./SettingsForm";
import { SkillsPage } from "./SkillsPage";
import { VoiceForm } from "./VoiceForm";

export const sections = [
  { id: "deepseek", label: "DeepSeek", line: "管家用的钥匙" },
  { id: "agora", label: "Agora 语音", line: "App ID 和 Certificate" },
  { id: "memory", label: "记性", line: "Nowledge Mem、EverOS" },
  { id: "github", label: "GitHub", line: "gh 和登录，能不能提 PR" },
  { id: "connectors", label: "连接器", line: "微信 飞书 QQ" },
  { id: "skills", label: "技能", line: "帮工能带的技能" },
  { id: "voice", label: "声音", line: "和管家打电话" },
  { id: "lan", label: "连接到本机", line: "手机和别的电脑" },
] as const;

type Section = (typeof sections)[number]["id"];

export function SettingsPage() {
  const [part, ...rest] = (useParams()["*"] ?? "").split("/");
  const section = sections.find((s) => s.id === part);
  if (!section) return <Navigate to="/settings/deepseek" replace />;
  const id = rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 md:flex-row md:overflow-hidden">
      <div className="shrink-0 md:w-60 md:overflow-y-auto">
        <ListCard title="设置" label="设置的分区">
          {sections.map((s) => (
            <ListRow key={s.id} to={`/settings/${s.id}`} active={s === section} title={s.label} line={s.line} />
          ))}
        </ListCard>
      </div>
      <div className="min-h-0 min-w-0 flex-1 md:overflow-y-auto">
        <Part section={section.id} label={section.label} id={id} />
      </div>
    </div>
  );
}

function Part({ section, label, id }: { section: Section; label: string; id?: string }) {
  switch (section) {
    case "deepseek":
    case "agora":
    case "memory":
      return (
        <Card title={label} className="max-w-3xl">
          <SettingsForm key={section} part={section} />
        </Card>
      );
    case "github":
      return (
        <Card title={label} className="max-w-3xl">
          <GitHub />
        </Card>
      );
    case "connectors":
      return <ConnectorsPage id={id} />;
    case "skills":
      return <SkillsPage id={id} />;
    case "voice":
      return <VoiceForm part="line" />;
    case "lan":
      return <LanPage />;
  }
}
