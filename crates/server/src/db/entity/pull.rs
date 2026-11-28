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
    #[sea_orm(column_type = "Text")]
    pub known_events: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
