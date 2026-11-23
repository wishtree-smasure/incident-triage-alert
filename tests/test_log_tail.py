"""The watcher's incremental reading (LogTail) and one check cycle (check_once)."""

import httpx

from app.settings import PROJECT_ROOT
from scripts.watch_logs import LogTail, check_once, parse_entries, to_alert
from tests.conftest import TEST_SECRETS

SECRET = TEST_SECRETS["SRC_GENERIC_SECRET"]

ERROR_ENTRY = """\
2026-11-20T06:00:01Z ERROR shop Order 1 failed
Traceback (most recent call last):
  File "/x/shop.py", line 46, in apply_coupon
    discount = order["coupon"]["percent"]
TypeError: 'NoneType' object is not subscriptable
"""
INFO_ENTRY = "2026-11-20T06:00:02Z INFO shop Order 2 paid 10.00\n"


# ----------------------------------------------------------------------- LogTail


def test_missing_file_gives_nothing(tmp_path):
    assert LogTail(tmp_path / "nope.log").new_entries() == []


def test_reads_only_new_lines(tmp_path):
    log = tmp_path / "app.log"
    log.write_text(ERROR_ENTRY)
    tail = LogTail(log)
    assert len(tail.new_entries()) == 1
    assert tail.new_entries() == []  # nothing new

    with log.open("a") as f:
        f.write(INFO_ENTRY)
    [entry] = tail.new_entries()
    assert entry["level"] == "INFO"


def test_half_written_line_waits_for_next_read(tmp_path):
    log = tmp_path / "app.log"
    log.write_text("2026-11-20T06:00:02Z INFO shop Order 2 pa")  # no newline yet
    tail = LogTail(log)
    assert tail.new_entries() == []

    with log.open("a") as f:
        f.write("id 10.00\n")
    [entry] = tail.new_entries()
    assert entry["message"] == "Order 2 paid 10.00"


def test_recreated_file_is_read_from_the_start(tmp_path):
    log = tmp_path / "app.log"
    log.write_text(ERROR_ENTRY + INFO_ENTRY)
    tail = LogTail(log)
    tail.new_entries()

    log.write_text(INFO_ENTRY)  # rotated: smaller than before
    [entry] = tail.new_entries()
    assert entry["message"] == "Order 2 paid 10.00"


# ----------------------------------------------------------------------- parsing edge cases


def test_lines_before_first_timestamp_are_ignored():
    entries = parse_entries("garbage line\n" + INFO_ENTRY)
    assert len(entries) == 1 and entries[0]["trace"] == []


def test_critical_is_sev1():
    [entry] = parse_entries("2026-11-20T06:00:00Z CRITICAL shop Payments are down\n")
    assert to_alert(entry)["severity"] == "SEV1"


def test_error_without_stack_trace_uses_message():
    [entry] = parse_entries("2026-11-20T06:00:00Z ERROR shop Payment 123 rejected by bank\n")
    alert = to_alert(entry)
    assert alert["title"] == "Payment N rejected by bank"
    assert alert["resource"] == "shop"
    assert "file" not in alert["labels"]


def test_project_paths_become_relative_others_stay_absolute():
    inside = f'  File "{PROJECT_ROOT}/sample_app/shop.py", line 1, in f\nValueError: x\n'
    outside = '  File "/usr/lib/python3/json/decoder.py", line 2, in g\nValueError: y\n'
    for frame, expected in [(inside, "sample_app/shop.py"), (outside, "/usr/lib/python3/json/decoder.py")]:
        [entry] = parse_entries("2026-11-20T06:00:00Z ERROR shop boom\n" + frame)
        assert to_alert(entry)["labels"]["file"] == expected


def test_long_text_is_truncated():
    huge = "x" * 10_000
    [entry] = parse_entries(f"2026-11-20T06:00:00Z ERROR shop {huge}\n")
    alert = to_alert(entry)
    assert len(alert["description"]) == 4000
    assert len(alert["labels"]["error"]) == 300


def test_service_name_is_passed_through():
    [entry] = parse_entries(ERROR_ENTRY)
    assert to_alert(entry, "billing-api")["service"] == "billing-api"


# ----------------------------------------------------------------------- check_once


def test_check_once_sends_errors_and_skips_info(tmp_path, client):
    log = tmp_path / "app.log"
    log.write_text(ERROR_ENTRY + INFO_ENTRY)
    results = check_once(LogTail(log), client, SECRET, "sample-shop")
    assert len(results) == 1
    assert results[0].startswith("202  ERROR") and "shop.py:46" in results[0]


def test_check_once_survives_app_being_down(tmp_path):
    log = tmp_path / "app.log"
    log.write_text(ERROR_ENTRY)

    def refuse(request):
        raise httpx.ConnectError("connection refused")

    with httpx.Client(base_url="http://localhost:1", transport=httpx.MockTransport(refuse)) as down:
        [result] = check_once(LogTail(log), down, SECRET, "sample-shop")
    assert result.startswith("not sent (ConnectError)")


def test_check_once_reports_rejected_signature(tmp_path, client):
    log = tmp_path / "app.log"
    log.write_text(ERROR_ENTRY)
    [result] = check_once(LogTail(log), client, "wrong-secret", "sample-shop")
    assert result.startswith("401")
