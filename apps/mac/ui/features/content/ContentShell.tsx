import { effect, keymap, View, type JSX } from "nsh";

import { useLocation } from "../../infra/router";
import { OutlineImportModal } from "../artifact";
import { ContentSearchModal } from "./ContentSearchModal";
import { ContentSidebar } from "./ContentSidebar";
import { contentPresenting, contentSidebarOpen, openTemplatePicker, recordContentPath } from "./navigation";
import { TemplateModal } from "./TemplateModal";

export function ContentShell(props: { children: JSX.Element }) {
  const location = useLocation();

  effect(() => {
    const loc = location();
    recordContentPath(loc.pathname, loc.search);
  });

  keymap.bind("mod+\\", () => contentSidebarOpen.update((open) => !open), { when: "always" });
  keymap.bind("mod+n", () => openTemplatePicker(), { when: "notEditing" });

  return (
    <View testID="content-shell" class="min-h-0 min-w-0 flex-1 flex-row">
      <If when={contentSidebarOpen.get() && !contentPresenting()}>
        <ContentSidebar />
      </If>
      <View class="min-h-0 min-w-0 flex-1">{props.children}</View>
      <TemplateModal />
      <OutlineImportModal />
      <ContentSearchModal />
    </View>
  );
}
