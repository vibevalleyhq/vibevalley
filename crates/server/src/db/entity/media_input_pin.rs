use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "media_input_pin")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub input_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub holder: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
