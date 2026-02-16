from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from app.tools.browser_tool import BrowserTool


HTML_DOC = """
<html>
  <head><title>Browser Tool Test</title></head>
  <body>
    <h1>Hello Browser</h1>
    <a href="/notes">Notes</a>
    <a href="https://example.com/docs">Docs</a>
  </body>
</html>
""".strip()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_DOC.encode("utf-8"))

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return


@pytest.fixture
def local_http_url() -> str:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


def test_browser_fetch_returns_title_and_excerpt(local_http_url: str) -> None:
    tool = BrowserTool()
    result = tool.execute(action="fetch", url=local_http_url)

    assert result["status"] == "ok"
    assert result["tool"] == "safe_browser"
    assert result["status_code"] == 200
    assert result["title"] == "Browser Tool Test"
    assert "Hello Browser" in result["text_excerpt"]


def test_browser_extract_links_returns_discovered_links(local_http_url: str) -> None:
    tool = BrowserTool()
    result = tool.execute(action="extract_links", url=local_http_url)

    assert result["status"] == "ok"
    assert result["tool"] == "safe_browser"
    assert result["links"] == ["/notes", "https://example.com/docs"]


def test_browser_requires_url_for_network_actions() -> None:
    tool = BrowserTool()

    with pytest.raises(ValueError):
        tool.execute(action="fetch")
