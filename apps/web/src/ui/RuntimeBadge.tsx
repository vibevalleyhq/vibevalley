import { appWording } from "../base/words";
import { ready, useRuntimes, useSprites } from "../base/query";
import { runtimeName } from "../rules/skills";

/** The execution tool named by a profile or session, using the server's catalog label. */
export function RuntimeBadge(props: { runtime: string; size: number }) {
  const runtimes = useRuntimes();
  const sprites = useSprites();
  const label = () => appWording().runtime(runtimeName(ready(runtimes, []), props.runtime));
  const icon = () => {
    const name = `logo-${props.runtime}`;
    return name in ready(sprites, {}) ? name : "icon-wrench";
  };
  return (
    <span
      class="absolute -right-0.5 -bottom-0.5 z-1 inline-flex items-center justify-center rounded-[3px] bg-cream-50 ring-1 ring-bark-300/70"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      role="img"
      aria-label={label()}
      title={label()}
      data-runtime={props.runtime}
    >
      <img src={`/pixel/${icon()}.png`} alt="" draggable="false" class="h-full w-full object-contain p-px [image-rendering:pixelated]" />
    </span>
  );
}
