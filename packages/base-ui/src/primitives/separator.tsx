import type { Orientation } from "../base/composite";
import type { DivProps } from "../base/element";

export function Separator(props: DivProps & { orientation?: Orientation | undefined }) {
  return <div role="separator" {...props} aria-orientation={props.orientation ?? "horizontal"} data-orientation={props.orientation ?? "horizontal"} />;
}
