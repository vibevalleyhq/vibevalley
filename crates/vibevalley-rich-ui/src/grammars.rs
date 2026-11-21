//! Bundled pure-JSON TextMate grammars for `vibevalley-shiki` (`vibevalley-onig`)
//! and editor language definitions registered into `nsh_base::editor`.

use nsh_base::editor::EditorLanguage;

/// Custom `EditorLanguage` for Mermaid diagram sources (not built into `nsh-base`).
pub static MERMAID_LANGUAGE: EditorLanguage = EditorLanguage::new("Mermaid")
    .aliases(&["mermaid", "mmd"])
    .extensions(&["mmd", "mermaid"])
    .line_comment("%%")
    .tab_size(2);

/// Descriptor tying a bundled TextMate JSON grammar to its canonical Shiki name,
/// Markdown fence aliases, and the `nsh_base::editor` language names it highlights.
#[derive(Debug, Clone, Copy)]
pub struct BundledGrammar {
    pub canonical: &'static str,
    pub editor_names: &'static [&'static str],
    pub aliases: &'static [&'static str],
    pub json: &'static str,
}

/// All TextMate grammars bundled into `vibevalley-rich-ui`.
///
/// Hosts can load richer grammars on top at runtime via [`crate::highlight::register_grammar_json`].
pub const BUNDLED_GRAMMARS: &[BundledGrammar] = &[
    BundledGrammar {
        canonical: "rust",
        editor_names: &["Rust"],
        aliases: &["rs"],
        json: RUST_TM,
    },
    BundledGrammar {
        canonical: "typescript",
        editor_names: &["TypeScript", "TSX"],
        aliases: &["ts", "tsx", "mts", "cts", "typescriptreact"],
        json: TYPESCRIPT_TM,
    },
    BundledGrammar {
        canonical: "javascript",
        editor_names: &["JavaScript", "JSX"],
        aliases: &["js", "jsx", "mjs", "cjs", "javascriptreact"],
        json: JAVASCRIPT_TM,
    },
    BundledGrammar {
        canonical: "json",
        editor_names: &["JSON"],
        aliases: &["jsonc", "json5", "jsonl", "canvas"],
        json: JSON_TM,
    },
    BundledGrammar {
        canonical: "python",
        editor_names: &["Python"],
        aliases: &["py", "python3", "pyi"],
        json: PYTHON_TM,
    },
    BundledGrammar {
        canonical: "shell",
        editor_names: &["Shell"],
        aliases: &["sh", "bash", "zsh", "shellscript", "console"],
        json: SHELL_TM,
    },
    BundledGrammar {
        canonical: "go",
        editor_names: &["Go"],
        aliases: &["golang"],
        json: GO_TM,
    },
    BundledGrammar {
        canonical: "c",
        editor_names: &["C", "C++"],
        aliases: &["h", "cpp", "c++", "cxx", "cc", "hpp"],
        json: C_FAMILY_TM,
    },
    BundledGrammar {
        canonical: "swift",
        editor_names: &["Swift"],
        aliases: &[],
        json: SWIFT_TM,
    },
    BundledGrammar {
        canonical: "sql",
        editor_names: &["SQL"],
        aliases: &["sqlite", "postgres", "postgresql", "mysql"],
        json: SQL_TM,
    },
    BundledGrammar {
        canonical: "html",
        editor_names: &["HTML", "XML"],
        aliases: &["htm", "xhtml", "xml", "svg"],
        json: HTML_TM,
    },
    BundledGrammar {
        canonical: "css",
        editor_names: &["CSS", "SCSS", "Less"],
        aliases: &["scss", "less"],
        json: CSS_TM,
    },
    BundledGrammar {
        canonical: "yaml",
        editor_names: &["YAML"],
        aliases: &["yml"],
        json: YAML_TM,
    },
    BundledGrammar {
        canonical: "toml",
        editor_names: &["TOML"],
        aliases: &[],
        json: TOML_TM,
    },
    BundledGrammar {
        canonical: "markdown",
        editor_names: &["Markdown"],
        aliases: &["md", "gfm", "mdx"],
        json: MARKDOWN_TM,
    },
    BundledGrammar {
        canonical: "diff",
        editor_names: &["Diff"],
        aliases: &["patch", "udiff"],
        json: DIFF_TM,
    },
    BundledGrammar {
        canonical: "mermaid",
        editor_names: &["Mermaid"],
        aliases: &["mmd"],
        json: MERMAID_TM,
    },
];

