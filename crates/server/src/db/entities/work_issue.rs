pub mod issue {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "issue")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        #[sea_orm(unique)]
        pub number: i64,
        #[sea_orm(column_type = "Text")]
        pub title: String,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub repo: Option<String>,
        pub machine_id: Option<String>,
        pub priority: String,
        pub rank: Option<i64>,
        pub deliver: String,
        pub parent: Option<String>,
        pub created_at: i64,
        pub queued_at: Option<i64>,
        pub closed_at: Option<i64>,
        pub reviewed_at: Option<i64>,
        #[sea_orm(column_type = "Text", nullable)]
        pub canceled: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub delivered: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub mandate: String,
        #[sea_orm(column_type = "Text", nullable)]
        pub constraints: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub conflict: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub last_run: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub answer: Option<String>,
        #[sea_orm(column_type = "Text", nullable)]
        pub delivery_evidence: Option<String>,
        #[sea_orm(column_type = "Text")]
        pub queued_words: String,
        #[sea_orm(column_type = "Text")]
        pub blocked_by: String,
        #[sea_orm(column_type = "Text")]
        pub criteria: String,
        #[sea_orm(column_type = "Text")]
        pub checks: String,
        #[sea_orm(column_type = "Text")]
        pub findings: String,
        #[sea_orm(column_type = "Text")]
        pub questions: String,
        #[sea_orm(column_type = "Text")]
        pub assignments: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
