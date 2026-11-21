// Rendered Markdown preview of a file (Rust pushes its text as `doc`).
import { Scroll, Text, View } from "nsh";
import { TextView } from "nsh/base";

import { frame, hostApi } from "../infra/bridge";
import { richNative } from "../infra/rich";

type Doc = { path: string; markdown?: string; error?: string };

export function MarkdownPane() {
  const doc = frame<Doc>("doc");
  const native = richNative();
  return (
    <Scroll testID="markdown-pane" class="flex-1 bg-page" contentClass="max-w-3xl p-6">
      {doc()?.error ? <Text class="text-sm text-berry">{doc()!.error}</Text> : null}
      {doc()?.markdown != null ? (
        native ? (
          <native.VvMarkdown text={doc()!.markdown!} selectable onLinkPress={(e) => void hostApi.openUrl(e.url)} />
        ) : (
          <TextView markdown={doc()!.markdown} selectable />
        )
      ) : (
        <View>
          <Text class="text-sm text-muted">Loading preview…</Text>
        </View>
      )}
    </Scroll>
  );
}
