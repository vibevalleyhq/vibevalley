#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
probe=$(mktemp -d)
nsh=${1:-$root/.tools/bin/nsh}
export PATH="$(dirname "$nsh"):$PATH"
cd "$probe"
printf 'Evidence: %s\n' "$probe"
"$nsh" --version

cat > nsh.json <<'JSON'
{"name":"WebView probe","id":"dev.vibevalley.probe.webview","version":"1.0","capabilities":{"webview":{}}}
JSON
cat > App.tsx <<'TSX'
import { mount, signal, Text, View, WebView } from "nsh";

mount(() => {
  const message = signal("Waiting");
  return <View style={{ width: 500, height: 300 }}>
    <Text>{message()}</Text>
    <WebView testID="slide" style={{ width: 420, height: 230 }}
      html={'<!doctype html><p>Local slide</p><script>addEventListener("load", () => window.nsh.postMessage("Ready: " + document.querySelector("p").textContent))</script>'}
      onMessage={(event) => message.set(event.data)}
      onError={(event) => message.set(event.message)}
    />
  </View>;
});
TSX
cat > probe.test.tsx <<'TSX'
import { open, test } from "nsh/test";

test("a local slide reports ready to its host", async () => {
  const app = await open("./App.tsx", { width: 500, height: 300 });
  await app.waitFor("id:slide");
  // A resize drives native prepaint while the macOS lock screen pauses display frames.
  await app.setViewport(501, 300);
  await app.waitFor("text:Ready: Local slide", { timeout: 10000 });
});
TSX

status=0
for target in macos gpui; do
  if "$nsh" test probe.test.tsx --target "$target" > "$target.log" 2>&1; then
    printf '%s: received slide ready\n' "$target"
  else
    cat "$target.log" >&2
    status=1
  fi
done

cd "$root/apps/mac/ui"
if "$nsh" test app/story.tsx --target gpui > "$probe/workbench.log" 2>&1 <<'JS'
await app.setViewport(1200, 800);
await app.press("id:place-content");
await app.press("id:page-tree-item-art-deck");
await app.waitFor("id:note-block-doc-view");
await app.setViewport(1199, 800);
await app.waitFor("id:doc-presenter-btn");
await app.press("id:doc-presenter-btn");
await app.waitFor("id:presenter-current");
await app.setViewport(1201, 800);
await app.waitFor("text:先说结论：看板能拖了。", { timeout: 10000 });
expect(app.texts()).toContain("1 / 3");
expect(app.count("id:presenter-next-slide")).toBe(1);
await app.press("id:presenter-next");
await app.waitFor("text:拖拽的手感还要再调。");
expect(app.texts()).toContain("2 / 3");
await app.keyboard.press("pagedown");
await app.waitFor("text:这是最后一页");
expect(app.texts()).toContain("3 / 3");
expect(app.enabled("id:presenter-next")).toBe(false);
expect(app.count("id:presenter-next-slide")).toBe(0);
await app.keyboard.press("left");
await app.waitFor("text:拖拽的手感还要再调。");
await app.press("id:presenter-back");
await app.waitFor("id:note-block-doc-view");
await app.setViewport(1200, 800);
await app.waitFor("id:doc-presenter-btn");
JS
then
  printf 'workbench: three pages, notes and return passed\n'
else
  cat "$probe/workbench.log" >&2
  status=1
fi
exit "$status"
