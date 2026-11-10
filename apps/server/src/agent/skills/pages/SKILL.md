---
name: 网页和报表
description: 用户要一页报表、一个看板、一份带图表的调研、一个能点的小工具或演示页时用：交一份 display 为 page 的网页 Artifact。
---

交一份网页 Artifact：`artifact_create` 时 `kind` 填 `html`，`display` 不填或填 `page`。先写成工作目录里的一个文件，用 `file` 交上来。

**沙箱的规矩**（交上来会先查，不合的被退回，说哪一行、怎么改）：

- 连不了网：不能 `fetch`、不能调农场的接口、不能提交表单、不能再嵌一个页面。数据写进页面里。
- 样式和脚本写在这一个文件里；库只能从 `cdn.jsdelivr.net`、`cdnjs.cloudflare.com` 加载（写明确的版本号），字体还能从 Google Fonts 加载。
- 图片、音视频内联成 `data:`。
- 一稿最多 5 MB。

**做法。**

1. **先想看的人要什么。** 一页回答一个问题：「这周打卡有没有异常」「两种方案哪个好」。最重要的结论放在最上面，一眼看到；细节往下放。
2. **数据放在一处。** 写进一段 `<script type="application/json" id="data">`，页面的脚本从它读。数字从仓库、日志、工单、用户给的材料里来，写明出处和时间；不编数字，算不出来的说算不出来。
3. **图表。** 能用表格说清的用表格；要画图用一个库（比如 jsdelivr 上的 Chart.js 或 ECharts），一种意思一种颜色，坐标轴和单位写清楚。
4. **样子跟着工作台。** 用工作台注进来的 CSS 变量，页面自然跟着用户的浅色深色走：字 `--vv-ink`、`--vv-muted`、`--vv-faint`，底 `--vv-page`，线 `--vv-line`，强调 `--vv-accent`，状态色 `--vv-leaf`（好）、`--vv-wheat`（等、注意）、`--vv-berry`（坏）、`--vv-water`（信息），字体 `--vv-font-sans`、`--vv-font-mono`。别写死黑白底色。
5. **窄屏也能看。** 宽度用百分比或 `max-width`，表格太宽就横向滚动，不让整页溢出。
6. **交上来，再改。** `note` 写一句这页回答什么问题。用户回复卡片就是评论，照着改完用 `artifact_version_create` 交整份新的一稿。

起手模板：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>打卡周报</title>
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
  <p class="lead">这周打卡正常，只有周三有 3 次失败，都是网络超时。</p>
  <div class="cards" id="cards"></div>
  <p class="note">数据：checkin 服务日志，11 月 3 日至 9 日。</p>
</main>
<script type="application/json" id="data">
{ "days": [["周一", 120, 0], ["周二", 118, 0], ["周三", 121, 3]] }
</script>
<script>
  const { days } = JSON.parse(document.getElementById("data").textContent);
  document.getElementById("cards").innerHTML = days
    .map(([day, ok, failed]) => `<div class="card">${day}<b>${ok}</b><span class="${failed ? "bad" : "note"}">失败 ${failed}</span></div>`)
    .join("");
</script>
</body>
</html>
```

用用户的语言写页面。
