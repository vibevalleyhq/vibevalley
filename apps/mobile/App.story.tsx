import "./src/infra/i18nBoot";
import { host, mount } from "nsh";

import { decodeNotificationRoute, subscribeNotificationPress, type NotificationRoute } from "./src/infra/notifications";
import { MobileApp } from "./src/MobileApp";

const nativeFetch: typeof fetch = fetch;

// Wraps nsh/test network responses that opt into `x-test-hold-open: 1` so SSE streams remain open until aborted.
const storyFetch: typeof fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && res.headers.get("x-test-hold-open") === "1") {
    const payload = new Uint8Array(await res.arrayBuffer());
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (payload.byteLength > 0) controller.enqueue(payload);
        if (signal?.aborted === true) {
          controller.close();
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.close();
            } catch {
              // Stream may already be cancelled by the consumer.
            }
          },
          { once: true },
        );
      },
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
  return res;
};

// Bridges headless test `app.host.send("notification.press", { id })` events alongside native `Notifications.on("press")`.
const storySubscribeNotificationPress = (onRoute: (route: NotificationRoute) => void): (() => void) => {
  const stopNative = subscribeNotificationPress(onRoute);
  const stopHost = host.on("notification.press", (payload: unknown) => {
    if (typeof payload !== "object" || payload === null || !("id" in payload) || typeof payload.id !== "string") return;
    const route = decodeNotificationRoute(payload.id);
    if (route) onRoute(route);
  });
  return () => {
    stopHost();
    stopNative();
  };
};

mount(() => <MobileApp fetchImpl={storyFetch} subscribeNotificationPress={storySubscribeNotificationPress} />);