const RUST_TM: &str = r##"{
  "name": "rust",
  "scopeName": "source.rust",
  "patterns": [
    { "name": "comment.line.double-slash.rust", "match": "//.*$" },
    { "name": "comment.block.rust", "begin": "/\\*", "end": "\\*/" },
    {
      "name": "string.quoted.double.raw.rust",
      "begin": "b?r(#*)\"",
      "end": "\"\\1"
    },
    {
      "name": "string.quoted.double.rust",
      "begin": "b?\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.rust", "match": "\\\\(?:[nrt0'\"\\\\]|x[0-9a-fA-F]{2}|u\\{[0-9a-fA-F_]+\\})" }
      ]
    },
    { "name": "string.quoted.single.char.rust", "match": "b?'(?:\\\\(?:[nrt0'\"\\\\]|x[0-9a-fA-F]{2}|u\\{[0-9a-fA-F_]+\\})|[^'\\\\])'" },
    { "name": "meta.attribute.rust", "match": "#!?\\[[^\\]]*\\]" },
    { "name": "storage.modifier.lifetime.rust", "match": "'(?:static|[a-zA-Z_][a-zA-Z0-9_]*)\\b" },
    { "name": "constant.language.rust", "match": "\\b(?:true|false|Some|None|Ok|Err)\\b" },
    { "name": "variable.language.rust", "match": "\\b(?:self|Self|super|crate)\\b" },
    { "name": "keyword.control.rust", "match": "\\b(?:as|async|await|break|continue|else|for|if|in|loop|match|move|return|try|unsafe|where|while|yield)\\b" },
    { "name": "storage.type.rust", "match": "\\b(?:const|dyn|enum|extern|fn|impl|let|macro_rules|mod|mut|pub|ref|static|struct|trait|type|union|use)\\b" },
    { "name": "support.type.primitive.rust", "match": "\\b(?:bool|char|str|i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|String|Vec|Option|Result|Box|Arc|Rc)\\b" },
    { "name": "support.function.macro.rust", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*!" },
    { "name": "entity.name.function.rust", "match": "\\b[a-z_][a-zA-Z0-9_]*(?=\\s*(?:::<[^>]*>)?\\s*\\()" },
    { "name": "entity.name.type.rust", "match": "\\b[A-Z][a-zA-Z0-9_]*\\b" },
    { "name": "constant.numeric.rust", "match": "\\b(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?\\b" }
  ]
}"##;

const TYPESCRIPT_TM: &str = r##"{
  "name": "typescript",
  "scopeName": "source.ts",
  "patterns": [
    { "name": "comment.line.double-slash.ts", "match": "//.*$" },
    { "name": "comment.block.ts", "begin": "/\\*", "end": "\\*/" },
    {
      "name": "string.template.ts",
      "begin": "`",
      "end": "`",
      "patterns": [
        { "name": "constant.character.escape.ts", "match": "\\\\." },
        { "name": "meta.embedded.expression.ts", "begin": "\\$\\{", "end": "\\}" }
      ]
    },
    {
      "name": "string.quoted.double.ts",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.ts", "match": "\\\\." }
      ]
    },
    {
      "name": "string.quoted.single.ts",
      "begin": "'",
      "end": "'",
      "patterns": [
        { "name": "constant.character.escape.ts", "match": "\\\\." }
      ]
    },
    { "name": "entity.name.tag.tsx", "match": "</?[A-Za-z][A-Za-z0-9_.-]*(?=[\\s/>])" },
    { "name": "constant.language.ts", "match": "\\b(?:true|false|null|undefined|NaN|Infinity)\\b" },
    { "name": "variable.language.ts", "match": "\\b(?:this|super)\\b" },
    { "name": "keyword.control.ts", "match": "\\b(?:as|async|await|break|case|catch|continue|debugger|default|delete|do|else|export|extends|finally|for|from|if|implements|import|in|instanceof|is|keyof|new|of|return|satisfies|switch|throw|try|typeof|void|while|with|yield)\\b" },
    { "name": "storage.type.ts", "match": "\\b(?:abstract|class|const|declare|enum|function|interface|let|namespace|override|private|protected|public|readonly|static|type|var)\\b" },
    { "name": "support.type.primitive.ts", "match": "\\b(?:any|bigint|boolean|never|number|object|string|symbol|unknown|Promise|Record|Readonly|Partial|Array|Map|Set)\\b" },
    { "name": "entity.name.function.ts", "match": "\\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\\s*(?:<[^>]*>)?\\s*\\()" },
    { "name": "entity.name.type.ts", "match": "\\b[A-Z][a-zA-Z0-9_]*\\b" },
    { "name": "constant.numeric.ts", "match": "\\b(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)n?\\b" }
  ]
}"##;

