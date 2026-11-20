// Rendered Markdown preview of a file (Rust pushes its text as `doc`).
import { Scroll, Text, View } from "nsh";
import { TextView } from "nsh/base";

import { frame, hostApi } from "../bridge";
import { tok, type as ty } from "../tokens";
import { richNative } from "../vv/web/ui/rich/native";

type Doc = { path: string; markdown?: string; error?: string };

export function MarkdownPane() {
  const doc = frame<Doc>("doc");
  const p = () => tok();
  const native = richNative();
  return (
    <Scroll style={{ flex: 1, backgroundColor: p().surface }} contentStyle={{ padding: 24, maxWidth: 820 }}>
      {doc()?.error ? <Text style={{ ...ty.body, color: p().danger }}>{doc()!.error}</Text> : null}
      {doc()?.markdown != null ? (
        native ? (
          <native.VvMarkdown text={doc()!.markdown!} selectable onLinkPress={(e) => void hostApi.openUrl(e.url)} />
        ) : (
          <TextView markdown={doc()!.markdown} selectable />
        )
      ) : (
        <View>
          <Text style={{ ...ty.body, color: p().muted }}>Loading preview…</Text>
        </View>
      )}
    </Scroll>
  );
}
