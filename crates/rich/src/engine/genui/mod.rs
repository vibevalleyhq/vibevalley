pub mod error;
pub mod expr;
pub mod resolved;
pub mod runtime;
pub mod spec;
pub mod stream;
pub mod value;

pub use error::GenUiError;
pub use expr::{
    BinaryOp, BuiltinFn, EvalLimits, Expr, Template, TemplatePart, UnaryOp, eval_expr, eval_template, parse_expr, parse_expr_with_limits, parse_template,
    parse_template_with_limits, referenced_keys, template_referenced_keys,
};
pub use resolved::{
    ResolveDiagnostic, ResolvedChart, ResolvedChartContent, ResolvedChartSeries, ResolvedDoc, ResolvedNode, ResolvedNodeKind, ResolvedReactiveChart,
    ResolvedSelectOption, ResolvedTab, ResolvedTableColumn, ResolvedTableRow,
};
pub use runtime::{GenUiDoc, GenUiRuntime, PatchOutcome, RuntimeEvent, RuntimeLimits};
pub use spec::{
    Align, CalloutKind, CategoryBinding, ChartKind, ChartSeriesBinding, ChartSource, ExprSource, FieldPatch, GenUiNode, GenUiSpec, NodeKind, PatchOp,
    PropsPatch, SelectOption, SeriesValuesBinding, StackDirection, TabItem, TableColumn, TableRows, TextAlign, TextExpr, TextSize, Tone, ValueExpr,
};
pub use stream::{GenUiStream, StreamEvent, StreamLimits};
pub use value::{FormatKind, StateStore, StateValue, format_number, format_value};
