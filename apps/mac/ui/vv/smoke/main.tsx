import "../polyfill";
import { mount, Text, View } from "nsh";

import { t, setLocale } from "@vibevalley/i18n";
import { IssueStatusValues } from "@vibevalley/protocol";
import { closedText } from "@vibevalley/protocol/rules";
setLocale("zh");
mount(() => (
  <View class="flex-1 bg-page p-4 gap-2">
    <View class="rounded-lg border border-line bg-side px-2.5 py-2">
      <Text class="text-sm font-medium text-ink">{t("web.issue.boardLabels.lane.waiting")}</Text>
      <Text class="text-2xs text-muted">{`${IssueStatusValues.length} ${typeof closedText}`}</Text>
      <Text class="text-xs text-water">
        water · <Text class="text-berry">berry</Text>
      </Text>
    </View>
  </View>
));