const JAVASCRIPT_TM: &str = r##"{
  "name": "javascript",
  "scopeName": "source.js",
  "patterns": [
    { "name": "comment.line.double-slash.js", "match": "//.*$" },
    { "name": "comment.block.js", "begin": "/\\*", "end": "\\*/" },
    {
      "name": "string.template.js",
      "begin": "`",
      "end": "`",
      "patterns": [
        { "name": "constant.character.escape.js", "match": "\\\\." },
        { "name": "meta.embedded.expression.js", "begin": "\\$\\{", "end": "\\}" }
      ]
    },
    {
      "name": "string.quoted.double.js",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.js", "match": "\\\\." }
      ]
    },
    {
      "name": "string.quoted.single.js",
      "begin": "'",
      "end": "'",
      "patterns": [
        { "name": "constant.character.escape.js", "match": "\\\\." }
      ]
    },
    { "name": "entity.name.tag.jsx", "match": "</?[A-Za-z][A-Za-z0-9_.-]*(?=[\\s/>])" },
    { "name": "constant.language.js", "match": "\\b(?:true|false|null|undefined|NaN|Infinity)\\b" },
    { "name": "variable.language.js", "match": "\\b(?:this|super)\\b" },
    { "name": "keyword.control.js", "match": "\\b(?:async|await|break|case|catch|continue|debugger|default|delete|do|else|export|extends|finally|for|from|if|import|in|instanceof|new|of|return|switch|throw|try|typeof|void|while|with|yield)\\b" },
    { "name": "storage.type.js", "match": "\\b(?:class|const|function|let|static|var)\\b" },
    { "name": "entity.name.function.js", "match": "\\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\\s*\\()" },
    { "name": "entity.name.type.js", "match": "\\b[A-Z][a-zA-Z0-9_]*\\b" },
    { "name": "constant.numeric.js", "match": "\\b(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)n?\\b" }
  ]
}"##;

const JSON_TM: &str = r##"{
  "name": "json",
  "scopeName": "source.json",
  "patterns": [
    { "name": "comment.line.double-slash.json", "match": "//.*$" },
    { "name": "comment.block.json", "begin": "/\\*", "end": "\\*/" },
    { "name": "support.type.property-name.json", "match": "\"(?:\\\\.|[^\"\\\\])*\"(?=\\s*:)" },
    {
      "name": "string.quoted.double.json",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.json", "match": "\\\\(?:[\"\\\\/bfnrt]|u[0-9a-fA-F]{4})" }
      ]
    },
    { "name": "constant.language.json", "match": "\\b(?:true|false|null)\\b" },
    { "name": "constant.numeric.json", "match": "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\\b" }
  ]
}"##;

const PYTHON_TM: &str = r##"{
  "name": "python",
  "scopeName": "source.python",
  "patterns": [
    { "name": "comment.line.number-sign.python", "match": "#.*$" },
    { "name": "string.quoted.triple.python", "begin": "[furbFURB]{0,2}\"\"\"", "end": "\"\"\"" },
    { "name": "string.quoted.triple.python", "begin": "[furbFURB]{0,2}'''", "end": "'''" },
    {
      "name": "string.quoted.double.python",
      "begin": "[furbFURB]{0,2}\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.python", "match": "\\\\." }
      ]
    },
    {
      "name": "string.quoted.single.python",
      "begin": "[furbFURB]{0,2}'",
      "end": "'",
      "patterns": [
        { "name": "constant.character.escape.python", "match": "\\\\." }
      ]
    },
    { "name": "entity.name.function.decorator.python", "match": "@[a-zA-Z_][a-zA-Z0-9_.]*" },
    { "name": "constant.language.python", "match": "\\b(?:True|False|None)\\b" },
    { "name": "variable.language.python", "match": "\\b(?:self|cls)\\b" },
    { "name": "keyword.control.python", "match": "\\b(?:and|as|assert|async|await|break|case|continue|del|elif|else|except|finally|for|from|global|if|import|in|is|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b" },
    { "name": "storage.type.python", "match": "\\b(?:class|def|lambda)\\b" },
    { "name": "support.function.builtin.python", "match": "\\b(?:abs|all|any|bool|bytes|dict|enumerate|filter|float|int|isinstance|len|list|map|max|min|open|print|range|repr|set|sorted|str|sum|tuple|type|zip)\\b" },
    { "name": "entity.name.function.python", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
    { "name": "entity.name.type.python", "match": "\\b[A-Z][a-zA-Z0-9_]*\\b" },
    { "name": "constant.numeric.python", "match": "\\b(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)j?\\b" }
  ]
}"##;

