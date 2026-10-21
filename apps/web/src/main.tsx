import { render } from "@solidjs/web";
import { App } from "./app/App";
import { isPaired, isRemote } from "./rules/lan";
import "./style.css";

// A device not paired yet pairs before anything else: without a key the farm's listener answers nothing.
if (isRemote(location.hostname) && !isPaired(document.cookie) && location.pathname !== "/pair") location.replace("/pair");

render(() => <App />, document.getElementById("root")!);
