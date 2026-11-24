pub mod session {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "session")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub controller: String,
        pub role: Option<String>,
        pub name: String,
        pub profile: Option<String>,
        pub runtime: String,
        #[sea_orm(column_type = "Text")]
        pub brief: String,
        pub cwd: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub policy: String,
        #[sea_orm(column_type = "Text")]
        pub bindings: String,
        pub hired_at: i64,
        pub runs: i64,
        #[sea_orm(column_type = "Text", nullable)]
        pub last_run: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub spent: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub tool_connections: Option<String>,
        pub machine: Option<String>,
        pub phase: String,
        pub departed: bool,
        pub title: Option<String>,
        pub model: Option<String>,
        pub effort: Option<String>,
        pub permission_mode: Option<String>,
        pub agent_session: Option<String>,
        pub base: Option<String>,
        pub run: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session_run {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "session_run")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub session: String,
        pub issue: Option<String>,
        pub triggered_by: String,
        #[sea_orm(column_type = "Text")]
        pub heard: String,
        pub started_at: i64,
        pub ended_at: Option<i64>,
        pub outcome: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub summary: String,
        #[sea_orm(column_type = "Text", nullable)]
        pub spent: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub subagent_summary: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session_mailbox {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "session_mailbox")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub session_id: String,
        #[sea_orm(unique)]
        pub idempotency_key: String,
        pub source: String,
        pub source_message_id: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub payload: String,
        pub status: String,
        pub created_at: i64,
        pub updated_at: i64,
        #[sea_orm(column_type = "Text", nullable)]
        pub result: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session_event {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "session_event")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub session_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub seq: i64,
        pub run_id: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub payload: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
