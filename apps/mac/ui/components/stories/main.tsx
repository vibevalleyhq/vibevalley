// Entry of the gallery as an app of its own (`nsh test`, `nsh run`): the
// story to show and the page width come from `host.params`.
import { host, mount } from "nsh";

import { Gallery } from "../Gallery";

mount(() => <Gallery story={(host.params.story as string | undefined) ?? null} width={(host.params.width as number | undefined) ?? 640} />);
