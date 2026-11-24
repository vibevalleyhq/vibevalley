# 游戏

游戏模块（`Game`）将农场里的真实工作结果映射为进度与反馈：
- 只追加账本（家目录的 `ledger.jsonl`）折叠出金币、连胜、成就、称号与各档案战绩。
- 工作目录里归属用户的 git commit 数折算为农场等级。
- 每次状态迁移派生出画面特效 `GameEffect` 与地块视图 `FarmView`。

游戏模块单向订阅核心状态的事实，业务模块不依赖 `game`。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 账本（`ledger.jsonl`）：从事实提取条目（`entries_for`）并折叠出 `Progress` | 工单状态流转、验收与合并本身（[工单](docs/subsystems/issue.md)） |
| 等级计算（`level_for_commits`）、周期性触发 commit 统计与升级横幅判定 | 扫描 git 仓库统计 commit 的实现（[仓库](docs/subsystems/repo.md)） |
| 地块视图计算（`plot_of`、`view_of`）、地块槽位分配与单次特效（`effects_of`） | 像素画布、精灵动画与合成音效的渲染播放（[农场的皮](docs/subsystems/farm.md)） |

## 在哪

| 位置 | 职责 |
|---|---|
| `crates/server/src/game.rs` | `Game`：账本落盘（`ledger.jsonl`）、订阅事实、commit 统计调度（`count_commits`）、称号（`choose_title`）与空地预约（`want`） |
| `crates/core/src/progress.rs` | 账本条目提取（`entries_for`）、进度折叠纯函数（`progress_fold`、`progress_step`）、金币（`harvest_coins`） |
| `crates/core/src/game.rs` | 等级（`level_for_commits`）、地块映射（`plot_of`）、帧视图（`view_of`）、特效（`effects_of`）、地块分配（`free_station`、`stationed`）、成就目录与进度计算（`achievements`、`standings_of`） |
| `crates/core/data/seeds.json` | 内置成就定义 |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`game.achievement.list`、`game.title.set`）。

## 模型和不变量

- **只奖真实交付结果，不奖资源消耗**：
  - 金币、连胜与收成类成就仅在工单成功合入主分支或完成父子工单（`merged` / `family`）时发放。
  - 运行轮数、命令次数或消耗的 token 不产生奖励。
- **账本是唯一持久源，启动全量重折**：
  - `Progress` 不单独存，每次启动按 `ledger.jsonl` 的顺序全量重折；读不懂的行跳过。
  - 修改计分或成就规则后重启即按新规则生效；写盘失败只记日志，不阻塞主业务。
- **金币与连胜计算**：
  - 单张工单合入：`round((30 + min(提交数 × 5, 30)) × min(2, 1 + 0.1 × (连胜 - 1)))`。
  - 父子工单完成（`family`）：`30 + 10 × 已合入子工单数`。
  - 解锁成就档位：新手任务 20 金币，计数类铜/银/金档 10/30/60 金币，彩蛋 50 金币（每档只发一次）。
  - 每次成功合入连胜 `+1`；任一帮工回合 `failed` 时连胜归零并触发 `penalty` 特效。
- **五类成就与称号（`seeds.json`）**：
  - 涵盖新手任务、收成、手艺、精打细算、协作与彩蛋五类。
  - 除新手任务外，已解锁档位均可通过 `game.title.set` 佩戴为称号。
- **commit 折算等级**：
  - 从 `Lv.n` 升至 `Lv.n+1` 需 `10 × n` 个归属用户的 commit（`level_for_commits`）。
  - 首次启动统计基线只定等级、不弹升级横幅；后续新增 commit 跨级时发出 `levelUp` 特效。
- **农场视图独立切片与成就按需查询**：`FarmView` 与 `GameEffect` 通过独立的 `SliceKind::Farm`（`FarmFrame { seq, view, progress, effects }`）推送，不再进入工作台业务切片；`FarmView` 移除了 `achievements` 字段，成就定义与档位进度统一经 `game.achievement.list` 返回 `AchievementList { items, standings }` 按需读取。

## 怎么走

1. **监听事实记账**：订阅事实提取账本条目，追加进 `ledger.jsonl` 后施加 `progressChanged` 事实。
2. **统计 commit**：启动就绪、每 2 分钟及 `sessionReported` 后 15 秒数一遍各仓库里用户的 commit，变化时更新 `progressChanged.commits`。
3. **指定空地播种**：用户点击空地发消息附带 `station`（0–5），`Game.want` 保留预约 10 秒，期间新派出的帮工自动移至该地块。

## 和谁打交道

- **核心状态**：拼帧时调用 `view_of` 与 `effects_of`；`Game` 订阅事实并回写 `progressChanged`。
- **仓库（`repo`）**：从仓库列表数 commit。

## 为什么这样

- **事件溯源账本替代可变计数器**。不可变账本行既能记录每个成就的解锁日期与档案战绩，又能在调整数值后无损重算。
- **游戏单向订阅业务事实，业务零侵入**。工单、频道和帮工无需知道金币或成就的存在，保持核心领域干净。

## 还没做的

- 商店消费金币购买农场装饰与工单模板、每日任务：[商店与每日任务](.agents/notes/proposed/feature/2026-10-09-shop-and-daily-tasks.md)。

## 怎么验证

- `crates/server/tests/game.rs`：收成按 commit 与连胜给金币、账本经重启折回并跳过读不懂的行、每个仓库的 commit 只数一次。
