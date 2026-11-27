use crate::wire::{Caller, SubscriptionSpec};

mod t {
    pub use crate::contract::*;
}

/// Every server subscription, naming who may subscribe (`can`) and its wire payload/event types.
pub const SUBSCRIPTIONS: &[SubscriptionSpec] = &[
    SubscriptionSpec {
        name: "channel.follow",
        module: "channel",
        can: &[Caller::User, Caller::Remote],
        payload: "ChannelFollowPayload",
        event: "ChannelEvent",
    },
    SubscriptionSpec {
        name: "channel.reports",
        module: "channel",
        can: &[Caller::User, Caller::Remote],
        payload: "ChannelReportsPayload",
        event: "ChannelEvent",
    },
    SubscriptionSpec {
        name: "note.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NoteFollowPayload",
        event: "NoteEvent",
    },
    SubscriptionSpec {
        name: "note.suggestion.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NoteSuggestionFollowPayload",
        event: "SuggestionEvent",
    },
    SubscriptionSpec {
        name: "note.presence.follow",
        module: "note",
        can: &[Caller::User, Caller::Remote],
        payload: "NotePresenceFollowRequest",
        event: "NotePresenceEvent",
    },
    SubscriptionSpec {
        name: "session.watch",
        module: "session",
        can: &[Caller::User, Caller::Remote],
        payload: "SessionWatchPayload",
        event: "SessionWatchEvent",
    },
    SubscriptionSpec {
        name: "issue.watch",
        module: "issue",
        can: &[Caller::User, Caller::Remote],
        payload: "IssueGetInput",
        event: "IssueWatch",
    },
];

/// Subscriptions as types: each one's name, allowed callers, payload, and event.
pub mod subscriptions {
    use super::t;
    use crate::wire::{Caller, Subscription};

    pub struct ChannelFollow;
    impl Subscription for ChannelFollow {
        const NAME: &'static str = "channel.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::ChannelFollowPayload;
        type Event = t::ChannelEvent;
    }
    pub struct ChannelReports;
    impl Subscription for ChannelReports {
        const NAME: &'static str = "channel.reports";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::ChannelReportsPayload;
        type Event = t::ChannelEvent;
    }
    pub struct NoteFollow;
    impl Subscription for NoteFollow {
        const NAME: &'static str = "note.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NoteFollowPayload;
        type Event = t::NoteEvent;
    }
    pub struct NoteSuggestionFollow;
    impl Subscription for NoteSuggestionFollow {
        const NAME: &'static str = "note.suggestion.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NoteSuggestionFollowPayload;
        type Event = t::SuggestionEvent;
    }
    pub struct NotePresenceFollow;
    impl Subscription for NotePresenceFollow {
        const NAME: &'static str = "note.presence.follow";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::NotePresenceFollowRequest;
        type Event = t::NotePresenceEvent;
    }
    pub struct SessionWatch;
    impl Subscription for SessionWatch {
        const NAME: &'static str = "session.watch";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::SessionWatchPayload;
        type Event = t::SessionWatchEvent;
    }
    pub struct IssueWatch;
    impl Subscription for IssueWatch {
        const NAME: &'static str = "issue.watch";
        const CAN: &'static [Caller] = &[Caller::User, Caller::Remote];
        type Payload = t::IssueGetInput;
        type Event = t::IssueWatch;
    }
}
