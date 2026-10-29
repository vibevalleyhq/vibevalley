// Separator (Base UI's): a line between groups of content that a screen reader announces as one.

import type { Orientation } from "./internal/composite";
import type { DivProps } from "./internal/element";

export function Separator(props: DivProps & { orientation?: Orientation | undefined }) {
  return <div role="separator" {...props} aria-orientation={props.orientation ?? "horizontal"} data-orientation={props.orientation ?? "horizontal"} />;
}