const SHELL_TM: &str = r##"{
  "name": "shell",
  "scopeName": "source.shell",
  "patterns": [
    { "name": "comment.line.number-sign.shell", "match": "(?:^|\\s)#.*$" },
    {
      "name": "string.quoted.double.shell",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.shell", "match": "\\\\." },
        { "name": "variable.other.shell", "match": "\\$(?:\\{[^}]+\\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$])" }
      ]
    },
    { "name": "string.quoted.single.shell", "begin": "'", "end": "'" },
    { "name": "variable.other.shell", "match": "\\$(?:\\{[^}]+\\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$])" },
    { "name": "keyword.control.shell", "match": "\\b(?:if|then|elif|else|fi|for|in|do|done|while|until|case|esac|select|function|return|exit|break|continue|export|local|readonly|unset|shift|trap|eval|exec|source)\\b" },
    { "name": "constant.language.shell", "match": "\\b(?:true|false)\\b" },
    { "name": "entity.other.attribute-name.flag.shell", "match": "(?:^|\\s)--?[A-Za-z0-9][A-Za-z0-9_-]*" },
    { "name": "constant.numeric.shell", "match": "\\b[0-9]+\\b" }
  ]
}"##;

const GO_TM: &str = r##"{
  "name": "go",
  "scopeName": "source.go",
  "patterns": [
    { "name": "comment.line.double-slash.go", "match": "//.*$" },
    { "name": "comment.block.go", "begin": "/\\*", "end": "\\*/" },
    { "name": "string.quoted.raw.go", "begin": "`", "end": "`" },
    {
      "name": "string.quoted.double.go",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.go", "match": "\\\\." }
      ]
    },
    { "name": "string.quoted.single.go", "match": "'(?:\\\\.|[^'\\\\])'" },
    { "name": "constant.language.go", "match": "\\b(?:true|false|nil|iota)\\b" },
    { "name": "keyword.control.go", "match": "\\b(?:break|case|continue|default|defer|else|fallthrough|for|go|goto|if|import|package|range|return|select|switch)\\b" },
    { "name": "storage.type.go", "match": "\\b(?:chan|const|func|interface|map|struct|type|var)\\b" },
    { "name": "support.type.primitive.go", "match": "\\b(?:any|bool|byte|comparable|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\\b" },
    { "name": "entity.name.function.go", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
    { "name": "constant.numeric.go", "match": "\\b(?:0x[0-9a-fA-F_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)\\b" }
  ]
}"##;

const C_FAMILY_TM: &str = r##"{
  "name": "c",
  "scopeName": "source.c",
  "patterns": [
    { "name": "comment.line.double-slash.c", "match": "//.*$" },
    { "name": "comment.block.c", "begin": "/\\*", "end": "\\*/" },
    { "name": "keyword.control.directive.c", "match": "^\\s*#\\s*(?:include|define|undef|ifdef|ifndef|if|elif|else|endif|pragma|error)\\b" },
    {
      "name": "string.quoted.double.c",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.c", "match": "\\\\." }
      ]
    },
    { "name": "string.quoted.single.c", "match": "'(?:\\\\.|[^'\\\\])'" },
    { "name": "constant.language.c", "match": "\\b(?:true|false|NULL|nullptr)\\b" },
    { "name": "keyword.control.c", "match": "\\b(?:break|case|catch|continue|default|delete|do|else|for|goto|if|new|return|sizeof|switch|throw|try|while)\\b" },
    { "name": "storage.type.c", "match": "\\b(?:auto|bool|char|class|const|constexpr|double|enum|extern|float|inline|int|long|namespace|override|private|protected|public|short|signed|static|struct|template|typedef|typename|union|unsigned|using|virtual|void|volatile)\\b" },
    { "name": "entity.name.function.c", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
    { "name": "constant.numeric.c", "match": "\\b(?:0x[0-9a-fA-F']+|[0-9][0-9']*(?:\\.[0-9']+)?(?:[eE][+-]?[0-9]+)?)[uUlLfF]*\\b" }
  ]
}"##;

