use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "cron")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    pub channel_id: String,
    pub agent: Option<String>,
    pub repo: Option<String>,
    pub issue_id: Option<String>,
    pub spec: String,
    pub tz: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_run: Option<i64>,
    pub set_by: String,
    pub pending: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
