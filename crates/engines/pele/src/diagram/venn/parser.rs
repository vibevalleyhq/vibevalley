use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError, SourceMap, syntax_error};

use super::db::VennDb;
use super::lexer::{IndentHost, VennLexer, VennToken};

const STATEMENT: &str = "'EOF', 'NEWLINE', 'TITLE', 'SET', 'UNION', 'TEXT', 'INDENT_TEXT', 'STYLE'";
const VALUE: &str = "'NUMERIC', 'IDENTIFIER', 'STRING', 'HEXCOLOR', 'RGBCOLOR', 'RGBACOLOR'";

struct VennParser<'a> {
    src: &'a str,
    lexer: VennLexer<'a>,
    origin: Option<&'a SourceMap<'a>>,
    lookahead: Option<VennToken>,
}

impl<'a> VennParser<'a> {
    fn new(src: &'a str, origin: Option<&'a SourceMap<'a>>) -> Self {
        Self {
            src,
            lexer: VennLexer::new(src),
            origin,
            lookahead: None,
        }
    }

    fn peek(&mut self, db: &mut VennDb) -> VennToken {
        match self.lookahead {
            Some(tok) => tok,
            None => {
                let tok = self.lexer.next(db);
                self.lookahead = Some(tok);
                tok
            }
        }
    }

    fn fail(&mut self, db: &mut VennDb, expected: &str) -> PeleError {
        let tok = self.peek(db);
        if tok == VennToken::Error {
            return syntax_error(DiagramType::Venn, self.src, self.lexer.start, "", true, self.origin);
        }
        syntax_error(
            DiagramType::Venn,
            self.src,
            self.lexer.start,
            &format!("Expecting {expected}, got '{}'", tok.name()),
            false,
            self.origin,
        )
    }

    fn take(&mut self) -> &'a str {
        self.lookahead = None;
        self.lexer.text
    }

    fn expect(&mut self, db: &mut VennDb, wanted: VennToken) -> Result<&'a str, PeleError> {
        if self.peek(db) != wanted {
            return Err(self.fail(db, &format!("'{}'", wanted.name())));
        }
        Ok(self.take())
    }

    fn identifier(&mut self, db: &mut VennDb) -> Result<String, PeleError> {
        let tok = self.peek(db);
        if tok != VennToken::Identifier && tok != VennToken::String {
            return Err(self.fail(db, "'IDENTIFIER', 'STRING'"));
        }
        Ok(self.take().to_string())
    }

    fn identifiers(&mut self, db: &mut VennDb) -> Result<Vec<String>, PeleError> {
        let mut list = vec![self.identifier(db)?];
        while self.peek(db) == VennToken::Comma {
            self.take();
            list.push(self.identifier(db)?);
        }
        Ok(list)
    }

    fn subset(&mut self, db: &mut VennDb, ids: Vec<String>, is_union: bool) -> Result<(), PeleError> {
        let label = if self.peek(db) == VennToken::BracketLabel { Some(self.take()) } else { None };
        let size = if self.peek(db) == VennToken::Colon {
            self.take();
            let raw = self.expect(db, VennToken::Numeric)?;
            Some(raw.parse::<f64>().unwrap_or(f64::NAN))
        } else {
            None
        };
        if is_union {
            if ids.len() < 2 {
                return Err(PeleError::new("union requires multiple identifiers", ErrorCode::Semantic).with_diagram_type(DiagramType::Venn));
            }
            db.validate_union_identifiers(&ids)?;
        }
        db.add_subset_data(&ids, label, size);
        db.set_indent_mode(true);
        Ok(())
    }

    fn read_text(&mut self, db: &mut VennDb, sets: Option<Vec<String>>) -> Result<(), PeleError> {
        let kind = self.peek(db);
        if !matches!(kind, VennToken::Identifier | VennToken::String | VennToken::Numeric) {
            return Err(self.fail(db, "'NUMERIC', 'IDENTIFIER', 'STRING'"));
        }
        let id = self.take();
        let label = if kind != VennToken::Numeric && self.peek(db) == VennToken::BracketLabel {
            Some(self.take())
        } else {
            None
        };
        let target_sets = match sets {
            Some(s) => s,
            None => match db.current_sets() {
                Some(cur) => cur.to_vec(),
                None => {
                    return Err(PeleError::new("text requires set", ErrorCode::Semantic).with_diagram_type(DiagramType::Venn));
                }
            },
        };
        db.add_text_data(&target_sets, id, label);
        Ok(())
    }

    fn read_style(&mut self, db: &mut VennDb) -> Result<(), PeleError> {
        let ids = self.identifiers(db)?;
        let mut styles: Vec<(String, String)> = Vec::new();
        loop {
            let key = self.expect(db, VennToken::Identifier)?.to_string();
            self.expect(db, VennToken::Colon)?;
            let value = if self.peek(db) == VennToken::String {
                self.take().to_string()
            } else {
                let mut parts: Vec<&str> = Vec::new();
                while self.peek(db).is_style_value_part() {
                    parts.push(self.take());
                }
                if parts.is_empty() {
                    return Err(self.fail(db, VALUE));
                }
                parts.join(" ")
            };
            styles.push((key, value));
            if self.peek(db) != VennToken::Comma {
                break;
            }
            self.take();
        }
        db.add_style_data(&ids, &styles);
        Ok(())
    }
}

pub fn parse_venn(src: &str, db: &mut VennDb, origin: Option<&SourceMap<'_>>) -> Result<(), PeleError> {
    let mut p = VennParser::new(src, origin);
    while p.peek(db) == VennToken::Newline {
        p.take();
    }
    p.expect(db, VennToken::Venn)?;
    loop {
        let stmt = p.peek(db);
        if stmt == VennToken::Eof {
            return Ok(());
        }
        match stmt {
            VennToken::Newline => {
                p.take();
            }
            VennToken::Title => {
                let raw = p.take();
                let sep_len = raw[5..].chars().next().map_or(0, char::len_utf8);
                db.set_diagram_title(raw[5 + sep_len..].to_string());
            }
            VennToken::Set => {
                p.take();
                let id = p.identifier(db)?;
                p.subset(db, vec![id], false)?;
            }
            VennToken::Union => {
                p.take();
                let ids = p.identifiers(db)?;
                p.subset(db, ids, true)?;
            }
            VennToken::Text => {
                p.take();
                let ids = p.identifiers(db)?;
                p.read_text(db, Some(ids))?;
            }
            VennToken::IndentText => {
                p.take();
                p.read_text(db, None)?;
            }
            VennToken::Style => {
                p.take();
                p.read_style(db)?;
            }
            VennToken::End
            | VennToken::Error
            | VennToken::Eof
            | VennToken::Venn
            | VennToken::BracketLabel
            | VennToken::Numeric
            | VennToken::HexColor
            | VennToken::RgbColor
            | VennToken::RgbaColor
            | VennToken::Identifier
            | VennToken::String
            | VennToken::Comma
            | VennToken::Colon => {
                return Err(p.fail(db, STATEMENT));
            }
        }
    }
}
