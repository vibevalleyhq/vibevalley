/** @jsxImportSource @solidjs/web */
import { HydrationScript, type JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { backgrounds } from "./lib/images";
import { page } from "./lib/page";

const sceneStyles = stylex.create({
  lost: {
    display: "grid",
    minHeight: "100svh",
    placeItems: "center",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 8)",
    backgroundColor: "var(--color-cream-100)",
  },
});

export default function Document(props: { children?: JSX.Element }) {
  const route = page();
  const copy = route.copy;
  const here = new URL(copy.home, "https://vibevalley.dev").href;
  return (
    <html lang={copy.lang} data-scene={route.lost ? undefined : "morning"}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{route.lost ? `404 · ${copy.title}` : copy.title}</title>
        <meta name="theme-color" content="#2f1f13" />
        <link rel="icon" type="image/png" sizes="32x32" href="/gen/icon-32.png" />
        <link rel="apple-touch-icon" href="/gen/icon-256.png" />
        <link rel="preload" href="/gen/pixel.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        {route.lost ? (
          <meta name="robots" content="noindex" />
        ) : (
          <>
            <meta name="description" content={copy.description} />
            <link rel="canonical" href={here} />
            <link rel="alternate" hreflang="zh-CN" href="https://vibevalley.dev/" />
            <link rel="alternate" hreflang="en" href="https://vibevalley.dev/en/" />
            <link rel="alternate" hreflang="x-default" href="https://vibevalley.dev/" />
            <meta property="og:type" content="website" />
            <meta property="og:url" content={here} />
            <meta property="og:title" content={copy.title} />
            <meta property="og:description" content={copy.description} />
            <meta property="og:image" content={`https://vibevalley.dev/gen/card-${copy.lang}.jpg`} />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            <meta property="og:image:alt" content={copy.title} />
            <meta name="twitter:card" content="summary_large_image" />
            <link rel="preload" as="image" href={backgrounds.morning} fetchpriority="high" />
          </>
        )}
        <HydrationScript />
      </head>
      <body {...stylex.attrs(route.lost && sceneStyles.lost)}>{props.children}</body>
    </html>
  );
}
