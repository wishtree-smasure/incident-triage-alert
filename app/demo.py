"""Demo mode: run the sample shop and the log watcher inside the web app.

A deployed instance (e.g. on Render) runs only the web server, so nothing would ever send
it alerts. With DEMO_MODE=true the app starts two background threads on startup:
  - the sample shop, writing real errors / warnings / API calls to a log file
  - the log watcher, sending them signed to this app's own /hooks and /requests endpoints
It also sends the Datadog / AWS / Azure samples once, so every source has something to show.
"""

import os
import tempfile
import threading
from pathlib import Path

import httpx

from app.registry import Registry
from sample_app import shop
from scripts.send_samples import send_all
from scripts.watch_logs import SOURCE_ID, LogTail, check_once


def own_url() -> str:
    """The app talks to itself over localhost (Render sets PORT)."""
    return f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"


def run_shop(log_path: Path, stop: threading.Event, every: float = 1.0) -> None:
    shop.setup_logging(log_path)
    order_id = 1000
    while not stop.is_set():
        order_id += 1
        shop.serve_customer(order_id)
        stop.wait(every)


def run_watcher(log_path: Path, registry: Registry, base_url: str, stop: threading.Event,
                every: float = 5.0) -> None:
    tail = LogTail(log_path)
    secret = registry.secret_for(SOURCE_ID)
    samples_sent = False
    with httpx.Client(base_url=base_url, timeout=10) as client:
        # Wait first: on startup the server is not listening yet.
        while not stop.wait(every):
            try:
                if not samples_sent:
                    send_all(client, registry)
                    samples_sent = True
                check_once(tail, client, secret, "sample-shop")
            except Exception as exc:  # keep the demo running whatever happens
                print(f"demo watcher: {exc.__class__.__name__}: {exc}")


def start(registry: Registry, base_url: str | None = None, log_path: Path | None = None) -> threading.Event:
    """Start the shop and the watcher. Set the returned event to stop them."""
    log_path = log_path or Path(tempfile.gettempdir()) / "triage-demo" / "shop.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("")  # start from an empty log on every boot
    stop = threading.Event()
    threading.Thread(target=run_shop, args=(log_path, stop), daemon=True, name="demo-shop").start()
    threading.Thread(target=run_watcher, args=(log_path, registry, base_url or own_url(), stop),
                     daemon=True, name="demo-watcher").start()
    return stop
