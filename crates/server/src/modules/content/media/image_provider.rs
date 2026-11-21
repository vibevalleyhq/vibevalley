//! MOSS image request preparation and cancelable execution. Secrets and signed
//! URLs never enter errors. Download DNS is pinned to checked public addresses.
use super::{inputs::refused, png};
use crate::modules::infra::setting::Setting;
use crate::modules::team::provider::{IMAGE_MODELS, Use};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use vibevalley_protocol::{ApiError, BizCode, MediaImageFormat, MediaImageRequest, MediaImageUsage};

pub struct Prepared {
    pub connection: String,
    pub revision: i64,
    pub model: String,
    pub body: Value,
    pub key: String,
}
pub struct Generated {
    pub url: String,
    pub usage: MediaImageUsage,
}
#[derive(Debug, Clone, Copy)]
pub enum Failure {
    Rejected,
    Unknown,
}
pub type Work<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;
pub trait ImageBackend: Send + Sync {
    fn prepare(&self, request: &MediaImageRequest) -> Result<Prepared, ApiError>;
    fn generate<'a>(&'a self, prepared: Prepared) -> Work<'a, Generated>;
    fn download<'a>(&'a self, url: &'a str, width: i64, height: i64) -> Work<'a, Vec<u8>>;
}
pub struct Moss {
    setting: Arc<Setting>,
}
impl Moss {
    pub fn new(setting: Arc<Setting>) -> Self {
        crate::install_tls();
        Self { setting }
    }
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn words(s: &str) -> bool {
    (1..=4000).contains(&s.chars().count()) && !s.trim().is_empty()
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object().is_some_and(|o| o.keys().all(|k| keys.contains(&k.as_str())))
}
/// Zod refinements omitted by protocol generation must run before submission.
pub fn body(r: &MediaImageRequest, model: &str) -> Result<Value, ApiError> {
    let invalid = || refused("invalid");
    if r.id.is_empty()
        || r.id.len() > 80
        || !r.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !words(&r.prompt)
        || !(256..=2048).contains(&r.width)
        || !(256..=2048).contains(&r.height)
        || r.width % 16 != 0
        || r.height % 16 != 0
        || r.width * r.height > 2097152
        || r.steps.is_some_and(|s| !(1..=100).contains(&s))
        || r.guidance.is_some_and(|g| !g.0.is_finite() || !(0.0..=10.0).contains(&g.0))
        || r.negative_prompt.as_ref().is_some_and(|s| s.chars().count() > 4000)
    {
        return Err(invalid());
    }
    let prompt = if r.format == MediaImageFormat::Layout {
        let v: Value = serde_json::from_str(&r.prompt).map_err(|_| invalid())?;
        let summary = &v["summary"];
        if !exact(&v, &["summary", "items", "bbox_format", "bbox_coord_space"])
            || !exact(summary, &["caption", "meta", "canvas"])
            || !words(text(&summary["caption"]))
            || summary.get("canvas").is_some_and(|v| text(v).is_empty())
            || summary
                .get("meta")
                .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(|v| !text(v).is_empty())))
            || v["bbox_format"] != "yxyx"
            || v["bbox_coord_space"] != "abs_centralized"
        {
            return Err(invalid());
        }
        let items = v["items"].as_array().ok_or_else(invalid)?;
        if items.is_empty() || items.len() > 100 {
            return Err(invalid());
        }
        for i in items {
            if !exact(i, &["label", "caption", "text", "bbox"])
                || text(&i["label"]).is_empty()
                || !words(text(&i["caption"]))
                || i.get("text").is_some_and(|v| !v.is_string())
            {
                return Err(invalid());
            }
            let b = i["bbox"].as_array().filter(|b| b.len() == 4).ok_or_else(invalid)?;
            let b = b.iter().map(Value::as_f64).collect::<Option<Vec<_>>>().ok_or_else(invalid)?;
            if b[0] >= b[2]
                || b[1] >= b[3]
                || b[0] < -(r.height as f64) / 2.0
                || b[2] > r.height as f64 / 2.0
                || b[1] < -(r.width as f64) / 2.0
                || b[3] > r.width as f64 / 2.0
            {
                return Err(invalid());
            }
        }
        let s = serde_json::to_string(&v).map_err(|_| invalid())?;
        if s.chars().count() > 4000 {
            return Err(invalid());
        }
        s
    } else {
        r.prompt.clone()
    };
    let mut b = json!({"model":model,"prompt":prompt,"size":format!("{}x{}",r.width,r.height),"n":1,"response_format":"url","prompt_enhance":r.enhance,"output_watermark":{"enabled":r.watermark}});
    if let Some(s) = r.seed {
        b["seed"] = json!(s);
    }
    if let Some(s) = r.steps {
        b["num_inference_steps"] = json!(s);
    }
    if let Some(g) = r.guidance {
        b["guidance_scale"] = json!(g.0);
    }
    if let Some(s) = &r.negative_prompt {
        b["negative_prompt"] = json!(s);
    }
    Ok(b)
}
impl ImageBackend for Moss {
    fn prepare(&self, r: &MediaImageRequest) -> Result<Prepared, ApiError> {
        let a = self
            .setting
            .providers()
            .account(Use::Image)
            .ok_or_else(|| ApiError::new(BizCode::ProviderRefused, vibevalley_i18n::t("server.provider.imageUnbound", &[])))?;
        if !IMAGE_MODELS.contains(&a.model.as_str()) {
            return Err(ApiError::new(BizCode::ProviderRefused, vibevalley_i18n::t("server.provider.imageModel", &[])));
        }
        Ok(Prepared {
            body: body(r, &a.model)?,
            connection: a.connection,
            revision: a.revision,
            model: a.model,
            key: a.key.expose().to_string(),
        })
    }
    fn generate<'a>(&'a self, p: Prepared) -> Work<'a, Generated> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(900))
                .build()
                .map_err(|_| Failure::Unknown)?;
            let mut response = client
                .post("https://api.mosi.cn/v1/images/generations")
                .bearer_auth(p.key)
                .header("accept", "application/json")
                .json(&p.body)
                .send()
                .await
                .map_err(|_| Failure::Unknown)?;
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unknown)? {
                if bytes.len() + chunk.len() > 1 << 20 {
                    return Err(Failure::Unknown);
                }
                bytes.extend_from_slice(&chunk);
            }
            if !status.is_success() {
                return Err(if [400, 401, 403, 413, 422, 429].contains(&status.as_u16()) {
                    Failure::Rejected
                } else {
                    Failure::Unknown
                });
            }
            let v: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unknown)?;
            let url = text(&v["data"][0]["url"]);
            let usage = &v["usage"];
            let width = usage["output_width"].as_i64().ok_or(Failure::Unknown)?;
            let height = usage["output_height"].as_i64().ok_or(Failure::Unknown)?;
            if v["created"].as_i64().is_none()
                || v["data"].as_array().is_none_or(|a| a.len() != 1)
                || usage["generated_images"] != 1
                || format!("{width}x{height}") != text(&p.body["size"])
                || url::Url::parse(url).is_err()
                || !url.starts_with("https://")
            {
                return Err(Failure::Unknown);
            }
            Ok(Generated {
                url: url.into(),
                usage: MediaImageUsage { images: 1, width, height },
            })
        })
    }
    fn download<'a>(&'a self, address: &'a str, width: i64, height: i64) -> Work<'a, Vec<u8>> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(60), async {
                let url = url::Url::parse(address).map_err(|_| Failure::Unknown)?;
                if !crate::public_http::public_https(&url) {
                    return Err(Failure::Unknown);
                }
                let host = url.host_str().ok_or(Failure::Unknown)?;
                let addresses: Vec<_> = tokio::net::lookup_host((host, 443)).await.map_err(|_| Failure::Unknown)?.collect();
                if addresses.is_empty()
                    || addresses
                        .iter()
                        .any(|a| !matches!(a.ip(),std::net::IpAddr::V4(ip) if crate::public_http::public_v4(ip)))
                {
                    return Err(Failure::Unknown);
                }
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(60))
                    .resolve_to_addrs(host, &addresses)
                    .build()
                    .map_err(|_| Failure::Unknown)?;
                let mut response = client.get(url).header("accept", "image/png").send().await.map_err(|_| Failure::Unknown)?;
                if response.status() != 200
                    || !response
                        .headers()
                        .get("content-type")
                        .and_then(|s| s.to_str().ok())
                        .is_some_and(|s| s.split(';').next().unwrap_or("").trim() == "image/png")
                {
                    return Err(Failure::Unknown);
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unknown)? {
                    if bytes.len() + chunk.len() > crate::modules::content::attachment::ATTACHMENT_MAX {
                        return Err(Failure::Unknown);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if !png::valid(&bytes, width, height) {
                    return Err(Failure::Unknown);
                }
                Ok(bytes)
            })
            .await
            .map_err(|_| Failure::Unknown)?
        })
    }
}
