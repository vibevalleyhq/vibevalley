# 用命令行驱动 VibeValley

给这台电脑上的 agent（和主人）：命令照农场的样子来，一条命令就是服务端的一个操作，`<资源> [<子资源>] <动词>`，动词是 `list`、`show`、`create`、`edit`、`delete` 和资源自己的（`status`、`comment`、`send`……）。默认答的是短的文字，一件东西一行，开头是接着要用的名字（`#12`、`#general`、`w3`）；要结构加 `--format json`，给的是接口的形状。帮工是工单的负责人，替你把工单推进下去；你管的是工单。

## 先看看

```bash
vibevalley doctor                       # 找到的是哪个农场、连不连得上、装了哪些农机、缺不缺 key
vibevalley issue list --wants-owner     # 在等主人的工单，等得最久的在前
vibevalley issue show 12                # 一张工单：状态、现在在哪一步、问题、验收标准，最后是现在能用的命令
```

工单的状态只有一套：`backlog`、`todo`、`in_progress`、`in_review`、`done`、`canceled`。能不能挪、能挪到哪由服务端说：挪不了的会被拒，并列出能用的命令。

## 写一张工单，派出去

```bash
vibevalley issue create 修登录页 --project web --agent docs --criterion '过期后回到登录页' --key login-1
vibevalley issue status 13 todo         # 派出去：交给它的负责人
vibevalley issue watch 13 --timeout 600 # 跟着它，等它到 in_review、done 或 canceled；经过的状态写在 stderr
```

`--key`：同一把键重发不会建两张，网络断了重试放心。

## 帮工在问

```bash
vibevalley issue show 13                # 「问题」下面是它在问的，括号里是它想到的答案
vibevalley issue comment 13 用 8797     # 评论：在问时就是回答；在干活时它下一轮会看到
vibevalley issue watch 13
```

## 验收

```bash
vibevalley issue diff 13                                   # 改动：提交和文件
vibevalley issue review 13 --pass                          # 通过
vibevalley issue status 13 done --dry-run                  # 完成会怎么交付（合进主分支还是开 PR）
vibevalley issue status 13 done
vibevalley issue review 13 --fail --finding '过期后没回到登录页'
vibevalley issue status 13 todo --comment '过期后要回到登录页'   # 再来一轮
```

## 频道

```bash
vibevalley channel list
vibevalley channel message list general --limit 10
vibevalley channel message send general '@w3 先看看登录页'
vibevalley channel message search 端口
```

## 笔记

```bash
vibevalley pkm capture 给登录页加个记住我
pbpaste | vibevalley pkm capture --page 读书
vibevalley pkm search 置身事内
vibevalley pkm journal show              # 今天的日记（--day 看别的一天）
vibevalley pkm page show 读书             # 一页的大纲
vibevalley pkm page export 读书           # 给人读的 Markdown
vibevalley pkm page edit 读书             # 在 $EDITOR 里改原文
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
