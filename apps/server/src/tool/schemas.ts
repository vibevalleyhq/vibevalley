// The tools' parameters as the model is given them, written out as they were first made from the tools' argument types.
// The orchestrator's are its prompt's prefix: change one only on purpose, with the orchestrator's evals replayed. Unknown fields
// are let through.

import type { Schema } from "../agent/brain/tool.ts";

/** The orchestrator's, by name; read_chat is a session's too. */
export const schemas: Record<string, Schema> = {
  accept: {
    additionalProperties: true,
    properties: {
      findings: {
        description: "没过时，每条要修的一句话",
        items: {
          type: "string",
        },
        type: "array",
      },
      pass: {
        description: "验收过了就是 true",
        type: "boolean",
      },
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
      text: {
        description: "没过时，还要交代的话",
        type: "string",
      },
    },
    required: ["issue", "pass"],
    type: "object",
  },
  cancel_recurrence: {
    additionalProperties: true,
    properties: {
      id: {
        type: "string",
      },
    },
    required: ["id"],
    type: "object",
  },
  changes: {
    additionalProperties: true,
    properties: {
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
    },
    required: ["issue"],
    type: "object",
  },
  channel_settings: {
    additionalProperties: true,
    properties: {
      channel: {
        type: "string",
      },
      description: {
        type: "string",
      },
      project: {
        type: "string",
      },
    },
    required: ["channel"],
    type: "object",
  },
  channels: {
    additionalProperties: true,
    properties: {},
    type: "object",
  },
  check: {
    additionalProperties: true,
    properties: {
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
    },
    required: ["issue"],
    type: "object",
  },
  dismiss: {
    additionalProperties: true,
    properties: {
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
    },
    required: ["issue"],
    type: "object",
  },
  graph_action: {
    additionalProperties: true,
    properties: {
      action: {
        enum: ["start", "pause", "resume", "abandon", "merge"],
        type: "string",
      },
      graph: {
        description: "计划 id",
        type: "string",
      },
    },
    required: ["graph", "action"],
    type: "object",
  },
  graph_split: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "让谁来拆：帮工名字或 id；不填按规则挑",
        type: "string",
      },
      goal: {
        description: "要做的事，照主人的原话",
        type: "string",
      },
      project: {
        description: "项目文件夹名",
        type: "string",
      },
    },
    required: ["goal", "project"],
    type: "object",
  },
  graphs: {
    additionalProperties: true,
    properties: {
      id: {
        description: "计划 id，比如 p1；不填列出所有没收完的",
        type: "string",
      },
    },
    type: "object",
  },
  issue_create: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "谁来做：帮工的名字、id 或 runtime；不填，开工时按农场的规则挑",
        type: "string",
      },
      channel: {
        description: "工单串开在哪个频道，比如 #clock-in；不填就是你正在回话的频道",
        type: "string",
      },
      description: {
        description: "说明：主人说的原话和你补的背景；主人没说的写成建议或待定，不写成要求",
        type: "string",
      },
      draft: {
        description: "要不要让帮工读过代码起草（写成标题、说明、验收标准）；会花钱，主人只是随口记一句时不用",
        type: "boolean",
      },
      priority: {
        description: "紧急、高、普通、低；不填是普通",
        type: "string",
      },
      project: {
        description: "项目文件夹名；频道有默认项目时可以不填；新项目起一个简短的英文名，开工时会新建",
        type: "string",
      },
      start: {
        description: "记下就开工（没空地就排队）：只在主人要马上做时填 true；记一下、先别开始、只是指派都不填",
        type: "boolean",
      },
      title: {
        description: "一句话的标题",
        type: "string",
      },
    },
    required: ["title"],
    type: "object",
  },
  issue_status: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "挪到待办时谁来做：填另一个帮工的名字、id 或 runtime 就是换人接手，上一个收工、分支留着",
        type: "string",
      },
      issue: {
        description: "工单编号（#41 或 41）",
        type: "string",
      },
      keep_branch: {
        description: "挪到已完成时：完成，但分支留着不合（主人说「先别合」「分支留着」时）",
        type: "boolean",
      },
      text: {
        description: "带给帮工的一句话：从等你看挪回待办（再干一轮）、重开时必填；换人时写接手的接着做什么",
        type: "string",
      },
      to: {
        description: "挪到：备选、待办、已完成、已取消",
        type: "string",
      },
    },
    required: ["issue", "to"],
    type: "object",
  },
  issue_update: {
    additionalProperties: true,
    properties: {
      acceptance: {
        description: "验收方式：glance（收获就算验收）或 required（先验收通过才能收获）",
        type: "string",
      },
      agent: {
        description: "谁来做：帮工的名字或 id（派出去以前才能改）",
        type: "string",
      },
      criteria: {
        description: "验收标准，一条一个主人能照着验的点；给空列表就是清掉（派出去以前才能改）",
        items: {
          type: "string",
        },
        type: "array",
      },
      description: {
        description: "说明（派出去以前才能改）",
        type: "string",
      },
      issue: {
        description: "工单编号（#41 或 41）",
        type: "string",
      },
      priority: {
        description: "紧急、高、普通、低",
        type: "string",
      },
      project: {
        description: "项目（派出去以前才能改）",
        type: "string",
      },
      title: {
        description: "标题（派出去以前才能改）",
        type: "string",
      },
    },
    required: ["issue"],
    type: "object",
  },
  issues: {
    additionalProperties: true,
    properties: {
      closed: {
        description: "也列关上的（已完成、已取消）；不填只列开着的",
        type: "boolean",
      },
      issue: {
        description: "看一张的全部：工单编号（#41 或 41）；填了它别的条件都不看",
        type: "string",
      },
      limit: {
        description: "最多列几张，默认 20",
        type: "number",
      },
      project: {
        description: "只看这个项目的",
        type: "string",
      },
      status: {
        description: "只看这个状态的：备选、待办、处理中、等你看、已完成、已取消",
        type: "string",
      },
      text: {
        description: "标题或说明里有这些字的（找重复、找某件事时用）",
        type: "string",
      },
      wants_owner: {
        description: "只看在等主人的：等回答、等验收、卡住了；按等了多久排，久的在前",
        type: "boolean",
      },
    },
    type: "object",
  },
  list_recurrences: {
    additionalProperties: true,
    properties: {},
    type: "object",
  },
  memory_add: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "帮工档案的名字或 id",
        type: "string",
      },
      project: {
        description: "只在这个项目里用：项目文件夹名",
        type: "string",
      },
      text: {
        description: "要它记住的一句话",
        type: "string",
      },
    },
    required: ["agent", "text"],
    type: "object",
  },
  memory_search: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "帮工档案的名字或 id",
        type: "string",
      },
      project: {
        description: "项目文件夹名",
        type: "string",
      },
      query: {
        description: "要找什么，几个词或一句话；不填就列出最新的",
        type: "string",
      },
    },
    type: "object",
  },
  open_channel: {
    additionalProperties: true,
    properties: {
      description: {
        type: "string",
      },
      name: {
        type: "string",
      },
      project: {
        type: "string",
      },
    },
    required: ["name"],
    type: "object",
  },
  projects: {
    additionalProperties: true,
    properties: {},
    type: "object",
  },
  read_chat: {
    additionalProperties: true,
    properties: {
      before: {
        type: "number",
      },
      limit: {
        type: "number",
      },
      target: {
        description: "#田头、#clock-in，或 #田头:<消息号>",
        type: "string",
      },
      unread: {
        type: "boolean",
      },
    },
    type: "object",
  },
  roster: {
    additionalProperties: true,
    properties: {},
    type: "object",
  },
  recurrence: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "直接派给哪个帮工档案（名字或 id）；不填就是到点交给你",
        type: "string",
      },
      at: {
        type: "string",
      },
      channel: {
        description: "在哪个频道，比如 #clock-in；不填是你正在回话的频道",
        type: "string",
      },
      cron: {
        description: "五段 cron：分 时 日 月 周几",
        type: "string",
      },
      days: {
        items: {
          type: "number",
        },
        type: "array",
      },
      kind: {
        enum: ["once", "every", "daily", "weekly", "cron"],
        type: "string",
      },
      minutes: {
        type: "number",
      },
      name: {
        description: "简短的名字，比如 每日测试",
        type: "string",
      },
      project: {
        description: "直接派活时的项目；不填用频道的默认项目",
        type: "string",
      },
      text: {
        description: "到点时说的话：要做的事",
        type: "string",
      },
      time: {
        description: "HH:MM",
        type: "string",
      },
      tz: {
        description: "时区，比如 Asia/Shanghai；不填是这台电脑的",
        type: "string",
      },
    },
    required: ["name", "text", "kind"],
    type: "object",
  },
  stop: {
    additionalProperties: true,
    properties: {
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
    },
    required: ["issue"],
    type: "object",
  },
  task_action: {
    additionalProperties: true,
    properties: {
      action: {
        enum: ["retry", "skip"],
        type: "string",
      },
      graph: {
        description: "计划 id",
        type: "string",
      },
      task: {
        description: "这件的 id",
        type: "string",
      },
    },
    required: ["graph", "task", "action"],
    type: "object",
  },
  task_edit: {
    additionalProperties: true,
    properties: {
      agent: {
        description: "帮工档案 id；空字符串表示按规则挑",
        type: "string",
      },
      brief: {
        description: "工单",
        type: "string",
      },
      check: {
        description: "做完跑的检查命令；空字符串表示不跑",
        type: "string",
      },
      graph: {
        description: "计划 id",
        type: "string",
      },
      needs: {
        description: "要等哪几件做完",
        items: {
          type: "string",
        },
        type: "array",
      },
      remove: {
        type: "boolean",
      },
      task: {
        description: "这件的 id（新加的就起一个简短的英文 id）",
        type: "string",
      },
      title: {
        type: "string",
      },
    },
    required: ["graph", "task"],
    type: "object",
  },
  tell: {
    additionalProperties: true,
    properties: {
      message: {
        description: "要带的话",
        type: "string",
      },
      issue: {
        description: "工单编号（#41 或 41）；也可以写在做它的帮工的名字",
        type: "string",
      },
    },
    required: ["issue", "message"],
    type: "object",
  },
};

