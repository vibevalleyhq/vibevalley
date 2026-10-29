import { stories, story } from "@vibevalley/stories";
import { AnswerView } from "./IssueDetail";

export default stories({
  title: "界面/工单/答案",
  stories: {
    Answer: story({
      note: "只要答案的工单交回来的样子：结论、依据、拿不准的、下一步。",
      render: () => (
        <div class="w-full max-w-xl">
          <AnswerView
            answer={{
              conclusion: "登录过期是因为 cookie 的有效期比服务端的会话短一个小时。",
              evidence: ["session.ts 里 cookie 的 maxAge 是 23 小时", "服务端的会话是 24 小时"],
              unsure: ["手机壳里的 WebView 是不是另存了一份"],
              next: ["把两边对齐成同一个常量", "补一条跨过边界的测试"],
            }}
          />
        </div>
      ),
    }),
  },
});
