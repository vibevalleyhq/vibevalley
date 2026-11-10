---
name: Pages and reports
description: When the user wants a one-page report, a dashboard, research with charts, a small clickable tool or a demo page: hand in an html artifact whose display is page.
---

Hand in an html artifact: `artifact_create` with `kind` html and `display` left out or page. Write it as a file in your working directory first and hand it in with `file`.

**The sandbox's rules** (it is checked when handed in; what breaks them is sent back with the line and the fix):

- No network: no `fetch`, no calls to the farm's endpoints, no form submits, no nested pages. Put the data in the page.
- Styles and scripts live in this one file; libraries load only from `cdn.jsdelivr.net` and `cdnjs.cloudflare.com` (with an exact version), fonts also from Google Fonts.
- Images, audio and video are inlined as `data:`.
- At most 5 MB a version.

**How.**

1. **Start from what the reader needs.** A page answers one question: "were check-ins normal this week", "which of the two designs is better". The main conclusion goes at the top, visible at a glance; details below.
2. **Keep the data in one place.** Put it in a `<script type="application/json" id="data">` and have the page's script read it. Numbers come from the repository, logs, the issue or what the user gave you, with where and when they're from; never invent numbers, and say so when something can't be computed.
3. **Charts.** Use a table when a table says it; for charts use one library (Chart.js or ECharts from jsdelivr, say), one colour per meaning, axes and units labelled.
4. **Look like the workbench.** Use the CSS variables the workbench injects, so the page follows the user's light or dark theme: text `--vv-ink`, `--vv-muted`, `--vv-faint`, background `--vv-page`, lines `--vv-line`, accent `--vv-accent`, states `--vv-leaf` (good), `--vv-wheat` (waiting, attention), `--vv-berry` (bad), `--vv-water` (info), fonts `--vv-font-sans`, `--vv-font-mono`. Don't hard-code black or white backgrounds.
5. **Work on a narrow screen.** Widths in percent or `max-width`; a wide table scrolls sideways instead of the page overflowing.
6. **Hand in, then revise.** `note` says in one line what question the page answers. A reply to the card is a comment: revise and hand in the whole next version with `artifact_version_create`.

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
