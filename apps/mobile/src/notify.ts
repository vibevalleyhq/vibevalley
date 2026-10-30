// The page's notices as the phone's own (expo-notifications): shown in front too, as the page asks only when the owner
// is not looking at the farm (Follow.tsx).

import * as Notifications from "expo-notifications";

import { t } from "@vibevalley/i18n";
import type { Notice } from "@vibevalley/protocol/host";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let allowed: Promise<boolean> | undefined;

export async function notify(notice: Notice) {
  allowed ??= Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }).then((p) => p.granted);
  if (!(await allowed)) throw new Error(t("mobile.noNotify"));
  await Notifications.scheduleNotificationAsync({ content: { title: notice.title, body: notice.body }, trigger: null });
}
