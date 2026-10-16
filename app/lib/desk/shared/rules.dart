// The desk's edits of an agent profile. The protocol's runtime and agent rules the desk pages compute on the client
// (runtimePresets, runtimeName, factsOf, moneyStop, yuan, agentIssues, managerAgent) are rules/seeds.dart's and
// rules/index.dart's.

import '../../gen/vibevalley.dart';

/// An agent with some fields changed (the generated AgentProfile has no copyWith).
extension AgentEdit on AgentProfile {
  AgentProfile copyWith({
    String? id,
    String? name,
    String? role,
    bool? enabled,
    String? runtime,
    String? model,
    String? effort,
    String? persona,
    PersonaMode? personaMode,
    List<String>? skills,
    List<McpServer>? mcpServers,
    List<String>? disallowedTools,
    Map<String, String>? env,
    String? workdir,
    bool? worktree,
    List<String>? tags,
    Look? look,
  }) => AgentProfile(
    id: id ?? this.id,
    name: name ?? this.name,
    role: role ?? this.role,
    enabled: enabled ?? this.enabled,
    runtime: runtime ?? this.runtime,
    model: model ?? this.model,
    effort: effort ?? this.effort,
    persona: persona ?? this.persona,
    personaMode: personaMode ?? this.personaMode,
    skills: skills ?? this.skills,
    mcpServers: mcpServers ?? this.mcpServers,
    disallowedTools: disallowedTools ?? this.disallowedTools,
    env: env ?? this.env,
    workdir: workdir ?? this.workdir,
    worktree: worktree ?? this.worktree,
    tags: tags ?? this.tags,
    look: look ?? this.look,
  );
}
