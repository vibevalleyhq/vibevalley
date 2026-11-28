use crate::engine::genui::error::GenUiError;
use crate::engine::genui::value::StateValue;

use super::ast::{BinaryOp, BuiltinFn, EvalLimits, Expr, Template, TemplatePart, UnaryOp};
use super::lexer::{RawTemplatePart, Token, TokenKind, scan_raw_template, tokenize};

pub fn parse_expr(source: &str) -> Result<Expr, GenUiError> {
    parse_expr_with_limits(source, EvalLimits::default())
}

pub fn parse_expr_with_limits(source: &str, limits: EvalLimits) -> Result<Expr, GenUiError> {
    let trimmed = strip_leading_formula_eq(source);
    parse_expr_nested(trimmed, 0, limits)
}

pub fn parse_template(source: &str) -> Result<Template, GenUiError> {
    parse_template_with_limits(source, EvalLimits::default())
}

pub fn parse_template_with_limits(source: &str, limits: EvalLimits) -> Result<Template, GenUiError> {
    let raw_parts = scan_raw_template(source, false, limits.max_depth)?;
    let parts = compile_template_parts(raw_parts, 0, limits)?;
    Ok(Template { parts })
}

fn strip_leading_formula_eq(source: &str) -> &str {
    let trimmed = source.trim();
    if let Some(rest) = trimmed.strip_prefix('=')
        && !rest.starts_with('=')
    {
        return rest;
    }
    trimmed
}

fn compile_template_parts(raw_parts: Vec<RawTemplatePart>, depth: usize, limits: EvalLimits) -> Result<Vec<TemplatePart>, GenUiError> {
    let mut compiled = Vec::with_capacity(raw_parts.len());
    for part in raw_parts {
        match part {
            RawTemplatePart::Literal(text) => compiled.push(TemplatePart::Literal(text)),
            RawTemplatePart::Expr { source, pos } => {
                let expr = parse_expr_nested(&source, depth + 1, limits).map_err(|err| {
                    if let GenUiError::ExprParse { pos: inner_pos, message } = err {
                        GenUiError::ExprParse { pos: pos + inner_pos, message }
                    } else {
                        err
                    }
                })?;
                compiled.push(TemplatePart::Expr(expr));
            }
        }
    }
    Ok(compiled)
}

fn parse_expr_nested(source: &str, depth: usize, limits: EvalLimits) -> Result<Expr, GenUiError> {
    if depth > limits.max_depth {
        return Err(GenUiError::DepthLimitExceeded { limit: limits.max_depth });
    }
    let tokens = tokenize(source, limits.max_depth)?;
    let mut parser = Parser {
        tokens,
        cursor: 0,
        depth,
        limits,
    };
    let expr = parser.parse_ternary()?;
    if parser.peek().kind != TokenKind::Eof {
        return Err(GenUiError::ExprParse {
            pos: parser.peek().pos,
            message: "unexpected trailing token in expression".to_owned(),
        });
    }
    Ok(expr)
}

struct Parser {
    tokens: Vec<Token>,
    cursor: usize,
    depth: usize,
    limits: EvalLimits,
}

impl Parser {
    fn enter_depth(&mut self) -> Result<(), GenUiError> {
        self.depth += 1;
        if self.depth > self.limits.max_depth {
            return Err(GenUiError::DepthLimitExceeded { limit: self.limits.max_depth });
        }
        Ok(())
    }

