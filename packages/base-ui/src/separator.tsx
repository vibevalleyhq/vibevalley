import type { Orientation } from "./internal/composite";
import type { DivProps } from "./internal/element";

export function Separator(props: DivProps & { orientation?: Orientation | undefined }) {
  return <div role="separator" {...props} aria-orientation={props.orientation ?? "horizontal"} data-orientation={props.orientation ?? "horizontal"} />;
}
