---
name: slides
description: 用户要一份幻灯片、演示稿、汇报 PPT，或要把一段内容讲给别人听时用。交一份网页 Artifact，display 填 slides，工作台负责翻页、放映、演讲者视图和存成 PDF。
---

# 幻灯片

幻灯片是一份网页 Artifact（`artifact_create`，`kind` 填 `html`，`display` 填 `slides`）。工作台读你写的页面：一页一个 `<section>`，自己排成 16:9、一屏一页，翻页、全屏放映、演讲者视图、存成 PDF 都是工作台的事，你不用写翻页的脚本。

1. **先定讲什么。** 一页只讲一件事：一个结论、一张图、一组对比。给谁看、讲多久没说的，按 5 到 10 页写；用户要更长再加。
2. **照模板写。** 每页一个顶层 `<section>`，版式用 class 选：
   - `title`：封面或分节页，`<h1>` 大标题，`<p>` 一句副标题。
   - 不写 class：普通一页，`<h2>` 标题加几条 `<ul><li>`，一页不超过 5 条，每条一行话。
   - `two-col`：左右两栏对比，`<h2>` 横跨两栏，下面两个 `<div>`。
   - `image`：一张大图，`<img src="data:...">`（只能内联，不能连网），可加 `<figcaption>`。
   - `quote`：一句话撑满一页，`<blockquote>` 加 `<cite>`。
3. **备注写给讲的人。** 每页可以有一个 `<aside class="notes">`，只在演讲者视图里看得到：要讲的话、要提醒的数字。
4. **样子交给工作台。** 不写也好看：字号、留白、颜色都已经排好，并跟着用户的浅色深色走。要改就用 CSS 变量：`--vv-ink`、`--vv-muted`、`--vv-faint`、`--vv-page`、`--vv-side`、`--vv-line`，颜色只有 `--vv-accent`（主色）、`--vv-leaf`、`--vv-wheat`、`--vv-berry`、`--vv-water`，字体 `--vv-font-sans`、`--vv-font-mono`。别给 `section` 写 `position`、`transform`、`width`、`height`、`display`，那是工作台排版用的。
5. **交上来。** `artifact_create` 时 `note` 写一句这份讲什么。用户评论了照着改，用 `artifact_version_create` 交新的一稿，每次都是整份。

模板：

```html
<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>打卡系统周报</title></head>
<body>
<section class="title">
  <h1>打卡系统周报</h1>
  <p>第 43 周 · 后端组</p>
  <aside class="notes">开场一句话：这周上线了查询接口。</aside>
</section>
<section>
  <h2>这周做完了什么</h2>
  <ul>
    <li>查询接口上线，按日期范围查</li>
    <li>补了 30 条测试，覆盖率到 82%</li>
    <li>修了跨时区的统计错</li>
  </ul>
</section>
<section class="two-col">
  <h2>改之前和改之后</h2>
  <div><h3>之前</h3><p>一次查一天，前端拼一个月</p></div>
  <div><h3>之后</h3><p>一次查一段，接口直接给</p></div>
</section>
<section class="quote">
  <blockquote>能一次拿到的，就别让用户等三十次。</blockquote>
  <cite>— 代码评审时的一句话</cite>
</section>
<section class="title">
  <h1>下周</h1>
  <p>导出 Excel · 管理员看全员</p>
</section>
</body>
</html>
```

用用户的语言写幻灯片，也用用户的语言回答。
