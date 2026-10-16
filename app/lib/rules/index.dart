// Ported from packages/protocol/src/index.ts: the manager's agent id (MANAGER_AGENT), money and tokens in words (yuan,
// spentText), what a conflicting helper is told (conflictTask), what each runtime takes (RUNTIME_FACTS, factsOf, from
// @botiverse/oar 0.44.0), why nobody new should be sent to a runtime (moneyStop) and what would stop oar opening a
// session with an agent (agentIssues). They mirror checks the server makes: keep them in step with the TypeScript.

import '../gen/vibevalley.dart';
import 'seeds.dart';

/// The agent id the manager's memories and trajectory carry (protocol MANAGER_AGENT).
const managerAgent = 'foreman';

// ── Money and tokens ─────────────────────────────────────────────────────────

/// The money, near enough: ¥0.03, or under ¥0.01 for a few tokens' worth.
String yuan(num cny) => cny > 0 && cny < 0.01 ? '不到 ¥0.01' : '¥${cny.toStringAsFixed(2)}';

String _wan(double n) => n >= 10000 ? '${(n / 10000).toStringAsFixed(n >= 100000 ? 0 : 1)} 万' : '${n.round()}';

/// What a turn cost, in a few words: 约 ¥0.03 · 2.6 万 token.
String spentText(Spent spent) => [if (spent.cny != null) '约 ${yuan(spent.cny!)}', '${_wan(spent.tokens)} token'].join(' · ');

/// What a helper is told when its branch conflicts with the project's main branch.
String conflictTask(String base, List<String> files) => '把 $base 合进你的分支时有冲突（${files.join('、')}）。请在你的分支上运行 git merge $base，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。';

// ── What each runtime takes ──────────────────────────────────────────────────

/// The session options oar may refuse (SessionOption), by their wire names.
abstract final class SessionOption {
  static const systemPrompt = 'systemPrompt';
  static const appendSystemPrompt = 'appendSystemPrompt';
  static const effort = 'effort';
  static const env = 'env';
  static const mcpServers = 'mcpServers';
  static const disallowedTools = 'disallowedTools';
}

class RuntimeFacts {
  const RuntimeFacts({required this.steer, required this.refused, required this.inProcess});

  /// The runtime can take a message mid-turn. Otherwise the message waits for the turn to end.
  final bool steer;

  /// Session options the runtime refuses (SessionOption), with oar's reason, in the protocol's order.
  final Map<String, String> refused;

  /// Runs inside the server process through a Node SDK rather than as a CLI.
  final bool inProcess;
}

const runtimeFacts = <String, RuntimeFacts>{
  'claude': RuntimeFacts(steer: true, refused: {}, inProcess: false),
  'vibevalley': RuntimeFacts(steer: true, refused: {}, inProcess: true),
  'codex': RuntimeFacts(steer: true, refused: {}, inProcess: false),
  'opencode': RuntimeFacts(steer: true, refused: {SessionOption.disallowedTools: 'opencode ACP 没有会话级的工具黑名单'}, inProcess: false),
  'pi': RuntimeFacts(steer: true, refused: {}, inProcess: true),
  'cursor': RuntimeFacts(
    steer: true,
    refused: {
      SessionOption.systemPrompt: 'Cursor SDK 的本地 agent 不支持覆盖系统提示',
      SessionOption.appendSystemPrompt: 'Cursor SDK 的本地 agent 不支持追加系统提示',
      SessionOption.env: 'Cursor 跑在 server 进程里，工具拿不到单独的环境变量',
      SessionOption.mcpServers: 'oar 还没给 cursor 接 MCP 服务器',
    },
    inProcess: true,
  ),
  'grok': RuntimeFacts(steer: true, refused: {SessionOption.disallowedTools: 'grok agent stdio 不转发工具黑名单'}, inProcess: false),
  'kimi': RuntimeFacts(
    steer: false,
    refused: {
      SessionOption.systemPrompt: 'kimi acp 没有会话级的系统提示输入',
      SessionOption.appendSystemPrompt: 'kimi acp 没有会话级的系统提示追加',
      SessionOption.disallowedTools: 'kimi ACP 没有会话级的工具黑名单',
    },
    inProcess: false,
  ),
  'antigravity': RuntimeFacts(
    steer: false,
    refused: {
      SessionOption.systemPrompt: 'Antigravity ACP 没有系统提示覆盖',
      SessionOption.appendSystemPrompt: 'Antigravity ACP 没有系统提示追加',
      SessionOption.effort: 'Antigravity 没有推理强度通道',
    },
    inProcess: false,
  ),
};

const _unknownFacts = RuntimeFacts(steer: false, refused: {}, inProcess: false);

RuntimeFacts factsOf(String runtime) => runtimeFacts[runtime] ?? _unknownFacts;

// ── Why not send more ───────────────────────────────────────────────────────

String _whenText(num at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  String two(int n) => n.toString().padLeft(2, '0');
  return '${d.month} 月 ${d.day} 日 ${two(d.hour)}:${two(d.minute)}';
}

