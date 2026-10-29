import { stories, story } from "@vibevalley/stories";
import { Qr } from "./Qr";

export default stories({
  title: "组件/工作台/Qr",
  stories: {
    Pairing: story({
      note: "黑白，带留白：深色主题里也是白底。",
      args: { text: "http://192.168.1.20:8790/pair?code=4821", size: 208 },
      controls: { size: { kind: "number", min: 96, max: 320, step: 16 } },
      render: (a) => <Qr text={a.text} size={a.size} label="扫码配对" />,
    }),
  },
});
