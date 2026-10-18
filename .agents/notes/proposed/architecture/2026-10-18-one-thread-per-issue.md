# Agent Note: 一张工单一个串

Status: proposed

## Problem

田头的工单串（`conversation` 的 `kind = thread`、`subject_kind = issue`）按 Session 存：`subject_id` 是派出去的那个帮工的 id（`channel/deliver.go` 的 `openedJob`、`chat.go` 的 `issueThreadOf`）。一块地是一张工单，帮工可以换人（[工单](docs/subsystems/issue.md)），串却跟着帮工走：

- **重开、换帮工就另开一个串。** 同一张工单的话散在几个串里，上一轮主人说了什么、帮工交了什么，新的帮工和主人都要去翻旧串。
- **名字对不上。** 叫「工单串」，`subject_id` 却是 Session；客户端拿它去 `sessions` 里找人（`chat_window.dart`、`chat_page.dart`），帮工走了就只剩 id。
- **谁听得见按 Session 算**（`rules.go` 的 `owner`），工单换了帮工，旧串里主人说的话叫不醒新帮工。

## Proposal

**工单串的 `subject_id` 是工单 id，串跟着工单。** 串的主人（`reasonOwnThread`）是这张工单现在在干活的帮工，由田头每次按工单现算，不存。

1. **开串**：`openedJob(h)` 按 `h.Issue` 找串；有就在串里写一条派活的话（谁接手、第几次），没有才在频道里写派活的消息、开新串。没挂工单的直接派活（`h.Issue` 为空）照旧按 Session 开串，`subject_kind` 改成 `talk`，不再冒充工单串。
2. **找串**：`issueThreadOf` 改成按工单 id 找；按帮工找的地方（`TellSession`、`postReport`、叫醒失败的提示、`resolveTarget` 的默认、`JobThread`）先从帮工找到它的工单，再找串。
3. **谁听得见**：`chatAudience` 的输入多一个 `ThreadOwner`（这张工单现在在干活的帮工，没有就空），`owner` 读它，不再读 `SubjectID`。
4. **核心状态**：`FactMessage.Thread` 照旧带 `subject_id`，现在是工单 id；读它的地方跟着改。
5. **客户端**：串的标题从工单来（`issues` 里找标题），不再从 `sessions` 找帮工；`showJobThread` 收工单 id，地块详情传 `issue.id`。
6. **存盘**：不留兼容，本机的旧串作废（[地基](docs/subsystems/foundation.md)）。

## Alternatives considered

**重开时把旧串的 `subject_id` 改成新帮工。** 改动最小；但串仍然是帮工的，两个帮工先后干同一张工单时（取消后重开）要挪串，挪的那一刻谁听得见说不清。

**串存工单 id，主人存在串上（`owner` 列）。** 少算一次；但「现在谁在干这张工单」核心状态里已经有，存一份就要在换人时同步，违反核心状态只有一份。

## Acceptance criteria

- 一张工单派出去、取消、重开，前后两个帮工的派活、汇报、主人的话都在同一个串里；`channel` 的测试用 `oartest` 走一遍。
- 主人在串里说话，叫醒的是这张工单现在的帮工；工单没有帮工在干时不叫任何帮工，只记下。
- 没挂工单的直接派活开的是 `talk` 串，不出现在工单的串里。
- 客户端的串标题是工单标题，帮工走了以后照样对。

## Risks

- `issueThreadOf` 的调用方多，漏改一处就会按帮工 id 去找工单串、找不到；用类型把「工单 id」和「帮工 id」分开，或者把按帮工找收进一个函数。
- 管家的工具 `tell`、`read_chat` 用串的号，号不变，不受影响；工具说明里写「帮工的串」的要改成「工单的串」。
