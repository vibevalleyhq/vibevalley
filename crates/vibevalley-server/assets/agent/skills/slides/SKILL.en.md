---
name: Slides
description: When the user wants a slide deck, a presentation or a report to walk someone through: hand in an html artifact whose display is slides.
---

A deck is an html artifact: call `artifact_create` with `kind` html and `display` slides. The workbench lays it out at 16:9, one slide a screen; paging, full-screen presenting, the speaker view and saving as PDF are the workbench's job. Do not write paging scripts.

**Decide what it says before you write it.**

1. Find out who it is for, how long the talk is, and what they should decide after it. If the issue doesn't say, write 5 to 10 slides.
2. Outline first: one sentence of conclusion per slide. A slide says one thing: a conclusion, a picture, a comparison. If you can't say what a slide is for, split it or drop it.
3. Numbers and facts come from the repository, the issue or what the user gave you; never invent them. Put doubts in the notes.

**Write the page to the convention.** One top-level `<section>` per slide; pick the layout with a class:

- `title`: a cover or section slide, a big `<h1>` and one `<p>` line under it.
- no class: an ordinary slide, an `<h2>` and a `<ul><li>` list, at most 5 items, one line each.
- `two-col`: a side-by-side comparison, the `<h2>` across both, two `<div>`s under it.
- `image`: one large picture, `<img src="data:...">` (inline only: the sandbox has no network), optionally a `<figcaption>`.
- `quote`: one sentence filling the slide, a `<blockquote>` and a `<cite>`.

Each slide may have one `<aside class="notes">`: words for the speaker, shown only in the speaker view. Transitions, numbers to mention and answers to likely questions go there, not on the slide.

**Leave the look to the workbench.** It looks good without any styles: sizes, spacing and colours are set and follow the user's light or dark theme. If you must change something, use the CSS variables `--vv-ink`, `--vv-muted`, `--vv-faint`, `--vv-page`, `--vv-line`, the accent `--vv-accent`, the state colours `--vv-leaf`, `--vv-wheat`, `--vv-berry`, `--vv-water`, and the fonts `--vv-font-sans`, `--vv-font-mono`. Never give a `section` a `position`, `transform`, `width`, `height` or `display`: the workbench lays them out.

**Hand it in.** Write it as a file in your working directory and hand it in with `file`; `note` says in one line what it covers. A reply to the card is a comment: revise, then hand in the next version with `artifact_version_create`, the whole deck each time. Then say in the issue thread how many slides, what they cover and which ones matter most.

Starter template:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Check-in service weekly</title></head>
<body>
<section class="title">
  <h1>Check-in service weekly</h1>
  <p>Week 43 · Backend</p>
  <aside class="notes">One line to open: the query endpoint shipped this week.</aside>
</section>
<section>
  <h2>Done this week</h2>
  <ul>
    <li>The query endpoint is live, by date range</li>
    <li>30 more tests, coverage at 82%</li>
  </ul>
</section>
<section class="two-col">
  <h2>Before and after</h2>
  <div><h3>Before</h3><p>One day per request; the page stitched a month together</p></div>
  <div><h3>After</h3><p>One request for any range; the endpoint sums it</p></div>
</section>
<section class="quote">
  <blockquote>What can come in one request shouldn't take thirty.</blockquote>
  <cite>— from a code review</cite>
</section>
<section class="title">
  <h1>Next week</h1>
  <p>Excel export · admins see everyone</p>
</section>
</body>
</html>
```

Write the deck in the user's language.
