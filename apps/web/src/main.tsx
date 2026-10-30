import { render } from "@solidjs/web";

import { App } from "./app/App";
import { followAppearance } from "./base/appearance";

import "./style.css";
import { isPaired, isRemote } from "./features/lan";

// A device not paired yet pairs before anything else: without a key the farm's listener answers nothing.
if (isRemote(location.hostname) && !isPaired(document.cookie) && location.pathname !== "/pair") location.replace("/pair");

followAppearance();
render(() => <App />, document.getElementById("root")!);
