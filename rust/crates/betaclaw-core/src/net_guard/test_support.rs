//! Test doubles for the guard and the S11 handlers. Compiled for tests only.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::IpAddr;
use std::sync::Mutex;

use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};

use super::ssrf_guard::Resolver;
use crate::model_hub::http::{BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport};

/// A response with the given status, headers and body.
pub fn response_with(status: u16, headers: &[(&str, &str)], body: &str) -> HttpResponse {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            HeaderName::from_bytes(name.as_bytes()).expect("test header name"),
            HeaderValue::from_str(value).expect("test header value"),
        );
    }
    HttpResponse::new(
        StatusCode::from_u16(status).expect("test status"),
        map,
        body,
    )
}

/// Answers requests from a queue and records every request it receives. An empty queue
/// answers with a transport error, so an unexpected request fails the test.
#[derive(Default)]
pub struct FakeTransport {
    responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl FakeTransport {
    pub fn with(responses: Vec<Result<HttpResponse, HttpError>>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(Vec::new()),
        }
    }

    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().expect("requests lock").clone()
    }
}

impl HttpTransport for FakeTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            self.requests.lock().expect("requests lock").push(request);
            self.responses
                .lock()
                .expect("responses lock")
                .pop_front()
                .unwrap_or_else(|| Err(HttpError::Transport("no fake response queued".to_string())))
        })
    }
}

/// Resolves names from a fixed table. Any other name fails, as NXDOMAIN does.
#[derive(Default)]
pub struct FakeResolver {
    table: HashMap<String, Vec<IpAddr>>,
}

impl FakeResolver {
    pub fn with(entries: Vec<(&str, Vec<&str>)>) -> Self {
        let table = entries
            .into_iter()
            .map(|(name, addresses)| {
                let addresses = addresses
                    .into_iter()
                    .map(|address| address.parse::<IpAddr>().expect("test address"))
                    .collect();
                (name.to_string(), addresses)
            })
            .collect();
        Self { table }
    }
}

impl Resolver for FakeResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> BoxFuture<'a, io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            self.table
                .get(host)
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown host"))
        })
    }
}
