import { registerRootComponent } from "expo";

import "./src/base/intl";
import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
registerRootComponent(App);