const SWIFT_TM: &str = r##"{
  "name": "swift",
  "scopeName": "source.swift",
  "patterns": [
    { "name": "comment.line.double-slash.swift", "match": "//.*$" },
    { "name": "comment.block.swift", "begin": "/\\*", "end": "\\*/" },
    {
      "name": "string.quoted.double.swift",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.swift", "match": "\\\\." }
      ]
    },
    { "name": "meta.attribute.swift", "match": "@[A-Za-z_][A-Za-z0-9_]*" },
    { "name": "constant.language.swift", "match": "\\b(?:true|false|nil)\\b" },
    { "name": "variable.language.swift", "match": "\\b(?:self|Self|super)\\b" },
    { "name": "keyword.control.swift", "match": "\\b(?:as|async|await|break|case|catch|continue|default|defer|do|else|fallthrough|for|guard|if|import|in|is|repeat|return|switch|throw|throws|try|where|while)\\b" },
    { "name": "storage.type.swift", "match": "\\b(?:actor|class|enum|extension|fileprivate|func|init|internal|let|mutating|nonisolated|open|override|private|protocol|public|some|static|struct|typealias|var)\\b" },
    { "name": "entity.name.function.swift", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
    { "name": "entity.name.type.swift", "match": "\\b[A-Z][a-zA-Z0-9_]*\\b" },
    { "name": "constant.numeric.swift", "match": "\\b(?:0x[0-9a-fA-F_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?)\\b" }
  ]
}"##;

const SQL_TM: &str = r##"{
  "name": "sql",
  "scopeName": "source.sql",
  "patterns": [
    { "name": "comment.line.double-dash.sql", "match": "--.*$" },
    { "name": "comment.block.sql", "begin": "/\\*", "end": "\\*/" },
    { "name": "string.quoted.single.sql", "begin": "'", "end": "'" },
    { "name": "constant.language.sql", "match": "(?i)\\b(?:NULL|TRUE|FALSE)\\b" },
    { "name": "keyword.control.sql", "match": "(?i)\\b(?:SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|OUTER|ON|AS|AND|OR|NOT|IN|IS|LIKE|GROUP|BY|ORDER|ASC|DESC|LIMIT|OFFSET|HAVING|UNION|ALL|DISTINCT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|CHECK|CONSTRAINT|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|CASE|WHEN|THEN|ELSE|END|RETURNING|EXISTS|CONFLICT|DO|NOTHING)\\b" },
    { "name": "support.type.sql", "match": "(?i)\\b(?:INT|INTEGER|BIGINT|SMALLINT|REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL|TEXT|VARCHAR|CHAR|BLOB|BOOLEAN|BOOL|DATE|TIMESTAMP|JSON|UUID)\\b" },
    { "name": "entity.name.function.sql", "match": "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
    { "name": "constant.numeric.sql", "match": "\\b[0-9]+(?:\\.[0-9]+)?\\b" }
  ]
}"##;

const HTML_TM: &str = r##"{
  "name": "html",
  "scopeName": "text.html.basic",
  "patterns": [
    { "name": "comment.block.html", "begin": "<!--", "end": "-->" },
    { "name": "string.quoted.double.html", "begin": "\"", "end": "\"" },
    { "name": "string.quoted.single.html", "begin": "'", "end": "'" },
    { "name": "entity.name.tag.html", "match": "</?[A-Za-z][A-Za-z0-9:_-]*" },
    { "name": "entity.other.attribute-name.html", "match": "\\b[a-zA-Z_:][a-zA-Z0-9:._-]*(?=\\s*=)" },
    { "name": "constant.character.entity.html", "match": "&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);" }
  ]
}"##;

const CSS_TM: &str = r##"{
  "name": "css",
  "scopeName": "source.css",
  "patterns": [
    { "name": "comment.block.css", "begin": "/\\*", "end": "\\*/" },
    { "name": "comment.line.double-slash.css", "match": "//.*$" },
    { "name": "string.quoted.double.css", "begin": "\"", "end": "\"" },
    { "name": "string.quoted.single.css", "begin": "'", "end": "'" },
    { "name": "keyword.control.at-rule.css", "match": "@[a-zA-Z-]+" },
    { "name": "support.type.property-name.css", "match": "\\b[a-zA-Z-]+(?=\\s*:)" },
    { "name": "constant.other.color.css", "match": "#[0-9a-fA-F]{3,8}\\b" },
    { "name": "constant.numeric.css", "match": "-?[0-9]+(?:\\.[0-9]+)?(?:px|rem|em|vh|vw|%|ms|s|deg|fr)?\\b" },
    { "name": "entity.name.function.css", "match": "\\b[a-zA-Z-]+(?=\\()" }
  ]
}"##;

