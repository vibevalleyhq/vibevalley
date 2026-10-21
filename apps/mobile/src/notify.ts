// The page's notices as the phone's own (expo-notifications): shown in front too, as the page asks only when the owner
// is not looking at the farm (Follow.tsx).

import * as Notifications from "expo-notifications";
import type { Notice } from "@vibevalley/host";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

let allowed: Promise<boolean> | undefined;

export async function notify(notice: Notice) {
  allowed ??= Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }).then((p) => p.granted);
  if (!(await allowed)) throw new Error("没有通知的权限：到系统设置里打开");
  await Notifications.scheduleNotificationAsync({ content: { title: notice.title, body: notice.body }, trigger: null });
}
