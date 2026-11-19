use super::types::DiagnosticId;

pub const EMITTED: &[DiagnosticId] = &[DiagnosticId::ShapeUnsupported, DiagnosticId::ShapeRemoved, DiagnosticId::ContainmentViolation];

pub const RESERVED: &[DiagnosticId] = &[
    DiagnosticId::EdgeOperatorUnsupported,
    DiagnosticId::ReferenceEdgeLabelRejected,
    DiagnosticId::ConnectorRefUnresolved,
    DiagnosticId::ConnectorRefNotAConnector,
    DiagnosticId::MetadataKeyMisapplied,
    DiagnosticId::DuplicateIdNode,
    DiagnosticId::ReservedSyntheticId,
    DiagnosticId::EdgeSemanticContradiction,
    DiagnosticId::FlowNoInput,
];

pub const fn is_emitted(id: DiagnosticId) -> bool {
    match id {
        DiagnosticId::ShapeUnsupported | DiagnosticId::ShapeRemoved | DiagnosticId::ContainmentViolation => true,
        DiagnosticId::EdgeOperatorUnsupported
        | DiagnosticId::ReferenceEdgeLabelRejected
        | DiagnosticId::ConnectorRefUnresolved
        | DiagnosticId::ConnectorRefNotAConnector
        | DiagnosticId::MetadataKeyMisapplied
        | DiagnosticId::DuplicateIdNode
        | DiagnosticId::ReservedSyntheticId
        | DiagnosticId::EdgeSemanticContradiction
        | DiagnosticId::FlowNoInput => false,
    }
}

pub const fn is_reserved(id: DiagnosticId) -> bool {
    !is_emitted(id)
}
