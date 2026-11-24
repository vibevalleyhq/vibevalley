pub mod artifact {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        #[sea_orm(column_type = "Text")]
        pub title: String,
        pub body: String,
        pub artifact_type: Option<String>,
        pub is_default: bool,
        pub display: Option<String>,
        pub channel_id: Option<String>,
        pub message_id: Option<String>,
        pub issue: Option<String>,
        pub by_id: String,
        pub by_name: String,
        pub version: i64,
        pub seq: i64,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_version {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_version")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub artifact_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub version: i64,
        pub attachment_id: String,
        pub size: i64,
        #[sea_orm(column_type = "Text", nullable)]
        pub note: Option<String>,
        pub by_id: String,
        pub by_name: String,
        pub message_id: Option<String>,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_block {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_block")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub artifact_id: String,
        pub parent_id: Option<String>,
        pub order_key: String,
        #[sea_orm(column_name = "type")]
        pub block_type: String,
        #[sea_orm(column_type = "Text")]
        pub attrs: String,
        #[sea_orm(column_type = "Text")]
        pub spans: String,
        pub rev: i64,
        pub deleted: bool,
        pub updated_by: String,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_block_revision {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_block_revision")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub block_id: String,
        pub rev: i64,
        #[sea_orm(column_type = "Text")]
        pub spans: String,
        pub actor: String,
        pub kind: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_change {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_change")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub artifact_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub seq: i64,
        pub kind: String,
        #[sea_orm(unique)]
        pub batch_id: Option<String>,
        pub actor: String,
        #[sea_orm(column_type = "Text")]
        pub targets: String,
        #[sea_orm(column_type = "Text")]
        pub payload: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_suggestion {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_suggestion")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub artifact_id: String,
        pub block_id: String,
        pub author: String,
        pub origin: Option<String>,
        pub at_rev: i64,
        #[sea_orm(column_type = "Text")]
        pub change: String,
        pub cursor_start: Option<String>,
        pub cursor_end: Option<String>,
        pub start_offset: Option<i64>,
        pub end_offset: Option<i64>,
        #[sea_orm(column_type = "Text", nullable)]
        pub anchor_text: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub replacement_text: Option<String>,
        pub status: String,
        pub created_at: i64,
        pub resolved_at: Option<i64>,
        pub resolved_by: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_entry {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_entry")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub artifact_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub path: String,
        pub kind: String,
        pub mime: String,
        #[sea_orm(column_type = "Text", nullable)]
        pub value: Option<String>,
        pub attachment_id: Option<String>,
        pub size: i64,
        pub rev: i64,
        pub updated_by: String,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod artifact_collab {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "artifact_collab")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub artifact_id: String,
        #[sea_orm(column_type = "Blob")]
        pub snapshot: Vec<u8>,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
