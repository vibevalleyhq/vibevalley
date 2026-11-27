---
name: Pages and reports
description: When the user wants a one-page report, dashboard, research with charts, or interactive summary: create a structured doc or canvas note via note_create.
---

Deliver a report or dashboard note via `note_create` with `noteType: "doc"` (embedding `chart` / `genui` blocks or tables) or `noteType: "canvas"` with self-contained files in `structure/`.

**The sandbox's rules**:

- No network: no `fetch`, no calls to farm endpoints, no form submits, no nested frames. Put data inline or inside `structure/base.json`.
- Libraries only from pinned `cdn.jsdelivr.net` / `cdnjs.cloudflare.com`, assets stored in `asset/` or inlined as `data:`.
- Maximum 5 MB per version.

1. Put key conclusions first.
2. Cite exact data sources and timestamps; never fabricate numbers.
3. Use workbench CSS custom properties (`--vv-ink`, `--vv-page`, `--vv-line`, `--vv-accent`).
4. Snapshot revisions with `note_version_create` and pass a clear one-line `note`.

Starter template:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check-ins this week</title>
<style>
  body { margin: 0; padding: 32px; font: 14px/1.6 var(--vv-font-sans); color: var(--vv-ink); background: var(--vv-page); }
  main { max-width: 960px; margin: 0 auto; }
  .lead { font-size: 20px; margin: 0 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--vv-line); border-radius: 8px; padding: 12px 16px; }
  .card b { display: block; font-size: 24px; }
  .note { color: var(--vv-muted); }
  .bad { color: var(--vv-berry); }
</style>
</head>
<body>
<main>
  <p class="lead">Check-ins were normal this week; Wednesday had 3 failures, all network timeouts.</p>
  <div class="cards" id="cards"></div>
  <p class="note">Data: the check-in service's logs, 3 to 9 November.</p>
</main>
<script type="application/json" id="data">
{ "days": [["Mon", 120, 0], ["Tue", 118, 0], ["Wed", 121, 3]] }
</script>
<script>
  const { days } = JSON.parse(document.getElementById("data").textContent);
  document.getElementById("cards").innerHTML = days
    .map(([day, ok, failed]) => `<div class="card">${day}<b>${ok}</b><span class="${failed ? "bad" : "note"}">failed ${failed}</span></div>`)
    .join("");
</script>
</body>
</html>
```

Write the page in the user's language.
