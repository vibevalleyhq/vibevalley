pub mod media_library_item {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "media_library_item")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub attachment_id: String,
        pub kind: String,
        #[sea_orm(column_type = "Text")]
        pub origin: String,
        pub added_at: i64,
        pub last_at: i64,
        pub source_job_id: Option<String>,
        pub removed_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