/** A session's own, where it differs from the orchestrator's of the same name. */
export const sessionSchemas: Record<string, Schema> = {
  ...schemas,
  ...{
    channel_inbox: {
      additionalProperties: true,
      properties: {},
      type: "object",
    },
    channel_say: {
      additionalProperties: true,
      properties: {
        anyway: {
          description: "看过新消息、仍要原样发",
          type: "boolean",
        },
        confirm: {
          description: "确实要发到田头顶层，而不是刚读的那个串",
          type: "boolean",
        },
        target: {
          type: "string",
        },
        text: {
          type: "string",
        },
      },
      required: ["text"],
      type: "object",
    },
    doc_append: {
      additionalProperties: true,
      properties: {
        doc: {
          description: "文档的 id",
          type: "string",
        },
        level: {
          description: "标题的级别 1–3，只给 heading 用；默认 2",
          type: "integer",
        },
        text: {
          description: "这一块的字；可以用 **粗**、_斜_、行内代码、~~删~~ 和链接；代码块照原样存",
          type: "string",
        },
        type: {
          description: "块的类型：paragraph（默认）、heading、bulleted、numbered、todo、quote、code",
          type: "string",
        },
      },
      required: ["doc", "text"],
      type: "object",
    },
    doc_read: {
      additionalProperties: true,
      properties: {
        doc: {
          description: "文档的 id",
          type: "string",
        },
      },
      required: ["doc"],
      type: "object",
    },
    doc_update: {
      additionalProperties: true,
      properties: {
        base_rev: {
          description: "你读到或写下这一块时它是第几版",
          type: "integer",
        },
        block: {
          description: "块的 id",
          type: "string",
        },
        doc: {
          description: "文档的 id",
          type: "string",
        },
        text: {
          description: "这一块完整的新字，不是增量",
          type: "string",
        },
      },
      required: ["doc", "block", "base_rev", "text"],
      type: "object",
    },
    issue_split: {
      additionalProperties: true,
      properties: {
        tasks: {
          description: "子工单，每张一个帮工在自己的分支上做完、提交、单独验证",
          items: {
            additionalProperties: false,
            properties: {
              acceptance: {
                description: "这张只写现在会失败的测试，别的都等它，合进去以后冻结",
                type: "boolean",
              },
              agent: {
                description: "帮工档案 id；不填按规则挑",
                type: "string",
              },
              brief: {
                description: "这张子工单：目标、改哪里、做到什么算完、留给后面的步骤什么；做它的帮工只看得到它和前面步骤的结论",
                type: "string",
              },
              check: {
                description: "做完在它的分支上跑的检查命令，比如 go test ./...",
                type: "string",
              },
              id: {
                description: "简短的英文小写 id，比如 schema、api",
                type: "string",
              },
              needs: {
                description: "要等哪几张做完（填 id）；不互相依赖的会同时做",
                items: {
                  type: "string",
                },
                type: ["null", "array"],
              },
              scope: {
                description: "它要改的文件或目录；同时做的几张尽量不重叠",
                items: {
                  type: "string",
                },
                type: ["null", "array"],
              },
              title: {
                type: "string",
              },
            },
            required: ["id", "brief"],
            type: "object",
          },
          type: "array",
        },
        title: {
          description: "拆完的计划叫什么；不填照工单的标题",
          type: "string",
        },
      },
      required: ["tasks"],
      type: "object",
    },
    memory_add: {
      additionalProperties: true,
      properties: {
        agent: {
          description: "不用填：只能记进你自己的档案",
          type: "string",
        },
        all_projects: {
          description: "所有项目都用得上，不只是这个项目",
          type: "boolean",
        },
        text: {
          description: "一句以后还用得上的话：约定、坑、命令",
          type: "string",
        },
      },
      required: ["text"],
      type: "object",
    },
    memory_search: {
      additionalProperties: true,
      properties: {
        all_projects: {
          description: "也找别的项目里记下的",
          type: "boolean",
        },
        query: {
          description: "要找什么，几个词或一句话；不填就列出最新的",
          type: "string",
        },
      },
      type: "object",
    },
    session_list: {
      additionalProperties: true,
      properties: {},
      type: "object",
    },
  },
};