const YAML_TM: &str = r##"{
  "name": "yaml",
  "scopeName": "source.yaml",
  "patterns": [
    { "name": "comment.line.number-sign.yaml", "match": "(?:^|\\s)#.*$" },
    { "name": "support.type.property-name.yaml", "match": "^\\s*(?:-\\s+)?[A-Za-z0-9_.-]+(?=\\s*:)" },
    { "name": "string.quoted.double.yaml", "begin": "\"", "end": "\"" },
    { "name": "string.quoted.single.yaml", "begin": "'", "end": "'" },
    { "name": "constant.language.yaml", "match": "\\b(?:true|false|null|~|yes|no)\\b" },
    { "name": "constant.numeric.yaml", "match": "\\b-?[0-9]+(?:\\.[0-9]+)?\\b" }
  ]
}"##;

const TOML_TM: &str = r##"{
  "name": "toml",
  "scopeName": "source.toml",
  "patterns": [
    { "name": "comment.line.number-sign.toml", "match": "#.*$" },
    { "name": "entity.name.tag.table.toml", "match": "^\\s*\\[\\[?[^\\]]+\\]\\]?" },
    { "name": "support.type.property-name.toml", "match": "^\\s*[A-Za-z0-9_.-]+(?=\\s*=)" },
    { "name": "string.quoted.triple.toml", "begin": "\"\"\"", "end": "\"\"\"" },
    {
      "name": "string.quoted.double.toml",
      "begin": "\"",
      "end": "\"",
      "patterns": [
        { "name": "constant.character.escape.toml", "match": "\\\\." }
      ]
    },
    { "name": "string.quoted.single.toml", "begin": "'", "end": "'" },
    { "name": "constant.language.toml", "match": "\\b(?:true|false)\\b" },
    { "name": "constant.numeric.toml", "match": "\\b-?[0-9][0-9_]*(?:\\.[0-9_]+)?\\b" }
  ]
}"##;

const MARKDOWN_TM: &str = r##"{
  "name": "markdown",
  "scopeName": "text.html.markdown",
  "patterns": [
    { "name": "markup.heading.markdown", "match": "^#{1,6}\\s+.*$" },
    { "name": "markup.fenced_code.block.markdown", "match": "^```.*$" },
    { "name": "markup.inline.raw.string.markdown", "match": "`[^`]+`" },
    { "name": "markup.bold.markdown", "match": "\\*\\*[^*]+\\*\\*" },
    { "name": "markup.italic.markdown", "match": "(?<!\\*)\\*[^*]+\\*(?!\\*)" },
    { "name": "string.other.link.markdown", "match": "\\[[^\\]]+\\]\\([^)]+\\)" },
    { "name": "comment.quote.markdown", "match": "^>.*$" }
  ]
}"##;

const DIFF_TM: &str = r##"{
  "name": "diff",
  "scopeName": "source.diff",
  "patterns": [
    { "name": "meta.diff.range.diff", "match": "^@@.*@@.*$" },
    { "name": "keyword.control.diff", "match": "^(?:diff --git|index |--- |\\+\\+\\+ ).*$" },
    { "name": "markup.inserted.diff", "match": "^\\+.*$" },
    { "name": "markup.deleted.diff", "match": "^-.*$" }
  ]
}"##;

const MERMAID_TM: &str = r##"{
  "name": "mermaid",
  "scopeName": "source.mermaid",
  "patterns": [
    { "name": "comment.line.percentage.mermaid", "match": "%%.*$" },
    { "name": "string.quoted.double.mermaid", "begin": "\"", "end": "\"" },
    { "name": "keyword.control.mermaid", "match": "\\b(?:flowchart|graph|sequenceDiagram|pie|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|journey|gitGraph|mindmap|timeline|subgraph|end|participant|actor|loop|alt|else|opt|par|and|critical|option|break|rect|note|over|left of|right of|activate|deactivate|classDef|class|style|linkStyle|click|direction|title|showData)\\b" },
    { "name": "constant.language.direction.mermaid", "match": "\\b(?:TB|TD|BT|RL|LR)\\b" },
    { "name": "keyword.operator.arrow.mermaid", "match": "(?:<-->|-->|---|-\\.-|-\\.->|==>|->>|-->>|->|--x|--\\)|-x)" },
    { "name": "constant.numeric.mermaid", "match": "\\b[0-9]+(?:\\.[0-9]+)?\\b" }
  ]
}"##;
