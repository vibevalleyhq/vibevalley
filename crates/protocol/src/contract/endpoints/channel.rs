use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "channel.message.send",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: Some("SayRequest"),
        result: None,
    },
    Endpoint {
        op: "channel.create",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("ChannelRequest"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.update",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: Some("ChannelUpdateInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.list",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("ChannelMessageListInput"),
        result: Some("Vec<ChatMessage>"),
    },
    Endpoint {
        op: "channel.markRead",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMarkReadInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.update",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MessageEdit"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.message.delete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("channel.message.previewDelete"),
        input: Some("ChannelMessageDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "channel.message.previewDelete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMessageDeleteInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "channel.message.search",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("MessageSearch"),
        result: Some("Vec<MessageHit>"),
    },
    Endpoint {
        op: "channel.reaction.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ReactionSet"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.pin.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinSetInput"),
        result: Some("ChatMessage"),
    },
    Endpoint {
        op: "channel.pin.list",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinListInput"),
        result: Some("Vec<ChatMessage>"),
    },
    Endpoint {
        op: "channel.thread.create",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelThreadCreateInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.archive.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("OnSet"),
        result: None,
    },
    Endpoint {
        op: "channel.delete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("channel.previewDelete"),
        input: Some("ChannelPinListInput"),
        result: None,
    },
    Endpoint {
        op: "channel.previewDelete",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelPinListInput"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "channel.direct.create",
        module: "channel",
        about: &["agent"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelDirectCreateInput"),
        result: Some("String"),
    },
    Endpoint {
        op: "channel.notify.set",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("NotifyRequest"),
        result: None,
    },
    Endpoint {
        op: "channel.markUnread",
        module: "channel",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ChannelMarkUnreadInput"),
        result: None,
    },
    Endpoint {
        op: "channel.list",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<Channel>"),
    },
    Endpoint {
        op: "channel.unread.list",
        module: "channel",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Session],
        dry_run: None,
        input: None,
        result: Some("Vec<ChannelUnread>"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct ChannelMessageSend;
    impl Op for ChannelMessageSend {
        const NAME: &'static str = "channel.message.send";
        type Input = t::SayRequest;
        type Result = ();
    }
    pub struct ChannelCreate;
    impl Op for ChannelCreate {
        const NAME: &'static str = "channel.create";
        type Input = t::ChannelRequest;
        type Result = String;
    }
    pub struct ChannelUpdate;
    impl Op for ChannelUpdate {
        const NAME: &'static str = "channel.update";
        type Input = t::ChannelUpdateInput;
        type Result = ();
    }
    /// What deleteTask would do, refused as it would be; nothing changes.
    pub struct ChannelMessageList;
    impl Op for ChannelMessageList {
        const NAME: &'static str = "channel.message.list";
        type Input = t::ChannelMessageListInput;
        type Result = Vec<t::ChatMessage>;
    }
    pub struct ChannelMarkRead;
    impl Op for ChannelMarkRead {
        const NAME: &'static str = "channel.markRead";
        type Input = t::ChannelMarkReadInput;
        type Result = ();
    }
    /// The user's own words, changed; nobody is told again.
    pub struct ChannelMessageUpdate;
    impl Op for ChannelMessageUpdate {
        const NAME: &'static str = "channel.message.update";
        type Input = t::MessageEdit;
        type Result = t::ChatMessage;
    }
    /// Any message: its words go, its number stays, and what it still had to hand is dropped.
    pub struct ChannelMessageDelete;
    impl Op for ChannelMessageDelete {
        const NAME: &'static str = "channel.message.delete";
        type Input = t::ChannelMessageDeleteInput;
        type Result = ();
    }
    /// What channel.message.delete would do, refused as it would be; nothing changes.
    pub struct ChannelMessagePreviewDelete;
    impl Op for ChannelMessagePreviewDelete {
        const NAME: &'static str = "channel.message.previewDelete";
        type Input = t::ChannelMessageDeleteInput;
        type Result = t::Preview;
    }
    pub struct ChannelMessageSearch;
    impl Op for ChannelMessageSearch {
        const NAME: &'static str = "channel.message.search";
        type Input = t::MessageSearch;
        type Result = Vec<t::MessageHit>;
    }
    /// The user's reaction on or off; as it already is, nothing changes.
    pub struct ChannelReactionSet;
    impl Op for ChannelReactionSet {
        const NAME: &'static str = "channel.reaction.set";
        type Input = t::ReactionSet;
        type Result = t::ChatMessage;
    }
    /// The message pinned or not; as it already is, nothing changes.
    pub struct ChannelPinSet;
    impl Op for ChannelPinSet {
        const NAME: &'static str = "channel.pin.set";
        type Input = t::ChannelPinSetInput;
        type Result = t::ChatMessage;
    }
    /// A channel's pinned messages, newest pinned first.
    pub struct ChannelPinList;
    impl Op for ChannelPinList {
        const NAME: &'static str = "channel.pin.list";
        type Input = t::ChannelPinListInput;
        type Result = Vec<t::ChatMessage>;
    }
    /// The thread under a message, made if it has none: its id. requestKey: as IssueRequest's.
    pub struct ChannelThreadCreate;
    impl Op for ChannelThreadCreate {
        const NAME: &'static str = "channel.thread.create";
        type Input = t::ChannelThreadCreateInput;
        type Result = String;
    }
    /// Out of the sidebar and the thread lists (on), or back. its messages and address stay.
    pub struct ChannelArchiveSet;
    impl Op for ChannelArchiveSet {
        const NAME: &'static str = "channel.archive.set";
        type Input = t::OnSet;
        type Result = ();
    }
    /// A channel nothing points at any more, with its threads and messages.
    pub struct ChannelDelete;
    impl Op for ChannelDelete {
        const NAME: &'static str = "channel.delete";
        type Input = t::ChannelPinListInput;
        type Result = ();
    }
    /// What channel.delete would do, refused as it would be; nothing changes.
    pub struct ChannelPreviewDelete;
    impl Op for ChannelPreviewDelete {
        const NAME: &'static str = "channel.previewDelete";
        type Input = t::ChannelPinListInput;
        type Result = t::Preview;
    }
    /// The user's direct channel with a helper profile (or the orchestrator), made if there is none: its id.
    pub struct ChannelDirectCreate;
    impl Op for ChannelDirectCreate {
        const NAME: &'static str = "channel.direct.create";
        type Input = t::ChannelDirectCreateInput;
        type Result = String;
    }
    pub struct ChannelNotifySet;
    impl Op for ChannelNotifySet {
        const NAME: &'static str = "channel.notify.set";
        type Input = t::NotifyRequest;
        type Result = ();
    }
    /// The user's read moved back to just before this message.
    pub struct ChannelMarkUnread;
    impl Op for ChannelMarkUnread {
        const NAME: &'static str = "channel.markUnread";
        type Input = t::ChannelMarkUnreadInput;
        type Result = ();
    }
    /// Every channel and direct channel, the default first.
    pub struct ChannelList;
    impl Op for ChannelList {
        const NAME: &'static str = "channel.list";
        type Input = ();
        type Result = Vec<t::Channel>;
    }
    /// The places the caller has not read all of, the newest first.
    pub struct ChannelUnreadList;
    impl Op for ChannelUnreadList {
        const NAME: &'static str = "channel.unread.list";
        type Input = ();
        type Result = Vec<t::ChannelUnread>;
    }
}
