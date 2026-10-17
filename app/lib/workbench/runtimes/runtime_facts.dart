enum Capability { listModels, accountUsage, checkUpdate, upgrade, skills, mcpServers, tools }

const capabilityLabel = <Capability, String>{
  Capability.listModels: '模型列表',
  Capability.accountUsage: '账户用量',
  Capability.checkUpdate: '检查更新',
  Capability.upgrade: '升级',
  Capability.skills: '技能清单',
  Capability.mcpServers: 'MCP 清单',
  Capability.tools: '工具清单',
};

const _all = Capability.values;

const _capabilities = <String, List<Capability>>{
  'claude': _all,
  'vibevalley': [Capability.listModels],
  'codex': _all,
  'opencode': [Capability.listModels],
  'pi': [Capability.listModels, Capability.skills, Capability.tools],
  'cursor': [Capability.listModels],
  'grok': [Capability.listModels, Capability.accountUsage, Capability.checkUpdate, Capability.upgrade, Capability.skills, Capability.mcpServers],
  'kimi': [Capability.listModels, Capability.accountUsage, Capability.checkUpdate, Capability.upgrade],
  'antigravity': [Capability.listModels, Capability.checkUpdate],
};

List<Capability> capabilitiesOf(String runtime) => _capabilities[runtime] ?? const [];