/// Why nobody new should be sent to this runtime for its account: the balance ran out, today's budget did, or one of
/// its plan's usage windows is used up.
String? moneyStop(RuntimeInfo? info) {
  final usage = info?.usage;
  if (info != null && usage is AccountUsageOk) {
    for (final w in usage.windows) {
      if (w.usedPercent >= 100) {
        return '${runtimeName(info.id)} 的额度用完了（${w.label}）${w.resetsAt != null ? '，${_whenText(w.resetsAt!)}重置' : ''}，到时候再派';
      }
    }
  }
  if (usage is AccountUsageBalance && usage.balances.isNotEmpty && (!usage.available || usage.balances.every((b) => b.amount <= 0))) {
    return '${usage.provider} 的余额用完了，充值以后再派';
  }
  final budget = info?.settings.dailyBudget ?? 0;
  final spent = info?.spentToday ?? 0;
  if (budget > 0 && spent >= budget) return '今天已经花了 ${yuan(spent)}，到了每日预算 ${yuan(budget)}（在 Runtime 页面可以改）';
  return null;
}

// ── An agent's problems ──────────────────────────────────────────────────────

enum IssueLevel { error, warn }

class AgentIssue {
  const AgentIssue(this.field, this.level, this.text);

  /// runtime, persona, effort, env, mcpServers, disallowedTools or model.
  final String field;
  final IssueLevel level;
  final String text;
}

/// What would go wrong opening a session with this agent. Errors block dispatch; warnings don't. Mirrors the checks oar
/// makes when a session opens, so the page can say it before the server does.
List<AgentIssue> agentIssues(AgentProfile agent, RuntimeInfo? runtime) {
  final issues = <AgentIssue>[];
  final facts = factsOf(agent.runtime);
  if (runtime == null) {
    issues.add(AgentIssue('runtime', IssueLevel.error, '不认识的 runtime：${agent.runtime}'));
  } else if (runtime.installation is! InstallationAvailable) {
    issues.add(const AgentIssue('runtime', IssueLevel.error, '这台机器上找不到这个 runtime'));
  } else if (!runtime.settings.enabled) {
    issues.add(const AgentIssue('runtime', IssueLevel.error, '这个 runtime 在 Runtime 页面里被停用了'));
  }
  final broke = moneyStop(runtime);
  if (broke != null) issues.add(AgentIssue('runtime', IssueLevel.error, broke));

  final promptOption = switch (agent.personaMode) {
    PersonaMode.append => SessionOption.appendSystemPrompt,
    PersonaMode.replace => SessionOption.systemPrompt,
    PersonaMode.prompt => null,
  };
  final promptRefused = promptOption == null ? null : facts.refused[promptOption];
  if (agent.persona.trim().isNotEmpty && promptRefused != null) {
    issues.add(AgentIssue('persona', IssueLevel.error, '$promptRefused。把人设改成「写进工单开头」。'));
  }
  final refused = facts.refused;
  if (agent.effort.isNotEmpty && refused[SessionOption.effort] != null) issues.add(AgentIssue('effort', IssueLevel.error, refused[SessionOption.effort]!));
  if (agent.env.isNotEmpty && refused[SessionOption.env] != null) issues.add(AgentIssue('env', IssueLevel.error, refused[SessionOption.env]!));
  if (agent.mcpServers.isNotEmpty && refused[SessionOption.mcpServers] != null) {
    issues.add(AgentIssue('mcpServers', IssueLevel.error, refused[SessionOption.mcpServers]!));
  }
  if (agent.disallowedTools.isNotEmpty && refused[SessionOption.disallowedTools] != null) {
    issues.add(AgentIssue('disallowedTools', IssueLevel.error, refused[SessionOption.disallowedTools]!));
  }
  final models = runtime?.models;
  if (runtime != null && models != null && agent.model.isNotEmpty) {
    final model = models.where((m) => m.id == agent.model).firstOrNull;
    if (model == null) {
      issues.add(AgentIssue('model', IssueLevel.warn, '${runtime.id} 的模型列表里没有 ${agent.model}'));
    } else if (agent.effort.isNotEmpty && model.effortLevels.isNotEmpty && !model.effortLevels.contains(agent.effort)) {
      issues.add(AgentIssue('effort', IssueLevel.error, '${model.name} 没有 ${agent.effort} 这一档，可选：${model.effortLevels.join('、')}'));
    }
  } else if (runtime != null && models != null && agent.effort.isNotEmpty) {
    // No model named: the runtime's default one (its settings', else the one it says it uses) must take the effort.
    final named = runtime.settings.defaultModel;
    final model = named.isNotEmpty ? models.where((m) => m.id == named).firstOrNull : models.where((m) => m.isDefault).firstOrNull;
    if (model != null && model.effortLevels.isNotEmpty && !model.effortLevels.contains(agent.effort)) {
      issues.add(AgentIssue('effort', IssueLevel.error, '${runtime.id} 默认用的 ${model.name} 没有 ${agent.effort} 这一档，可选：${model.effortLevels.join('、')}'));
    }
  }
  return issues;
}
