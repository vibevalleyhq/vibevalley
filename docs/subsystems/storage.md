# 存储

字节放在哪（`Storage`，`apps/server/src/storage/storage.ts`）：按内容的 SHA-256 为键，存一次，不改。它不管一份文件是什么，名字、类型、谁在用归[附件](docs/subsystems/attachment.md)（`Attachment`）。现在只有一种实现：本机家目录的 `attachments/`。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 按键写入（字节或流）、读出（磁盘支持的 Blob 或流）、有没有、多大、删除 | 文件的名字、类型、去重的记录（附件，表 `attachment`） |
| 暂存目录 `scratch`：写的人先把大文件写在这里，再 `adopt` 放到键下 | 谁引用一份字节、什么时候能删（附件和用它的模块） |

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/server/src/storage/storage.ts` | 服务 `Storage` 和本机磁盘的 layer（`Storage.layer`） |
| `apps/server/src/storage/storage.test.ts` | 写两次是一份、读回、删除、取消的流式写入不留东西 |

## 模型和不变量

- **键是内容的 SHA-256**：同一个键已经有了就不再写（`put`、`putStream`），算键的是调用的人（附件、媒体的暂存）。
- **写完才发布**：`put` 经 `infra/files.ts` 的 `writeOnce`；`putStream` 先写进 `scratch` 下的临时目录，全部写完才改名到键下，取消或失败时临时文件随作用域删掉，键下什么都没有。
- **`adopt`**：一个已经在本机写好的文件（在 `scratch` 下）放到键下：本机实现是改名，`retain` 时硬链接。
- **`pathOf` 只属于本机实现**：HTTP 的文件响应、给帮工的信封、上传给厂商，要一个本机路径；换成对象存储的实现，这几处得先下载到本机。

## 和谁打交道

- **附件（`Attachment`）**：唯一直接用它的模块；`keep` 走 `put`，`keepStaged` 走 `adopt`，放进来时用 `stream` 核对已有的那份。
- **媒体**：经附件拿 `staging`（即 `scratch`）和 `pathOf`，在暂存里写大文件，读本机路径交给厂商。

## 为什么这样

- **存哪和是什么分开**：一个服务端管多台机器时（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)），字节可能要放到对象存储；只换 `Storage` 的 layer，附件、媒体、Artifact、素材库都不用动。
- **只有一种实现**：对象存储的那一层等真要用时再写，接口按它也能实现的样子定（键、流、Blob），本机才有的 `pathOf` 单独标出来。

## 怎么验证

- `apps/server/src/storage/storage.test.ts`：同一个键写两次只有一份，读回的字节和类型，删除，流式写入整份发布，取消的写入在键下和暂存里都不留东西。
- `apps/server/src/media/inputs.test.ts`、`apps/server/src/artifact/artifact.test.ts`：经附件写进存储的输入和稿子。
