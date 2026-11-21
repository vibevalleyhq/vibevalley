use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::{Number, Value, json};
use sha2::{Digest, Sha256};

/// Chord compares an integral float to an integer by its exact value.
pub fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(i), Some(j)) => i == j,
            (None, None) => x.as_f64() == y.as_f64(),
            (Some(i), None) => y.as_f64().is_some_and(|f| equal_integer_float(i, f)),
            (None, Some(i)) => x.as_f64().is_some_and(|f| equal_integer_float(i, f)),
        },
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| equal(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|b| equal(v, b))),
        _ => a == b,
    }
}

fn equal_integer_float(integer: i64, float: f64) -> bool {
    float.fract() == 0.0 && float as i128 == i128::from(integer)
}

#[derive(Clone, Debug, thiserror::Error, PartialEq)]
pub enum Error {
    #[error("invalid delta tuple")]
    Tuple,
    #[error("missing field or invalid array index: {0}")]
    Path(String),
    #[error("array index {0} out of bounds")]
    Bounds(usize),
    #[error("expected {0}")]
    Type(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Replace(Vec<String>, Value),
    Delete(Vec<String>),
    AppendText(Vec<String>, String),
    Splice(Vec<String>, usize, usize, Vec<Value>),
}

impl Op {
    pub fn path(&self) -> &[String] {
        match self {
            Self::Replace(p, _) | Self::Delete(p) | Self::AppendText(p, _) | Self::Splice(p, ..) => p,
        }
    }
}

impl Serialize for Op {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Replace(p, value) if p.is_empty() => ("r", value).serialize(serializer),
            Self::Replace(p, value) => ("r", p, value).serialize(serializer),
            Self::Delete(p) if p.is_empty() => Err(serde::ser::Error::custom("cannot delete root")),
            Self::Delete(p) => ("d", p).serialize(serializer),
            Self::AppendText(p, text) => ("a", p, text).serialize(serializer),
            Self::Splice(p, index, count, items) => {
                let mut tuple = vec![json!("s"), json!(p), json!(index), json!(count)];
                tuple.extend(items.iter().cloned());
                tuple.serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for Op {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let args = Vec::<Value>::deserialize(deserializer)?;
        let path = |v: &Value| serde_json::from_value::<Vec<String>>(v.clone()).map_err(D::Error::custom);
        let index = |v: &Value| v.as_i64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| D::Error::custom(Error::Tuple));
        match (args.first().and_then(Value::as_str), args.get(1..).unwrap_or_default()) {
            (Some("r"), [v]) => Ok(Self::Replace(vec![], v.clone())),
            (Some("r"), [p, v]) => Ok(Self::Replace(path(p)?, v.clone())),
            (Some("d"), [p]) => {
                let path = path(p)?;
                if path.is_empty() {
                    return Err(D::Error::custom("cannot delete root"));
                }
                Ok(Self::Delete(path))
            }
            (Some("a"), [p, Value::String(s)]) => Ok(Self::AppendText(path(p)?, s.clone())),
            (Some("s"), [p, i, n, items @ ..]) => Ok(Self::Splice(path(p)?, index(i)?, index(n)?, items.to_vec())),
            _ => Err(D::Error::custom(Error::Tuple)),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
enum Node {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Arc<Node>>),
    Object(BTreeMap<String, Arc<Node>>),
}

impl From<Value> for Node {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(v) => Self::Bool(v),
            Value::Number(n) if n.is_u64() && !n.is_i64() => Self::Number(Number::from_f64(n.as_f64().expect("finite JSON number")).expect("finite u64")),
            Value::Number(n) => Self::Number(n),
            Value::String(v) => Self::String(v),
            Value::Array(a) => Self::Array(a.into_iter().map(node).collect()),
            Value::Object(o) => Self::Object(o.into_iter().map(|(k, v)| (k, node(v))).collect()),
        }
    }
}

fn node(value: Value) -> Arc<Node> {
    Arc::new(value.into())
}

fn array_index(segment: &str) -> Result<usize, Error> {
    if segment.is_empty() || segment.starts_with('0') && segment.len() > 1 || !segment.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::Path(segment.into()));
    }
    segment.parse().map_err(|_| Error::Path(segment.into()))
}

impl Node {
    fn child(&self, key: &str) -> Result<&Arc<Self>, Error> {
        match self {
            Self::Object(map) => map.get(key).ok_or_else(|| Error::Path(key.into())),
            Self::Array(items) => {
                let index = array_index(key)?;
                items.get(index).ok_or(Error::Bounds(index))
            }
            _ => Err(Error::Type("object or array")),
        }
    }

