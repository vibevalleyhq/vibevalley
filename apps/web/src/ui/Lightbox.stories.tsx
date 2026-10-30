import { stories, story } from "@vibevalley/stories";

import { Button } from "./Button";
import { Lightbox, type Picture } from "./Lightbox";

const pictures: Picture[] = [
  { src: "/title/bluecat-look.png", name: "bluecat-look.png" },
  { src: "/pixel/bear-farmer-down.png", name: "bear-farmer-down.png" },
  { src: "/pixel/manager-face.png", name: "manager-face.png" },
];

export default stories({
  title: "组件/工作台/Lightbox",
  stories: {
    Pictures: story({
      note: "← → 换一张，Escape 或点图外面关上。模态，盖在整页上。",
      args: { at: -1 },
      controls: { at: { kind: "number", min: -1, max: pictures.length - 1 } },
      render: (a, set) => (
        <>
          <Button onClick={() => set({ at: 0 })}>看图</Button>
          <Lightbox pictures={pictures} at={a.at < 0 ? undefined : a.at} onAt={(at) => set({ at: at ?? -1 })} />
        </>
      ),
    }),
  },
});
