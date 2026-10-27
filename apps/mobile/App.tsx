// The phone's shell: pairs with a farm once (PairScreen), then shows its page (FarmScreen). A vibevalley://pair link
// opened while it runs pairs again.

import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Settings } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FarmConnection } from "./src/farm";
import { FarmScreen } from "./src/FarmScreen";
import { PairScreen } from "./src/PairScreen";
import { deviceName } from "./src/rules";
import { followDevice } from "./src/words";

followDevice();

// An end-to-end run on the iOS simulator hands the pair link as a launch argument (-vibevalleyPair <link>, read back from
// NSUserDefaults): simctl's openurl stops at the system's "Open in VibeValley?", which nothing can press.
const launchLink: string | undefined =
  process.env.EXPO_PUBLIC_VIBEVALLEY_E2E === "1" && Platform.OS === "ios" ? (Settings.get("vibevalleyPair") as string | undefined) : undefined;

export default function App() {
  const [connection] = useState(() => new FarmConnection(deviceName(Platform.OS, undefined)));
  const choice = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const url = Linking.useLinkingURL() ?? launchLink;

  useEffect(() => {
    void connection.start();
    return connection.close;
  }, [connection]);

  useEffect(() => {
    if (url) void connection.openLink(url);
  }, [connection, url]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {choice.kind === "loading" ? null : choice.kind === "farm" ? (
        <FarmScreen farm={choice.farm} forgotten={() => void connection.forget()} />
      ) : (
        <PairScreen connection={connection} choice={choice} />
      )}
    </SafeAreaProvider>
  );
}
