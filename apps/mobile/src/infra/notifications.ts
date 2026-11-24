import { Notifications, type NotificationPress, type ShowNotificationOptions } from "nsh";

import type { InboxItem } from "@vibevalley/protocol";

export type NotificationRoute =
  | { readonly tab: "inbox"; readonly key?: string }
  | { readonly tab: "channels"; readonly channelId: string }
  | { readonly tab: "sessions"; readonly sessionId: string }
  | { readonly tab: "issues"; readonly issueId: string };

const PREFIX_PERMISSION = "perm:";
const PREFIX_INTERACTION = "inter:";
const PREFIX_CHANNEL = "channel:";
const PREFIX_SESSION = "session:";
const PREFIX_ISSUE = "issue:";
const PREFIX_INBOX = "inbox:";

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function isHighPriorityInboxKind(kind: InboxItem["kind"]): boolean {
  switch (kind) {
    case "ask":
    case "cron-ask":
    case "review":
    case "fix":
    case "conflict":
    case "interrupted":
    case "budget_reached":
    case "mention":
      return true;
    case "quiet":
      return false;
  }
}

export function encodePermissionNotificationId(sessionId: string, requestId: string): string {
  return `${PREFIX_PERMISSION}${encodeURIComponent(sessionId)}:${encodeURIComponent(requestId)}`;
}

export function encodeInteractionNotificationId(sessionId: string, requestId: string): string {
  return `${PREFIX_INTERACTION}${encodeURIComponent(sessionId)}:${encodeURIComponent(requestId)}`;
}

export function encodeInboxNotificationId(item: InboxItem): string {
  const encodedItemId = encodeURIComponent(item.id);
  switch (item.target.kind) {
    case "chat":
      return `${PREFIX_CHANNEL}${encodeURIComponent(item.target.channel)}:${encodedItemId}`;
    case "session":
      return `${PREFIX_SESSION}${encodeURIComponent(item.target.id)}:${encodedItemId}`;
    case "issue":
      return `${PREFIX_ISSUE}${encodeURIComponent(item.target.id)}:${encodedItemId}`;
    case "runtime":
      if (item.target.sessionId !== undefined && item.target.sessionId !== "") {
        return `${PREFIX_SESSION}${encodeURIComponent(item.target.sessionId)}:${encodedItemId}`;
      }
      return `${PREFIX_INBOX}${encodedItemId}`;
  }
}

function splitPair(rest: string): readonly [string, string] | undefined {
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return [safeDecode(rest.slice(0, sep)), safeDecode(rest.slice(sep + 1))];
}

function firstSegment(rest: string): string {
  const sep = rest.indexOf(":");
  return safeDecode(sep === -1 ? rest : rest.slice(0, sep));
}

export function decodeNotificationRoute(id: string): NotificationRoute | undefined {
  if (id.startsWith(PREFIX_PERMISSION)) {
    const pair = splitPair(id.slice(PREFIX_PERMISSION.length));
    return pair ? { tab: "inbox", key: `perm:${pair[0]}:${pair[1]}` } : { tab: "inbox" };
  }
  if (id.startsWith(PREFIX_INTERACTION)) {
    const pair = splitPair(id.slice(PREFIX_INTERACTION.length));
    return pair ? { tab: "inbox", key: `inter:${pair[0]}:${pair[1]}` } : { tab: "inbox" };
  }
  if (id.startsWith(PREFIX_CHANNEL)) {
    const channelId = firstSegment(id.slice(PREFIX_CHANNEL.length));
    return channelId !== "" ? { tab: "channels", channelId } : undefined;
  }
  if (id.startsWith(PREFIX_SESSION)) {
    const sessionId = firstSegment(id.slice(PREFIX_SESSION.length));
    return sessionId !== "" ? { tab: "sessions", sessionId } : undefined;
  }
  if (id.startsWith(PREFIX_ISSUE)) {
    const issueId = firstSegment(id.slice(PREFIX_ISSUE.length));
    return issueId !== "" ? { tab: "issues", issueId } : undefined;
  }
  if (id.startsWith(PREFIX_INBOX)) {
    const itemId = safeDecode(id.slice(PREFIX_INBOX.length));
    return itemId !== "" ? { tab: "inbox", key: `item:${itemId}` } : { tab: "inbox" };
  }
  return undefined;
}

export async function requestNotificationPermissionSafe(): Promise<void> {
  try {
    const current = await Notifications.permission();
    if (current === "default") {
      await Notifications.requestPermission();
    }
  } catch {
    // Notifications are unavailable or denied in headless tests or restricted hosts.
  }
}

export async function showLocalNotification(options: { readonly id: string; readonly title: string; readonly body?: string }): Promise<boolean> {
  const id = options.id.trim();
  const title = options.title.trim();
  if (id === "" || title === "") return false;
  try {
    const perm = await Notifications.permission();
    if (perm === "denied" || perm === "unavailable") return false;
    const payload: ShowNotificationOptions = options.body !== undefined && options.body !== "" ? { id, title, body: options.body } : { id, title };
    return await Notifications.show(payload);
  } catch {
    // Gracefully no-op when notifications are unavailable in headless tests or restricted hosts.
    return false;
  }
}

export async function syncAppBadge(count: number): Promise<void> {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  try {
    await Notifications.setBadge(safeCount);
  } catch {
    // Gracefully no-op when badges are unsupported on the current platform or headless harness.
  }
}

export async function clearAllNotifications(): Promise<void> {
  try {
    await Notifications.closeAll();
  } catch {
    // Gracefully no-op in headless tests or unsupported hosts.
  }
}

export function subscribeNotificationPress(onRoute: (route: NotificationRoute) => void): () => void {
  try {
    return Notifications.on("press", (press: NotificationPress) => {
      const route = decodeNotificationRoute(press.id);
      if (route) onRoute(route);
    });
  } catch {
    // Gracefully no-op when notifications are unavailable in headless tests or restricted hosts.
    return () => {};
  }
}
