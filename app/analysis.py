"""API analysis: turns raw API calls into health, traffic and optimisation advice per application.

Simple rules, all thresholds in one place:
  health      healthy / degraded / unhealthy, from server errors, client errors, p95 response
              time, and (for a whole application) open show-stopper alerts
  cacheable   yes / per-user / no, from the HTTP method and the path
  advice      cache hot read-only APIs, speed up slow ones, fix failing ones, scale before peaks
"""

import math
import re
from collections import Counter

from app.models import ApiCall, Investigation

# ---- thresholds
SLOW_MS = 800  # p95 above this: degraded
VERY_SLOW_MS = 2000  # p95 above this: unhealthy
ERROR_WARN = 0.01  # 1% server errors: degraded
ERROR_BAD = 0.05  # 5% server errors: unhealthy
CLIENT_ERROR_WARN = 0.10  # 10% 4xx: worth a look
HOT_SHARE = 0.05  # an API with 5%+ of all calls is "hot"
SPIKE_RATIO = 2.5  # busiest hour this many times the average hour: plan for peaks

# Path words that mean the answer is different for each user, so a shared cache is unsafe.
PERSONAL_WORDS = {"cart", "me", "user", "userinfo", "session", "token", "login", "logout",
                  "auth", "oauth", "checkout", "payments", "orders", "account"}

ID_SEGMENT = re.compile(r"^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,})$", re.IGNORECASE)


def api_name(path: str) -> str:
    """'/orders/1234/invoice?x=1' -> '/orders/{id}/invoice', so calls to the same API group together."""
    path = path.split("?", 1)[0]
    parts = ["{id}" if ID_SEGMENT.match(p) else p for p in path.strip("/").split("/")]
    return "/" + "/".join(p for p in parts if p)


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(0, math.ceil(p * len(sorted_values)) - 1)
    return sorted_values[index]


def health(server_error_rate: float, p95_ms: float, client_error_rate: float = 0.0,
           open_show_stoppers: int = 0) -> str:
    if open_show_stoppers or server_error_rate >= ERROR_BAD or p95_ms >= VERY_SLOW_MS:
        return "unhealthy"
    if server_error_rate >= ERROR_WARN or p95_ms >= SLOW_MS or client_error_rate >= CLIENT_ERROR_WARN:
        return "degraded"
    return "healthy"


def open_alerts(alerts: list[Investigation], app: str) -> tuple[int, int]:
    """(open alerts, open show stoppers) for one application."""
    still_open = [i for i in alerts if i.service == app and i.status in ("queued", "running")]
    return len(still_open), sum(1 for i in still_open if i.severity == "SEV1")


def cacheability(method: str, path: str) -> tuple[str, str]:
    """Returns (yes | per-user | no, reason)."""
    words = {w for part in path.lower().strip("/").split("/") for w in re.split(r"[^a-z]+", part) if w}
    if method not in ("GET", "HEAD"):
        return "no", f"{method} changes data, so it must always run."
    if "health" in words or "status" in words:
        return "no", "Reports live state; caching would hide problems."
    if words & PERSONAL_WORDS:
        return "per-user", "The answer depends on the user: only cache per user / session, with a short TTL."
    return "yes", "Read-only and the same for everyone: safe to cache (CDN or Redis)."


def summarize(calls: list[ApiCall]) -> dict:
    """Numbers shared by an application and by a single API."""
    n = len(calls)
    durations = sorted(c.duration_ms for c in calls)
    server_errors = sum(1 for c in calls if c.status >= 500)
    client_errors = sum(1 for c in calls if 400 <= c.status < 500)
    by_hour = Counter(c.time.hour for c in calls)
    peak_hour, peak_count = by_hour.most_common(1)[0] if by_hour else (None, 0)
    p95 = percentile(durations, 0.95)
    error_rate = server_errors / n if n else 0.0
    client_error_rate = client_errors / n if n else 0.0
    return {
        "calls": n,
        "avg_ms": sum(durations) / n if n else 0.0,
        "p50_ms": percentile(durations, 0.50),
        "p95_ms": p95,
        "p99_ms": percentile(durations, 0.99),
        "max_ms": durations[-1] if durations else 0.0,
        "error_rate": error_rate,
        "client_error_rate": client_error_rate,
        "peak_hour": peak_hour,
        "peak_count": peak_count,
        "health": health(error_rate, p95, client_error_rate),
    }


