---
name: vv-pr
description: 给 VibeValley 开、改、合 PR：默认把同一批工作的改动合成一个 PR，再照规矩起分支名、写英文的标题和正文（What changed / Checks / Not verified）、附验收的证据、等 CI、squash 合并。用在：做完一件事要提交、推送、开 PR；主人说「开个 PR」「提 PR」「合进去」「拆一下 PR」；改 PR 的标题或正文；手上有好几处改动不知道该合成一个还是拆开。
---

# 开 PR

能查的已经由 `scripts/commit-msg.ts` 查了（本机的 commit-msg hook、CI 的 `check`）：标题英文、最多 100 字、不带句号；正文有三段、是英文；分支名 `<类>/<主题>`；不带 agent 的署名。规矩的家在 [docs/development.md](docs/development.md#分支提交和-pr)。这里只写要判断的：同批改动怎样合在一个 PR、标题和正文写什么、合之前看什么。

## 1. 尽量少 PR

主人的偏好是同一批工作默认一个 PR，多个相关修复、简化、测试和文档合并交付。用多个逻辑提交和分组正文帮助评审，不因为跨模块或含几个可独立回退的修复就拆出多个 PR。

已经开了多个 PR 时，把尚未合并的改动收拢到一个汇总 PR，链接并关闭被替代的 PR；保留已合并的结果，不为收拢而撤回它们。汇总分支应在最新 main 上重新验证，不能把旧 PR 的绿灯当作汇总分支的绿灯。

只有主人明确要求分开，或确实需要不同的发布、权限或回滚安排时才拆，并说明具体原因。PR 数量少不改变测试、CI 和 squash 合并要求。

## 2. 分支

- 从最新的 `origin/main` 起：`git fetch origin && git switch -c <类>/<主题> origin/main`。别的会话在主 checkout 上有没提交的东西时，用 `git worktree add`，不动它，也不用 `git stash`（共享的）。
- 类：`feat`（新行为）、`fix`、`docs`、`chore`（工具、依赖、仓库的规矩）、`refactor`、`test`（只加测试）。主题用英文小写、连字符，说这件事：`fix/orchestrator-answer-hangs`，不写 `fix/misc`、`fix/stuff-2`。

## 3. 标题

标题就是 squash 以后 `main` 上的提交主题：

- 英文，一句话，说**合进去以后代码做什么**，用现在时：`The orchestrator ends a call whose input could not be taken`。不写做了什么动作（`Fix bug in take`、`Update orchestrator.ts`）。
- 界面上的中文词放进「」：`The board's 「完成」 column keeps issues done today`。代码和路径用反引号。
- 好几处小修放在一起时，说它们共同的结果，或说最重要的那处、其余在正文里：`gh answers are decoded, and a failed input ends its caller`。

## 4. 正文

照模板写三段，英文，正文就是 `main` 上那条提交的说明：

- `## What changed`：现在的行为和为什么；一处问题一条，说清以前会怎样（输入、结果），现在怎样。链接 Agent Note 或 issue。看过、决定不改的，也写一句和理由，下一个人不用再查一遍。
- `## Checks`：跑了的命令和它们打出的结果（`vp check`、`server:check` 的通过数）。先写测试的，写修之前它报什么（`expected 'still waiting' to contain …`）；改了接口、服务、页面，附 [vv-acceptance](.agents/skills/vv-acceptance/SKILL.md) 要的证据。
- `## Not verified`：没验的和原因（真机、花钱的评测、真的厂商）。都验了写 `None.`。
- `## Regression`（要的时候才有）：这个 PR 删了或改了名字以 `regression: ` 开头的测试，逐个写出测试名和为什么（行为有意改了、挪了地方）；`fix/` 没补回归测试时写为什么补不了。CI 的 `scripts/regression.ts` 查。

`fix/` 先写回归测试：名字 `regression: <修好以后一直成立的事>`，修之前跑一次看它失败，把失败的输出写进 `## Checks`，再修。被改动牵连到别的回归测试时，先想是不是代码改错了：测试守的是一个修过的缺陷，改它要有行为上的理由，不是为了变绿。

不写过程（「先试了 A 又改成 B」），不写 agent 的署名，不贴密钥和主人的私人数据。正文里引用中文的报错、界面上的话，用反引号或「」。

## 5. 开、等、合

1. 推之前跑和改动有关的检查（AGENTS.md 的「命令」），改了文档跑 `vp run docs:verify`；改了代码，照 [vv-comments](.agents/skills/vv-comments/SKILL.md) 审一遍这个分支新加的注释。
2. 正文写进一个临时文件，开 PR：

   ```bash
   git push -u origin <分支>
   gh pr create --base main --head <分支> --title "<标题>" --body-file <正文文件>
   ```

3. 等 CI：`gh pr checks <号> --watch`。红了就看日志修，推上去再等；不要为了过而跳检查。
4. 只改了标题或正文（`gh pr edit`），CI 不会重跑。合之前在本机再查一遍 PR 上现在的样子：

   ```bash
   gh pr view <号> --json title,body,headRefName > /tmp/pr.json
   vpx scripts/commit-msg.ts --title "$(jq -r .title /tmp/pr.json)"
   vpx scripts/commit-msg.ts --body "$(jq -r .body /tmp/pr.json)"
   vpx scripts/commit-msg.ts --branch "$(jq -r .headRefName /tmp/pr.json)"
   vpx scripts/regression.ts --base origin/main --branch "$(jq -r .headRefName /tmp/pr.json)" --body "$(jq -r .body /tmp/pr.json)"
   ```

5. 合不合听主人的。要合时只用 squash：`gh pr merge <号> --squash`。合完删掉本机的分支和 worktree；远端的分支 GitHub 会自动删。
