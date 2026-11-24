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