    fn child_mut(&mut self, key: &str) -> Result<&mut Arc<Self>, Error> {
        match self {
            Self::Object(map) => map.get_mut(key).ok_or_else(|| Error::Path(key.into())),
            Self::Array(items) => {
                let index = array_index(key)?;
                items.get_mut(index).ok_or(Error::Bounds(index))
            }
            _ => Err(Error::Type("object or array")),
        }
    }

    fn hash_into(&self, hash: &mut Sha256) {
        match self {
            Self::Null => hash.update(b"N"),
            Self::Bool(true) => hash.update(b"T"),
            Self::Bool(false) => hash.update(b"F"),
            Self::Number(n) => match n.as_i64() {
                Some(i) => {
                    hash.update(b"I");
                    hash.update(i.to_le_bytes());
                }
                None => {
                    let f = n.as_f64().expect("JSON numbers are finite");
                    hash.update(b"D");
                    hash.update((if f == 0.0 { 0.0 } else { f }).to_le_bytes());
                }
            },
            Self::String(s) => {
                hash.update(b"S");
                hash.update((s.len() as u64).to_le_bytes());
                hash.update(s.as_bytes());
            }
            Self::Array(a) => {
                hash.update(b"A");
                hash.update((a.len() as u64).to_le_bytes());
                for item in a {
                    item.hash_into(hash);
                }
            }
            Self::Object(o) => {
                hash.update(b"M");
                hash.update((o.len() as u64).to_le_bytes());
                for (k, item) in o {
                    hash.update((k.len() as u64).to_le_bytes());
                    hash.update(k.as_bytes());
                    item.hash_into(hash);
                }
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct Snapshot(Arc<Node>);

impl Snapshot {
    pub fn new(root: Value) -> Self {
        Self(node(root))
    }

    pub fn get(&self, path: &[String]) -> Option<Value> {
        let target = path.iter().try_fold(&self.0, |v, key| v.child(key)).ok()?;
        Some(json!(target))
    }

    pub fn hash(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        self.0.hash_into(&mut hash);
        hash.finalize().into()
    }

    pub fn draft(&self) -> Draft {
        Draft {
            root: self.0.clone(),
            ops: vec![],
        }
    }

    pub fn apply(&self, ops: &[Op]) -> Result<Self, Error> {
        let mut draft = self.draft();
        for op in ops {
            draft.apply(op.clone())?;
        }
        Ok(draft.commit().0)
    }
}

pub struct Draft {
    root: Arc<Node>,
    ops: Vec<Op>,
}

impl Draft {
    fn target(&mut self, path: &[String]) -> Result<&mut Arc<Node>, Error> {
        let mut current = &mut self.root;
        for key in path {
            current = Arc::make_mut(current).child_mut(key)?;
        }
        Ok(current)
    }

    pub fn apply(&mut self, mut op: Op) -> Result<(), Error> {
        match &mut op {
            Op::Replace(path, value) => match path.split_last() {
                None => self.root = node(value.clone()),
                Some((key, parents)) => {
                    let parent = Arc::make_mut(self.target(parents)?);
                    match parent {
                        Node::Object(map) => {
                            map.insert(key.clone(), node(value.clone()));
                        }
                        other => *other.child_mut(key)? = node(value.clone()),
                    }
                }
            },
            Op::Delete(path) => {
                let (key, parents) = path.split_last().ok_or_else(|| Error::Path("cannot delete root".into()))?;
                let Node::Object(map) = Arc::make_mut(self.target(parents)?) else {
                    return Err(Error::Type("object"));
                };
                if map.remove(key).is_none() {
                    return Ok(());
                }
            }
            Op::AppendText(path, suffix) => {
                let Node::String(s) = Arc::make_mut(self.target(path)?) else {
                    return Err(Error::Type("string"));
                };
                if suffix.is_empty() {
                    return Ok(());
                }
                s.push_str(suffix);
            }
            Op::Splice(path, index, count, items) => {
                let Node::Array(a) = Arc::make_mut(self.target(path)?) else {
                    return Err(Error::Type("array"));
                };
                let remaining = a.len().checked_sub(*index).ok_or(Error::Bounds(*index))?;
                *count = (*count).min(remaining);
                a.splice(*index..*index + *count, items.iter().cloned().map(node));
            }
        }
        self.ops.push(op);
        Ok(())
    }

    pub fn commit(&mut self) -> (Snapshot, Vec<Op>) {
        (Snapshot(self.root.clone()), std::mem::take(&mut self.ops))
    }
}

mod pending;
pub use pending::PendingOps;
