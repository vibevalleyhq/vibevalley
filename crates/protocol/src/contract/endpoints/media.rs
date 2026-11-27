use crate::wire::{Caller, Endpoint};

pub(super) const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "media.dialogue.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaSpeakersRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.voiceDesign.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaVoiceDesignRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.clone.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaCloneRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.transcription.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaTranscriptionRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.audio.resume",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.audio.previewCleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.audio.cleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.audio.previewCleanup"),
        input: Some("MediaJobRequest"),
        result: Some("MediaAudioJob"),
    },
    Endpoint {
        op: "media.input.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputRequest"),
        result: Some("MediaInput"),
    },
    Endpoint {
        op: "media.input.adopt",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputAdoptInput"),
        result: Some("MediaInput"),
    },
    Endpoint {
        op: "media.input.list",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: None,
        result: Some("Vec<MediaInput>"),
    },
    Endpoint {
        op: "media.input.delete",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.input.previewDelete"),
        input: Some("MediaJobRequest"),
        result: None,
    },
    Endpoint {
        op: "media.input.previewDelete",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.image.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaImageRequest"),
        result: Some("MediaImageJob"),
    },
    Endpoint {
        op: "media.understanding.create",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaUnderstandingRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.understanding.authorize",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaUnderstandingAuthorizationRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.understanding.start",
        module: "media",
        about: &["id"],
        can: &[Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.speech.create",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaSpeechRequest"),
        result: Some("MediaSpeechJob"),
    },
    Endpoint {
        op: "media.speech.resume",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaSpeechJob"),
    },
    Endpoint {
        op: "media.understanding.cleanup",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaUnderstandingJob"),
    },
    Endpoint {
        op: "media.job.get",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.cancel",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.previewRelease",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("Preview"),
    },
    Endpoint {
        op: "media.job.release",
        module: "media",
        about: &["id"],
        can: &[Caller::User],
        dry_run: Some("media.job.previewRelease"),
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.download",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: Some("MediaJobRequest"),
        result: Some("MediaJob"),
    },
    Endpoint {
        op: "media.job.list",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Orchestrator],
        dry_run: None,
        input: None,
        result: Some("Vec<MediaJob>"),
    },
    Endpoint {
        op: "library.item.list",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("LibraryListRequest"),
        result: Some("LibraryItems"),
    },
    Endpoint {
        op: "library.item.add",
        module: "media",
        about: &[],
        can: &[Caller::User, Caller::Remote, Caller::Orchestrator, Caller::Session],
        dry_run: None,
        input: Some("LibraryAddRequest"),
        result: Some("LibraryItem"),
    },
    Endpoint {
        op: "library.item.delete",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: Some("library.item.previewDelete"),
        input: Some("LibraryItemDeleteInput"),
        result: None,
    },
    Endpoint {
        op: "library.item.previewDelete",
        module: "media",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("LibraryItemDeleteInput"),
        result: Some("Preview"),
    },
];

pub mod ops {
    use crate::contract as t;
    use crate::wire::Op;

