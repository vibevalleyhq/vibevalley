// ui/act.ts's createAct for the pixel skins: a refusal is a pixel toast in the error type, under `title` when given.

import { type Act, createAct } from "@/ui/act";

import { noticeTitle, ToastType, toasts } from "./toasts";

export function createPixelAct(title?: string): Act {
  return createAct((reason) => toasts.add({ type: ToastType.error, title: title ?? noticeTitle.error ?? reason, description: reason }));
}
