pub mod pull {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "pull")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub platform: String,
        pub repo: String,
        pub number: i64,
        pub url: String,
        pub branch: String,
        pub base: String,
        pub state: String,
        pub issue_id: Option<String>,
        pub check_fingerprint: String,
        pub check_revision: i64,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod pull_event {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "pull_event")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub pull_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub bot_round_key: Option<String>,
        pub bot_round: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
