// The phone's shell: pairs with a farm once (PairScreen), then shows its page (FarmScreen). A vibevalley://pair link
// opened while it runs pairs again.

import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Platform, Settings } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { type Farm, forgetFarm, savedFarm } from "./src/farm";
import { FarmScreen } from "./src/FarmScreen";
import { PairScreen } from "./src/PairScreen";
import { type PairLink, parsePairLink } from "./src/rules";

// An end-to-end run on the iOS simulator hands the pair link as a launch argument (-vibevalleyPair <link>, read back from
// NSUserDefaults): simctl's openurl stops at the system's "Open in VibeValley?", which nothing can press.
const launchLink: string | undefined =
  process.env.EXPO_PUBLIC_VIBEVALLEY_E2E === "1" && Platform.OS === "ios" ? (Settings.get("vibevalleyPair") as string | undefined) : undefined;

export default function App() {
  const [farm, setFarm] = useState<Farm | null | undefined>(undefined);
  const [given, setGiven] = useState<PairLink | undefined>();
  const url = Linking.useLinkingURL() ?? launchLink;

  useEffect(() => {
    // A pair link that came first wins: the owner just asked for it.
    void savedFarm().then((f) => setFarm((now) => (now === undefined ? (f ?? null) : now)));
  }, []);

  useEffect(() => {
    const link = url ? parsePairLink(url) : undefined;
    if (!link) return;
    setGiven(link);
    setFarm(null);
  }, [url]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {farm === undefined ? null : farm ? (
        <FarmScreen
          farm={farm}
          forgotten={() => {
            void forgetFarm();
            setFarm(null);
          }}
        />
      ) : (
        <PairScreen key={given?.code ?? ""} given={given} paired={setFarm} />
      )}
    </SafeAreaProvider>
  );
}
