# Agent Note: 发布已有本地分支

Status: proposed

## Problem

主人已有的检出不能直接经服务端发布。工单发布耦合 GitHub，检查后按可变分支推送，未核对 pushurl。

## Proposal

在 repo 模块复用 git.ts 和 repository.ts。增加检出快照、远端解析、fetch、按 SHA push 和 worktree 列出/创建/复用能力；保留现有提交与 diff 能力。Git 命令使用 argv、超时和进程组取消。

共享发布流程按 Git common directory 串行：核对根目录、当前分支、完整 SHA、干净状态、唯一远端及读写目标；识别平台和默认分支；取得 base，检查冲突，执行目标检出的 .vibevalley/check；再核对本地快照和远端配置，推送已检查 SHA，然后查询/创建开放 PR/MR。失败不删除检出；推送后平台失败须报告已推送。没有检查脚本返回未运行状态。

GitHub 和 GitLab.com 适配器使用 gh/glab，Schema 解码外部返回。不支持未知主机、自建 GitLab、GitLab 工单审查与自动合并。工单发布继续限定 issueBranch，复用共享发布流程。

新增 owner-only repo.pr.submit 契约及薄 CLI repo pr submit。显式传 cwd、branch、sha、base、title、body；preview 只读取并报告待执行步骤，不执行检查、fetch、push 或创建。外部检出不写入空间登记，不增加持久化格式。

## Alternatives considered

**另建 Git 服务**：已有 repository 封装具备多数能力，平行服务会复制错误、超时和取消规则。

**自动提交或切换分支**：改变主人文件或发布未审阅内容；请求必须指向已提交快照。

**把所有反例升级为流程测试**：本地真实 Git fixture 和替代平台/网络边界足以观察大多数不变量，权限和 CLI 单独接线测试。

## Acceptance criteria

- 两个平台共用检查与按 SHA 推送，保留现有 GitHub 工单权限。
- 真实 Git fixture 覆盖成功、重试复用、检查失败、状态/引用/远端变化、取消、worktree 保留。
- 通过指定静态检查与测试；独立服务和 Host 验证 owner API/CLI，证据留在临时目录。
- 不自行发布远端；GitLab 只做替代适配器验收，真实 GitHub 发布交控制端。

## Risks

外部进程不受服务锁约束，push 必须绑定 SHA 和已经解析的 URL。检查脚本可修改文件，失败保留原状并拒绝继续。平台创建已成功但响应丢失时，重试查询开放请求。固定工单分支仍可能被目标仓库门禁拒绝。