def api_advice(api: dict) -> list[tuple[int, str, str]]:
    """Optimisation suggestions for one API, as (priority, short label, full text). Lower number = do it first:
    0 failing, 1 very slow, 2 slow, 3 many client errors, 4 caching."""
    advice = []
    if api["error_rate"] >= ERROR_WARN:
        advice.append((0, "Fix server errors", f"{api['error_rate']:.1%} server errors: check the Alerts tab for this "
                          "application and fix the top error."))

    if api["p95_ms"] >= VERY_SLOW_MS:
        if api["method"] == "GET":
            advice.append((1, "Speed up: very slow", f"Very slow (p95 {api['p95_ms']:,.0f} ms): add a database index, paginate, "
                              "or precompute the result."))
        else:
            advice.append((1, "Move to background job", f"Very slow (p95 {api['p95_ms']:,.0f} ms): move the slow work to a background "
                              "job and return 202 straight away."))
    elif api["p95_ms"] >= SLOW_MS:
        advice.append((2, "Speed up: slow", f"Slow (p95 {api['p95_ms']:,.0f} ms): find the slowest query or external call "
                          "and add a timeout."))

    if api["client_error_rate"] >= CLIENT_ERROR_WARN:
        advice.append((3, "Check auth / validation", f"{api['client_error_rate']:.0%} client errors (4xx): callers send bad or "
                          "unauthorized requests. Check auth and input validation."))

    if api["cache"] == "yes" and api["share"] >= HOT_SHARE:
        advice.append((4, "Cache (60 s, shared)", f"Cache it: {api['share']:.0%} of all calls, read-only and shared. "
                          "A 60 s cache would serve most of them without touching the backend."))
    elif api["cache"] == "per-user" and api["method"] == "GET" and api["share"] >= HOT_SHARE:
        advice.append((4, "Cache per user (30 s)", "Cache per user for a short time (e.g. 30 s) to cut repeated calls."))
    return advice


def analyze_app(app: str, calls: list[ApiCall], alerts: list[Investigation]) -> dict:
    """Everything the analysis tab shows for one application."""
    overview = summarize(calls)
    n_open, n_stoppers = open_alerts(alerts, app)
    if n_stoppers:
        overview["health"] = "unhealthy"
    total = overview["calls"]

    # Traffic per hour of the day (UTC)
    per_hour = Counter(c.time.hour for c in calls)
    busiest = max(per_hour.values(), default=0)
    hourly = [{"hour": h, "calls": per_hour.get(h, 0),
               "height": round(100 * per_hour.get(h, 0) / busiest) if busiest else 0} for h in range(24)]
    active = [h for h in hourly if h["calls"]]
    quiet = min(active, key=lambda h: h["calls"]) if active else None
    avg_per_hour = total / len(active) if active else 0

    # Calls per minute, over the time the data covers
    if calls:
        span_min = max(1.0, (max(c.time for c in calls) - min(c.time for c in calls)).total_seconds() / 60)
    else:
        span_min = 1.0

    status_groups = Counter(f"{c.status // 100}xx" for c in calls)

    # Per API
    grouped: dict[tuple[str, str], list[ApiCall]] = {}
    for c in calls:
        grouped.setdefault((c.method, api_name(c.path)), []).append(c)
    apis = []
    for (method, path), api_calls in grouped.items():
        api = {"method": method, "path": path, **summarize(api_calls)}
        api["share"] = len(api_calls) / total
        api["cache"], api["cache_reason"] = cacheability(method, path)
        advice = api_advice(api)
        api["advice"] = [text for _, _, text in advice]  # most important first
        api["actions"] = [label for _, label, _ in advice]
        api["_advice"] = advice
        apis.append(api)
    apis.sort(key=lambda a: a["calls"], reverse=True)

    # Recommendations for the whole application: most urgent kind first, then the busiest API
    ranked = sorted(((priority, -a["calls"], f"{a['method']} {a['path']}", text)
                     for a in apis for priority, _, text in a["_advice"]))
    recommendations = [{"api": api, "text": text} for _, _, api, text in ranked]
    for a in apis:
        del a["_advice"]
    spike = busiest / avg_per_hour if avg_per_hour else 0
    if spike >= SPIKE_RATIO:
        recommendations.insert(0, {
            "api": "Whole application",
            "text": f"Traffic at {overview['peak_hour']:02d}:00 UTC is {spike:.1f}x the average hour. "
                    "Scale out before the peak (or enable autoscaling) and avoid deploys at that time.",
        })

    return {
        "overview": overview,
        "calls_per_min": total / span_min,
        "availability": 1 - overview["error_rate"],
        "hourly": hourly,
        "quiet_hour": quiet["hour"] if quiet else None,
        "spike": spike,
        "status_groups": {k: status_groups.get(k, 0) for k in ("2xx", "3xx", "4xx", "5xx")},
        "apis": apis,
        "slowest": max(apis, key=lambda a: a["p95_ms"], default=None),
        "most_errors": max((a for a in apis if a["error_rate"] > 0), key=lambda a: a["error_rate"], default=None),
        "recommendations": recommendations[:8],
        "open_alerts": n_open,
        "show_stoppers": n_stoppers,
    }


def overview_of_apps(calls_by_app: dict[str, list[ApiCall]], alerts: list[Investigation]) -> list[dict]:
    """One row per application for the 'All applications' view, least healthy first."""
    rank = {"unhealthy": 0, "degraded": 1, "healthy": 2}
    rows = []
    for app, calls in calls_by_app.items():
        summary = summarize(calls)
        top = Counter((c.method, api_name(c.path)) for c in calls).most_common(1)[0][0]
        n_open, n_stoppers = open_alerts(alerts, app)
        if n_stoppers:
            summary["health"] = "unhealthy"
        rows.append({"app": app, **summary, "top_api": f"{top[0]} {top[1]}",
                     "open_alerts": n_open, "show_stoppers": n_stoppers})
    rows.sort(key=lambda r: (rank[r["health"]], -r["calls"]))
    return rows
