"""Demo mode feeds the app live alerts from the sample shop through the log watcher."""

import threading

from app import demo


class FakeClient:
    def __init__(self, *a, **kw):
        self.posts = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass

    def post(self, path, content, headers):
        self.posts.append(path)
        return type("R", (), {"status_code": 202})()


def test_shop_writes_log_and_stops(tmp_path):
    log = tmp_path / "shop.log"
    stop = threading.Event()
    t = threading.Thread(target=demo.run_shop, args=(log, stop, 0.01))
    t.start()
    stop.wait(0.3)
    stop.set()
    t.join(2)
    assert not t.is_alive()
    assert "shop.access" in log.read_text()


def test_watcher_sends_samples_and_log_alerts(tmp_path, monkeypatch, registry):
    log = tmp_path / "shop.log"
    log.write_text(
        "2026-11-20T06:42:46Z WARNING shop Slow order processing: order 7 took 2500 ms\n"
        "2026-11-20T06:42:47Z INFO shop.access GET /products 200 42ms\n"
    )
    client = FakeClient()
    monkeypatch.setattr(demo.httpx, "Client", lambda *a, **kw: client)
    stop = threading.Event()
    t = threading.Thread(target=demo.run_watcher, args=(log, registry, "http://x", stop, 0.05))
    t.start()
    stop.wait(0.3)
    stop.set()
    t.join(2)
    assert "/hooks/datadog-prod" in client.posts  # samples
    assert client.posts.count("/hooks/inhouse-app") >= 1  # the warning from the log
    assert "/requests/inhouse-app" in client.posts  # the API call