    fn leave_depth(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.cursor.min(self.tokens.len() - 1)]
    }

    fn peek_at(&self, offset: usize) -> &Token {
        let idx = (self.cursor + offset).min(self.tokens.len() - 1);
        &self.tokens[idx]
    }

    fn advance(&mut self) -> Token {
        let tok = self.peek().clone();
        if self.cursor + 1 < self.tokens.len() {
            self.cursor += 1;
        }
        tok
    }

    fn expect(&mut self, expected: &TokenKind, label: &str) -> Result<(), GenUiError> {
        if &self.peek().kind == expected {
            self.advance();
            Ok(())
        } else {
            Err(GenUiError::ExprParse {
                pos: self.peek().pos,
                message: format!("expected {label}"),
            })
        }
    }

    fn parse_ternary(&mut self) -> Result<Expr, GenUiError> {
        self.enter_depth()?;
        let cond = self.parse_or()?;
        let result = if matches!(self.peek().kind, TokenKind::Question) {
            self.advance();
            let then_branch = self.parse_ternary()?;
            self.expect(&TokenKind::Colon, "`:` in ternary expression")?;
            let else_branch = self.parse_ternary()?;
            Ok(Expr::Ternary {
                cond: Box::new(cond),
                then_branch: Box::new(then_branch),
                else_branch: Box::new(else_branch),
            })
        } else {
            Ok(cond)
        };
        self.leave_depth();
        result
    }

    fn parse_or(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_and()?;
        while matches!(self.peek().kind, TokenKind::OrOr) {
            self.advance();
            let right = self.parse_and()?;
            left = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_equality()?;
        while matches!(self.peek().kind, TokenKind::AndAnd) {
            self.advance();
            let right = self.parse_equality()?;
            left = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_equality(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_comparison()?;
        loop {
            let op = if self.peek().kind == TokenKind::EqEq {
                BinaryOp::Eq
            } else if self.peek().kind == TokenKind::BangEq {
                BinaryOp::Ne
            } else {
                break;
            };
            self.advance();
            let right = self.parse_comparison()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_comparison(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_additive()?;
        loop {
            let op = if self.peek().kind == TokenKind::Lt {
                BinaryOp::Lt
            } else if self.peek().kind == TokenKind::LtEq {
                BinaryOp::Le
            } else if self.peek().kind == TokenKind::Gt {
                BinaryOp::Gt
            } else if self.peek().kind == TokenKind::GtEq {
                BinaryOp::Ge
            } else {
                break;
            };
            self.advance();
            let right = self.parse_additive()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_multiplicative()?;
        loop {
            let op = if self.peek().kind == TokenKind::Plus {
                BinaryOp::Add
            } else if self.peek().kind == TokenKind::Minus {
                BinaryOp::Sub
            } else {
                break;
            };
            self.advance();
            let right = self.parse_multiplicative()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr, GenUiError> {
        let mut left = self.parse_unary()?;
        loop {
            let op = if self.peek().kind == TokenKind::Star {
                BinaryOp::Mul
            } else if self.peek().kind == TokenKind::Slash {
                BinaryOp::Div
            } else if self.peek().kind == TokenKind::Percent {
                BinaryOp::Mod
            } else {
                break;
            };
            self.advance();
            let right = self.parse_unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, GenUiError> {
        let op = if self.peek().kind == TokenKind::Minus {
            Some(UnaryOp::Neg)
        } else if self.peek().kind == TokenKind::Bang {
            Some(UnaryOp::Not)
        } else if self.peek().kind == TokenKind::Plus {
            Some(UnaryOp::Pos)
        } else {
            None
        };
        if let Some(op) = op {
            self.enter_depth()?;
            self.advance();
            let operand = self.parse_unary()?;
            self.leave_depth();
            return Ok(Expr::Unary {
                op,
                operand: Box::new(operand),
            });
        }
        self.parse_power()
    }

    fn parse_power(&mut self) -> Result<Expr, GenUiError> {
        let base = self.parse_postfix()?;
        if self.peek().kind == TokenKind::Caret {
            self.enter_depth()?;
            self.advance();
            let exponent = self.parse_unary()?;
            self.leave_depth();
            return Ok(Expr::Binary {
                op: BinaryOp::Pow,
                left: Box::new(base),
                right: Box::new(exponent),
            });
        }
        Ok(base)
    }

    fn parse_postfix(&mut self) -> Result<Expr, GenUiError> {
        let mut expr = self.parse_primary()?;
        loop {
            if self.peek().kind == TokenKind::Dot {
                self.advance();
                let tok = self.advance();
                let TokenKind::Ident(name) = tok.kind else {
                    return Err(GenUiError::ExprParse {
                        pos: tok.pos,
                        message: "expected field name after `.`".to_owned(),
                    });
                };
                expr = Expr::Field { target: Box::new(expr), name };
            } else if self.peek().kind == TokenKind::LBracket {
                self.advance();
                let index = self.parse_ternary()?;
                self.expect(&TokenKind::RBracket, "`]` after index expression")?;
                expr = Expr::Index {
                    target: Box::new(expr),
                    index: Box::new(index),
                };
            } else {
                break;
            }
        }
        Ok(expr)
    }

    fn parse_primary(&mut self) -> Result<Expr, GenUiError> {
        let tok = self.advance();
        match tok.kind {
            TokenKind::Null => Ok(Expr::Literal(StateValue::Null)),
            TokenKind::True => Ok(Expr::Literal(StateValue::Bool(true))),
            TokenKind::False => Ok(Expr::Literal(StateValue::Bool(false))),
            TokenKind::Number(n) => Ok(Expr::Literal(StateValue::Number(n))),
            TokenKind::Text(s) => Ok(Expr::Literal(StateValue::Text(s))),
            TokenKind::Template(raw_parts) => {
                let parts = compile_template_parts(raw_parts, self.depth, self.limits)?;
                Ok(Expr::Template(parts))
            }
            TokenKind::StateVar(name) => Ok(Expr::Var(name)),
            TokenKind::Ident(name) => {
                if matches!(self.peek().kind, TokenKind::LParen) {
                    self.advance();
                    self.parse_call(&name)
                } else {
                    Ok(Expr::Var(name))
                }
            }
            TokenKind::LParen => {
                let expr = self.parse_ternary()?;
                self.expect(&TokenKind::RParen, "`)`")?;
                Ok(expr)
            }
            TokenKind::LBracket => {
                let mut items = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RBracket | TokenKind::Eof) {
                    items.push(self.parse_ternary()?);
                    if items.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RBracket, "`]`")?;
                Ok(Expr::List(items))
            }
            TokenKind::LBrace => {
                let mut entries = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RBrace | TokenKind::Eof) {
                    let key_tok = self.advance();
                    let key = if let TokenKind::Ident(k) | TokenKind::Text(k) = key_tok.kind {
                        k
                    } else {
                        return Err(GenUiError::ExprParse {
                            pos: key_tok.pos,
                            message: "expected record field key".to_owned(),
                        });
                    };
                    self.expect(&TokenKind::Colon, "`:` after record key")?;
                    let value = self.parse_ternary()?;
                    entries.push((key, value));
                    if entries.len() > self.limits.max_collection_len {
                        return Err(GenUiError::CollectionLimitExceeded {
                            limit: self.limits.max_collection_len,
                        });
                    }
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RBrace, "`}`")?;
                Ok(Expr::Record(entries))
            }
            TokenKind::Plus
            | TokenKind::Minus
            | TokenKind::Star
            | TokenKind::Slash
            | TokenKind::Percent
            | TokenKind::Caret
            | TokenKind::Bang
            | TokenKind::EqEq
            | TokenKind::BangEq
            | TokenKind::Lt
            | TokenKind::LtEq
            | TokenKind::Gt
            | TokenKind::GtEq
            | TokenKind::AndAnd
            | TokenKind::OrOr
            | TokenKind::Question
            | TokenKind::Colon
            | TokenKind::FatArrow
            | TokenKind::Dot
            | TokenKind::Comma
            | TokenKind::RParen
            | TokenKind::RBracket
            | TokenKind::RBrace
            | TokenKind::Eof => Err(GenUiError::ExprParse {
                pos: tok.pos,
                message: "expected expression".to_owned(),
            }),
        }
    }

    fn parse_call(&mut self, name: &str) -> Result<Expr, GenUiError> {
        match name {
            "map" => self.parse_higher_order(HigherOrderKind::Map),
            "filter" => self.parse_higher_order(HigherOrderKind::Filter),
            "sort_by" => self.parse_higher_order(HigherOrderKind::SortBy),
            "any" => self.parse_higher_order(HigherOrderKind::Any),
            "all" => self.parse_higher_order(HigherOrderKind::All),
            _ => {
                let Some(func) = BuiltinFn::from_name(name) else {
                    return Err(GenUiError::UnknownFunction { name: name.to_owned() });
                };
                let mut args = Vec::new();
                while !matches!(self.peek().kind, TokenKind::RParen | TokenKind::Eof) {
                    args.push(self.parse_ternary()?);
                    if matches!(self.peek().kind, TokenKind::Comma) {
                        self.advance();
                    } else {
                        break;
                    }
                }
                self.expect(&TokenKind::RParen, "`)` after function arguments")?;
                Ok(Expr::Call { func, args })
            }
        }
    }

    fn parse_higher_order(&mut self, kind: HigherOrderKind) -> Result<Expr, GenUiError> {
        let fn_name = kind.name();
        if matches!(self.peek().kind, TokenKind::RParen) {
            return Err(GenUiError::ArityMismatch {
                function: fn_name.to_owned(),
                expected: "2..=4".to_owned(),
                actual: 0,
            });
        }
        let list = self.parse_ternary()?;
        self.expect(&TokenKind::Comma, "`,` after list argument")?;

        let (param, index_param, body, mut trailing_order) = if let Some((p, idx)) = self.try_parse_lambda_header() {
            let expr = self.parse_ternary()?;
            let order = if matches!(kind, HigherOrderKind::SortBy) && matches!(self.peek().kind, TokenKind::Comma) {
                self.advance();
                Some(self.parse_sort_order()?)
            } else {
                None
            };
            (p, idx, expr, order)
        } else {
            let mut rest = Vec::new();
            while !matches!(self.peek().kind, TokenKind::RParen | TokenKind::Eof) {
                rest.push(self.parse_ternary()?);
                if matches!(self.peek().kind, TokenKind::Comma) {
                    self.advance();
                } else {
                    break;
                }
            }
            let order = if matches!(kind, HigherOrderKind::SortBy) && rest.len() >= 3 {
                if let Some(Expr::Literal(StateValue::Text(dir))) = rest.last()
                    && (dir == "asc" || dir == "desc")
                {
                    let desc = dir == "desc";
                    rest.pop();
                    Some(desc)
                } else {
                    None
                }
            } else {
                None
            };
            match rest.len() {
                1 => ("item".to_owned(), Some("index".to_owned()), rest.remove(0), order),
                2 => {
                    let second = rest.remove(0);
                    let body = rest.remove(0);
                    let Expr::Var(param) = second else {
                        return Err(GenUiError::ExprParse {
                            pos: self.peek().pos,
                            message: format!("`{fn_name}` expects a parameter identifier as its second argument"),
                        });
                    };
                    (param, None, body, order)
                }
                3 => {
                    let second = rest.remove(0);
                    let third = rest.remove(0);
                    let body = rest.remove(0);
                    let (Expr::Var(param), Expr::Var(idx_param)) = (second, third) else {
                        return Err(GenUiError::ExprParse {
                            pos: self.peek().pos,
                            message: format!("`{fn_name}` expects identifier parameter names before body"),
                        });
                    };
                    (param, Some(idx_param), body, order)
                }
                other => {
                    return Err(GenUiError::ArityMismatch {
                        function: fn_name.to_owned(),
                        expected: "2..=4".to_owned(),
                        actual: other + 1,
                    });
                }
            }
        };

        if matches!(self.peek().kind, TokenKind::Comma) {
            self.advance();
        }
        self.expect(&TokenKind::RParen, "`)` after higher-order call")?;

        let descending = trailing_order.take().unwrap_or(false);
        Ok(match kind {
            HigherOrderKind::Map => Expr::Map {
                list: Box::new(list),
                param,
                index_param,
                body: Box::new(body),
            },
            HigherOrderKind::Filter => Expr::Filter {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
            HigherOrderKind::SortBy => Expr::SortBy {
                list: Box::new(list),
                param,
                index_param,
                key_expr: Box::new(body),
                descending,
            },
            HigherOrderKind::Any => Expr::Any {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
            HigherOrderKind::All => Expr::All {
                list: Box::new(list),
                param,
                index_param,
                predicate: Box::new(body),
            },
        })
    }

    fn try_parse_lambda_header(&mut self) -> Option<(String, Option<String>)> {
        if let TokenKind::Ident(p) = &self.peek().kind
            && matches!(self.peek_at(1).kind, TokenKind::FatArrow)
        {
            let param = p.clone();
            self.advance();
            self.advance();
            return Some((param, None));
        }
        if self.peek().kind == TokenKind::LParen
            && let TokenKind::Ident(p) = &self.peek_at(1).kind
        {
            if self.peek_at(2).kind == TokenKind::RParen && self.peek_at(3).kind == TokenKind::FatArrow {
                let param = p.clone();
                for _ in 0..4 {
                    self.advance();
                }
                return Some((param, None));
            }
            if self.peek_at(2).kind == TokenKind::Comma
                && let TokenKind::Ident(idx) = &self.peek_at(3).kind
                && self.peek_at(4).kind == TokenKind::RParen
                && self.peek_at(5).kind == TokenKind::FatArrow
            {
                let param = p.clone();
                let idx_param = idx.clone();
                for _ in 0..6 {
                    self.advance();
                }
                return Some((param, Some(idx_param)));
            }
        }
        None
    }

    fn parse_sort_order(&mut self) -> Result<bool, GenUiError> {
        let tok = self.advance();
        if let TokenKind::Text(ref dir) = tok.kind {
            if dir == "asc" {
                return Ok(false);
            }
            if dir == "desc" {
                return Ok(true);
            }
        }
        Err(GenUiError::ExprParse {
            pos: tok.pos,
            message: "sort_by direction must be `'asc'` or `'desc'`".to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum HigherOrderKind {
    Map,
    Filter,
    SortBy,
    Any,
    All,
}

impl HigherOrderKind {
    fn name(self) -> &'static str {
        match self {
            Self::Map => "map",
            Self::Filter => "filter",
            Self::SortBy => "sort_by",
            Self::Any => "any",
            Self::All => "all",
        }
    }
}
