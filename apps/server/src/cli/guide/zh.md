# 用命令行驱动 VibeValley

给这台电脑上的 agent（和主人）：每条命令是一件事。默认答的是短的文字，一件东西一行，开头是接着要用的名字（`#12`、`#general`、`w3`）；要结构加 `--format json`，给的是接口的形状。

## 先看看

```bash
vibevalley doctor                 # 找到的是哪个农场、连不连得上、装了哪些农机、缺不缺 key
vibevalley issue list --waiting   # 在等主人的工单
vibevalley issue show 12          # 一张工单：在哪一步、问题、验收标准、现在能做什么
```

`issue show` 最后一行「能做」列出这张工单现在能用的命令，照着做就行；做不了的命令会被拒，并说能做什么。

## 写一张工单，派出去

```bash
vibevalley issue new 修登录页 --project web --agent 老周 --criterion '过期后回到登录页' --key login-1
vibevalley issue work 13          # 派活，等它交回来；经过的状态写在 stderr，最后打出改动
vibevalley issue work 13 --no-wait
```

`--key`：同一把键重发不会建两张，网络断了重试放心。

## 帮工在问

```bash
vibevalley issue show 13          # 「问题」下面是它在问的，括号里是它想到的答案
vibevalley issue answer 13 用 8797
vibevalley issue say 13 先别动数据库   # 不是回答问题，只是带一句话
```

## 验收

```bash
vibevalley issue diff 13
vibevalley issue accept 13
vibevalley issue reject 13 过期后没回到登录页
```

## 频道

```bash
vibevalley channel read general --limit 10
vibevalley channel say general '@w3 先看看登录页'
```

## 笔记

```bash
vibevalley pkm capture 给登录页加个记住我
pbpaste | vibevalley pkm capture --page 读书
vibevalley pkm search 置身事内
vibevalley pkm page get 读书
```

## 改东西之前

会改东西的命令都收 `--dry-run`：有试跑的说会做什么、什么都不动；没有试跑的直接拒，不会悄悄做了。

## 出错时

stderr 最后一行是 `{"error":{"tag":…,"message":…,"next":[{"say":…,"run":[…]}]}}`：`next` 是接着能做的，`run` 是能直接跑的命令（不带 `vibevalley`）。退出码：0 好了，2 命令写错，3 被拒，4 找不到，5 连不上。

## 别的接口

没有命令的接口都能直接调：

```bash
vibevalley api list --module pkm               # 每个接口做什么
vibevalley api list --module pkm --format json # 加上请求体的 JSON Schema
vibevalley api call issue.get --json '{"id":"12"}'
```
