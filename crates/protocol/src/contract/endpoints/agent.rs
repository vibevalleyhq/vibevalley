use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "agent.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<Agent>"),
    },
    Endpoint {
        op: "agent.validate",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AgentValidateRequest"),
        result: Some("Vec<AgentValidation>"),
    },
    Endpoint {
        op: "agent.create",
        module: "agent",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Agent"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.update",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Agent"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.register",
        module: "agent",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AgentRegisterInput"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("agent.previewDelete"),
        input: Some("AgentDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "agent.previewDelete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "agent.template.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<AgentTemplate>"),
    },
    Endpoint {
        op: "agent.template.install",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateInstallInput"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.template.update",
        module: "agent",
        about: &["agent"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateUpdateInput"),
        result: Some("Agent"),
    },
    Endpoint {
        op: "agent.template.add",
        module: "agent",
        about: &["path"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentTemplateAddInput"),
        result: Some("AgentTemplate"),
    },
    Endpoint {
        op: "agent.template.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AgentDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "skill.list",
        module: "agent",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: None,
        result: Some("Vec<Skill>"),
    },
    Endpoint {
        op: "skill.create",
        module: "agent",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Skill"),
        result: Some("Skill"),
    },
    Endpoint {
        op: "skill.update",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("Skill"),
        result: Some("Skill"),
    },
    Endpoint {
        op: "skill.delete",
        module: "agent",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("SkillDeleteInput"),
        result: None,
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct AgentList;
    impl Op for AgentList {
        const NAME: &'static str = "agent.list";
        type Input = ();
        type Result = Vec<t::Agent>;
    }
    /// The issues of each profile as it would be dispatched now; a draft not saved yet too.
    pub struct AgentValidate;
    impl Op for AgentValidate {
        const NAME: &'static str = "agent.validate";
        type Input = t::AgentValidateRequest;
        type Result = Vec<t::AgentValidation>;
    }
    /// Create allocates an identity; callers with an existing identity use save.
    pub struct AgentCreate;
    impl Op for AgentCreate {
        const NAME: &'static str = "agent.create";
        type Input = t::Agent;
        type Result = t::Agent;
    }
    pub struct AgentUpdate;
    impl Op for AgentUpdate {
        const NAME: &'static str = "agent.update";
        type Input = t::Agent;
        type Result = t::Agent;
    }
    /// Idempotently register or update an external coding agent teammate with a W-XX code.
    pub struct AgentRegister;
    impl Op for AgentRegister {
        const NAME: &'static str = "agent.register";
        type Input = t::AgentRegisterInput;
        type Result = t::Agent;
    }
    pub struct AgentDelete;
    impl Op for AgentDelete {
        const NAME: &'static str = "agent.delete";
        type Input = t::AgentDeleteInput;
        type Result = ();
    }
    /// What delete would do, refused as it would be; nothing changes.
    pub struct AgentPreviewDelete;
    impl Op for AgentPreviewDelete {
        const NAME: &'static str = "agent.previewDelete";
        type Input = t::AgentDeleteInput;
        type Result = t::Preview;
    }
    /// The templates a profile can be installed from: the built-in ones, then those added on this machine.
    pub struct AgentTemplateList;
    impl Op for AgentTemplateList {
        const NAME: &'static str = "agent.template.list";
        type Input = ();
        type Result = Vec<t::AgentTemplate>;
    }
    /// A new profile from a template; installing one again makes another.
    pub struct AgentTemplateInstall;
    impl Op for AgentTemplateInstall {
        const NAME: &'static str = "agent.template.install";
        type Input = t::AgentTemplateInstallInput;
        type Result = t::Agent;
    }
    /// A profile made again from its template's version now.
    pub struct AgentTemplateUpdate;
    impl Op for AgentTemplateUpdate {
        const NAME: &'static str = "agent.template.update";
        type Input = t::AgentTemplateUpdateInput;
        type Result = t::Agent;
    }
    /// A template folder on this machine copied in beside the built-in ones; nothing is installed.
    pub struct AgentTemplateAdd;
    impl Op for AgentTemplateAdd {
        const NAME: &'static str = "agent.template.add";
        type Input = t::AgentTemplateAddInput;
        type Result = t::AgentTemplate;
    }
    /// An added template gone; the profiles installed from it stay.
    pub struct AgentTemplateDelete;
    impl Op for AgentTemplateDelete {
        const NAME: &'static str = "agent.template.delete";
        type Input = t::AgentDeleteInput;
        type Result = ();
    }
    pub struct SkillList;
    impl Op for SkillList {
        const NAME: &'static str = "skill.list";
        type Input = ();
        type Result = Vec<t::Skill>;
    }
    /// Create allocates an identity; callers with an existing identity use save.
    pub struct SkillCreate;
    impl Op for SkillCreate {
        const NAME: &'static str = "skill.create";
        type Input = t::Skill;
        type Result = t::Skill;
    }
    pub struct SkillUpdate;
    impl Op for SkillUpdate {
        const NAME: &'static str = "skill.update";
        type Input = t::Skill;
        type Result = t::Skill;
    }
    pub struct SkillDelete;
    impl Op for SkillDelete {
        const NAME: &'static str = "skill.delete";
        type Input = t::SkillDeleteInput;
        type Result = ();
    }
}
