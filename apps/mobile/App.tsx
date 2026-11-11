import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Settings } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { followDevice } from "./src/base/intl";
import { FarmConnection } from "./src/infra/farm";
import { deviceName } from "./src/infra/pairing";
import { FarmScreen } from "./src/screens/FarmScreen";
import { PairScreen } from "./src/screens/PairScreen";

followDevice();

// An end-to-end run on the iOS simulator hands the pair link as a launch argument (-vibevalleyPair <link>, read back from NSUserDefaults).
const stringOr = (v: unknown) => (typeof v === "string" ? v : undefined);
const launchLink: string | undefined =
  process.env.EXPO_PUBLIC_VIBEVALLEY_E2E === "1" && Platform.OS === "ios" ? stringOr(Settings.get("vibevalleyPair")) : undefined;

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
