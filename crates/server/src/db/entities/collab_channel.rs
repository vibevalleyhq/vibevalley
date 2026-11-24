pub mod channel_participant {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_participant")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub kind: String,
        pub name: String,
        pub agent_id: Option<String>,
        pub home_id: Option<String>,
        pub joined_at: i64,
        pub left_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        #[sea_orm(column_name = "type")]
        pub channel_type: String,
        pub is_default: bool,
        #[sea_orm(unique)]
        pub root_id: Option<String>,
        pub root_number: Option<i64>,
        pub subject_kind: Option<String>,
        pub subject_id: Option<String>,
        pub last_number: Option<i64>,
        pub reply_count: i64,
        pub created_at: i64,
        pub name: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub description: Option<String>,
        pub repo: Option<String>,
        pub parent_id: Option<String>,
        #[sea_orm(unique)]
        pub peer_id: Option<String>,
        pub revision: i64,
        pub category: Option<String>,
        pub position: Option<i64>,
        pub archived_at: Option<i64>,
        pub notify: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_message {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_message")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub channel_id: String,
        pub number: i64,
        pub sender_id: String,
        pub kind: String,
        #[sea_orm(column_type = "Text")]
        pub body: String,
        #[sea_orm(column_type = "Text", nullable)]
        pub meta: Option<String>,
        pub system_code: Option<String>,
        pub send_key: Option<String>,
        pub created_at: i64,
        pub revision: i64,
        pub reply_number: Option<i64>,
        pub edited_at: Option<i64>,
        pub deleted_at: Option<i64>,
        pub pinned_at: Option<i64>,
        #[sea_orm(column_type = "Text", nullable)]
        pub reactions: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_mention {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_mention")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub message_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub target_id: String,
        pub resolved: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_member {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_member")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub participant_id: String,
        pub reason: String,
        pub from_number: i64,
        pub left_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_read_cursor {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_read_cursor")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub participant_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel_id: String,
        pub read_number: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_seen {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_seen")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub participant_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub message_id: String,
        pub seen_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_event {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_event")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub seq: i64,
        pub kind: String,
        pub channel_id: String,
        pub message_id: String,
        pub at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel_delivery {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_delivery")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub message_id: String,
        pub channel_id: String,
        pub recipient_kind: String,
        pub recipient_id: String,
        pub reason: String,
        pub wakes: bool,
        pub held_by: Option<String>,
        pub status: String,
        pub created_at: i64,
        pub settled_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
