// The Esc menu: go on, back to the title, sounds on or off, the other places, and what can be
// clicked in the yard. The debug console is not on the web yet.

import { useNavigate } from "react-router";
import { FarmSection, PxButton } from "../kit";
import { useMuted } from "../sound";
import { farm } from "../store";
import { webRoutes, yardPlaces } from "../world/places";

const elsewhere = [
  { label: "田头（频道）", to: "/chat" },
  { label: "帮工名册", to: "/agents" },
  { label: "农具", to: "/runtimes" },
  { label: "技能书", to: "/settings/skills" },
  { label: "连接器", to: "/settings/connectors" },
  { label: "项目", to: "/projects" },
  { label: "图鉴", to: "/catalog" },
];

export function Menu() {
  const [muted, setMuted] = useMuted();
  const navigate = useNavigate();
  const close = () => farm.menu(false);
  return (
    <div className="flex flex-col gap-2">
      <PxButton tone="primary" onClick={close}>
        继续
      </PxButton>
      <PxButton
        onClick={() => {
          close();
          farm.showTitle();
        }}
      >
        回到首页
      </PxButton>
      <PxButton onClick={() => setMuted(!muted)}>{muted ? "打开音效" : "关闭音效"}</PxButton>
      <FarmSection title="去别处">
        <div className="flex flex-wrap gap-2">
          {elsewhere
            .filter((p) => webRoutes.includes(p.to))
            .map((p) => (
              <PxButton
                key={p.to}
                onClick={() => {
                  close();
                  void navigate(p.to);
                }}
              >
                {p.label}
              </PxButton>
            ))}
          <PxButton
            onClick={() => {
              close();
              void navigate("/issues");
            }}
          >
            工单
          </PxButton>
        </div>
      </FarmSection>
      <FarmSection title="院子里能点的">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-bark-800">
          {yardPlaces.map((p) => (
            <span key={p.id}>
              <span className="text-bark-900">{p.label}</span>
              <span className="text-bark-500"> · {p.hint}</span>
            </span>
          ))}
        </div>
      </FarmSection>
    </div>
  );
}