    pub struct MediaDialogueCreate;
    impl Op for MediaDialogueCreate {
        const NAME: &'static str = "media.dialogue.create";
        type Input = t::MediaSpeakersRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaVoiceDesignCreate;
    impl Op for MediaVoiceDesignCreate {
        const NAME: &'static str = "media.voiceDesign.create";
        type Input = t::MediaVoiceDesignRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaCloneCreate;
    impl Op for MediaCloneCreate {
        const NAME: &'static str = "media.clone.create";
        type Input = t::MediaCloneRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaTranscriptionCreate;
    impl Op for MediaTranscriptionCreate {
        const NAME: &'static str = "media.transcription.create";
        type Input = t::MediaTranscriptionRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaAudioResume;
    impl Op for MediaAudioResume {
        const NAME: &'static str = "media.audio.resume";
        type Input = t::MediaJobRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaAudioPreviewCleanup;
    impl Op for MediaAudioPreviewCleanup {
        const NAME: &'static str = "media.audio.previewCleanup";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaAudioCleanup;
    impl Op for MediaAudioCleanup {
        const NAME: &'static str = "media.audio.cleanup";
        type Input = t::MediaJobRequest;
        type Result = t::MediaAudioJob;
    }
    pub struct MediaInputCreate;
    impl Op for MediaInputCreate {
        const NAME: &'static str = "media.input.create";
        type Input = t::MediaInputRequest;
        type Result = t::MediaInput;
    }
    /// A kept attachment (a library item) taken as an input, checked as an upload is.
    pub struct MediaInputAdopt;
    impl Op for MediaInputAdopt {
        const NAME: &'static str = "media.input.adopt";
        type Input = t::MediaInputAdoptInput;
        type Result = t::MediaInput;
    }
    pub struct MediaInputList;
    impl Op for MediaInputList {
        const NAME: &'static str = "media.input.list";
        type Input = ();
        type Result = Vec<t::MediaInput>;
    }
    pub struct MediaInputDelete;
    impl Op for MediaInputDelete {
        const NAME: &'static str = "media.input.delete";
        type Input = t::MediaJobRequest;
        type Result = ();
    }
    pub struct MediaInputPreviewDelete;
    impl Op for MediaInputPreviewDelete {
        const NAME: &'static str = "media.input.previewDelete";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaImageCreate;
    impl Op for MediaImageCreate {
        const NAME: &'static str = "media.image.create";
        type Input = t::MediaImageRequest;
        type Result = t::MediaImageJob;
    }
    pub struct MediaUnderstandingCreate;
    impl Op for MediaUnderstandingCreate {
        const NAME: &'static str = "media.understanding.create";
        type Input = t::MediaUnderstandingRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaUnderstandingAuthorize;
    impl Op for MediaUnderstandingAuthorize {
        const NAME: &'static str = "media.understanding.authorize";
        type Input = t::MediaUnderstandingAuthorizationRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaUnderstandingStart;
    impl Op for MediaUnderstandingStart {
        const NAME: &'static str = "media.understanding.start";
        type Input = t::MediaJobRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaSpeechCreate;
    impl Op for MediaSpeechCreate {
        const NAME: &'static str = "media.speech.create";
        type Input = t::MediaSpeechRequest;
        type Result = t::MediaSpeechJob;
    }
    pub struct MediaSpeechResume;
    impl Op for MediaSpeechResume {
        const NAME: &'static str = "media.speech.resume";
        type Input = t::MediaJobRequest;
        type Result = t::MediaSpeechJob;
    }
    pub struct MediaUnderstandingCleanup;
    impl Op for MediaUnderstandingCleanup {
        const NAME: &'static str = "media.understanding.cleanup";
        type Input = t::MediaJobRequest;
        type Result = t::MediaUnderstandingJob;
    }
    pub struct MediaJobGet;
    impl Op for MediaJobGet {
        const NAME: &'static str = "media.job.get";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobCancel;
    impl Op for MediaJobCancel {
        const NAME: &'static str = "media.job.cancel";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobPreviewRelease;
    impl Op for MediaJobPreviewRelease {
        const NAME: &'static str = "media.job.previewRelease";
        type Input = t::MediaJobRequest;
        type Result = t::Preview;
    }
    pub struct MediaJobRelease;
    impl Op for MediaJobRelease {
        const NAME: &'static str = "media.job.release";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobDownload;
    impl Op for MediaJobDownload {
        const NAME: &'static str = "media.job.download";
        type Input = t::MediaJobRequest;
        type Result = t::MediaJob;
    }
    pub struct MediaJobList;
    impl Op for MediaJobList {
        const NAME: &'static str = "media.job.list";
        type Input = ();
        type Result = Vec<t::MediaJob>;
    }
    /// Newest first.
    pub struct LibraryItemList;
    impl Op for LibraryItemList {
        const NAME: &'static str = "library.item.list";
        type Input = t::LibraryListRequest;
        type Result = t::LibraryItems;
    }
    pub struct LibraryItemAdd;
    impl Op for LibraryItemAdd {
        const NAME: &'static str = "library.item.add";
        type Input = t::LibraryAddRequest;
        type Result = t::LibraryItem;
    }
    /// Only the item goes: a message that has the file still opens it.
    pub struct LibraryItemDelete;
    impl Op for LibraryItemDelete {
        const NAME: &'static str = "library.item.delete";
        type Input = t::LibraryItemDeleteInput;
        type Result = ();
    }
    pub struct LibraryItemPreviewDelete;
    impl Op for LibraryItemPreviewDelete {
        const NAME: &'static str = "library.item.previewDelete";
        type Input = t::LibraryItemDeleteInput;
        type Result = t::Preview;
    }
}
