#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum C4Token {
    End,
    Error,
    DirectionTb,
    DirectionBt,
    DirectionRl,
    DirectionLr,
    Title,
    AccDescription,
    AccTitle,
    AccTitleValue,
    AccDescr,
    AccDescrValue,
    AccDescrMultilineValue,
    Newline,
    C4Context,
    C4Container,
    C4Component,
    C4Dynamic,
    C4Deployment,
    Person,
    PersonExt,
    System,
    SystemDb,
    SystemQueue,
    SystemExt,
    SystemExtDb,
    SystemExtQueue,
    Container,
    ContainerDb,
    ContainerQueue,
    ContainerExt,
    ContainerExtDb,
    ContainerExtQueue,
    Component,
    ComponentDb,
    ComponentQueue,
    ComponentExt,
    ComponentExtDb,
    ComponentExtQueue,
    EnterpriseBoundary,
    SystemBoundary,
    Boundary,
    ContainerBoundary,
    Node,
    NodeL,
    NodeR,
    Rel,
    BiRel,
    RelU,
    RelD,
    RelL,
    RelR,
    RelB,
    RelIndex,
    UpdateElStyle,
    UpdateRelStyle,
    UpdateLayoutConfig,
    EofInStruct,
    AttributeEmpty,
    Str,
    StrKey,
    StrValue,
    LBrace,
    RBrace,
    Eof,
}

impl C4Token {
    pub const fn name(self) -> &'static str {
        match self {
            Self::End => "$end",
            Self::Error => "INVALID",
            Self::DirectionTb => "direction_tb",
            Self::DirectionBt => "direction_bt",
            Self::DirectionRl => "direction_rl",
            Self::DirectionLr => "direction_lr",
            Self::Title => "title",
            Self::AccDescription => "accDescription",
            Self::AccTitle => "acc_title",
            Self::AccTitleValue => "acc_title_value",
            Self::AccDescr => "acc_descr",
            Self::AccDescrValue => "acc_descr_value",
            Self::AccDescrMultilineValue => "acc_descr_multiline_value",
            Self::Newline => "NEWLINE",
            Self::C4Context => "C4_CONTEXT",
            Self::C4Container => "C4_CONTAINER",
            Self::C4Component => "C4_COMPONENT",
            Self::C4Dynamic => "C4_DYNAMIC",
            Self::C4Deployment => "C4_DEPLOYMENT",
            Self::Person => "PERSON",
            Self::PersonExt => "PERSON_EXT",
            Self::System => "SYSTEM",
            Self::SystemDb => "SYSTEM_DB",
            Self::SystemQueue => "SYSTEM_QUEUE",
            Self::SystemExt => "SYSTEM_EXT",
            Self::SystemExtDb => "SYSTEM_EXT_DB",
            Self::SystemExtQueue => "SYSTEM_EXT_QUEUE",
            Self::Container => "CONTAINER",
            Self::ContainerDb => "CONTAINER_DB",
            Self::ContainerQueue => "CONTAINER_QUEUE",
            Self::ContainerExt => "CONTAINER_EXT",
            Self::ContainerExtDb => "CONTAINER_EXT_DB",
            Self::ContainerExtQueue => "CONTAINER_EXT_QUEUE",
            Self::Component => "COMPONENT",
            Self::ComponentDb => "COMPONENT_DB",
            Self::ComponentQueue => "COMPONENT_QUEUE",
            Self::ComponentExt => "COMPONENT_EXT",
            Self::ComponentExtDb => "COMPONENT_EXT_DB",
            Self::ComponentExtQueue => "COMPONENT_EXT_QUEUE",
            Self::EnterpriseBoundary => "ENTERPRISE_BOUNDARY",
            Self::SystemBoundary => "SYSTEM_BOUNDARY",
            Self::Boundary => "BOUNDARY",
            Self::ContainerBoundary => "CONTAINER_BOUNDARY",
            Self::Node => "NODE",
            Self::NodeL => "NODE_L",
            Self::NodeR => "NODE_R",
            Self::Rel => "REL",
            Self::BiRel => "BIREL",
            Self::RelU => "REL_U",
            Self::RelD => "REL_D",
            Self::RelL => "REL_L",
            Self::RelR => "REL_R",
            Self::RelB => "REL_B",
            Self::RelIndex => "REL_INDEX",
            Self::UpdateElStyle => "UPDATE_EL_STYLE",
            Self::UpdateRelStyle => "UPDATE_REL_STYLE",
            Self::UpdateLayoutConfig => "UPDATE_LAYOUT_CONFIG",
            Self::EofInStruct => "EOF_IN_STRUCT",
            Self::AttributeEmpty => "ATTRIBUTE_EMPTY",
            Self::Str => "STR",
            Self::StrKey => "STR_KEY",
            Self::StrValue => "STR_VALUE",
            Self::LBrace => "LBRACE",
            Self::RBrace => "RBRACE",
            Self::Eof => "EOF",
        }
    }

    pub const fn is_header(self) -> bool {
        matches!(
            self,
            Self::C4Context | Self::C4Container | Self::C4Component | Self::C4Dynamic | Self::C4Deployment
        )
    }

    pub const fn is_other(self) -> bool {
        matches!(
            self,
            Self::Title | Self::AccDescription | Self::AccTitle | Self::AccDescr | Self::AccDescrMultilineValue
        )
    }

    pub const fn is_diagram(self) -> bool {
        matches!(
            self,
            Self::Person
                | Self::PersonExt
                | Self::System
                | Self::SystemDb
                | Self::SystemQueue
                | Self::SystemExt
                | Self::SystemExtDb
                | Self::SystemExtQueue
                | Self::Container
                | Self::ContainerDb
                | Self::ContainerQueue
                | Self::ContainerExt
                | Self::ContainerExtDb
                | Self::ContainerExtQueue
                | Self::Component
                | Self::ComponentDb
                | Self::ComponentQueue
                | Self::ComponentExt
                | Self::ComponentExtDb
                | Self::ComponentExtQueue
                | Self::EnterpriseBoundary
                | Self::SystemBoundary
                | Self::Boundary
                | Self::ContainerBoundary
                | Self::Node
                | Self::NodeL
                | Self::NodeR
                | Self::Rel
                | Self::BiRel
                | Self::RelU
                | Self::RelD
                | Self::RelL
                | Self::RelR
                | Self::RelB
                | Self::RelIndex
                | Self::UpdateElStyle
                | Self::UpdateRelStyle
                | Self::UpdateLayoutConfig
        )
    }
}
