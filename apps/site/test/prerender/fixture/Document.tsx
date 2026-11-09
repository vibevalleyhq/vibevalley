/** @jsxImportSource @solidjs/web */
import { getRequestEvent, HydrationScript, type JSX } from "@solidjs/web";

export default function Document(props: { children?: JSX.Element }) {
  const path = new URL(getRequestEvent()?.request.url ?? window.location.href).pathname;
  return (
    <html lang={path === "/en/" ? "en" : "zh"}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{path === "/404.html" ? "Not found" : "Prerender probe"}</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
