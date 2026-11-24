"""Finds where in the code an alert comes from: folder, file, line and function.

Looks at the alert's labels first (the log watcher sets file / line / function), then
reads stack-trace lines in the message. Understands the usual formats:

  Python   File "app/orders/views.py", line 52, in create_order
  Java     at com.shop.payment.PaymentClient.authorize(PaymentClient.java:88)
  .NET     at Shop.Orders.Service.Create() in C:\\src\\Orders\\Service.cs:line 42
  Node     at createOrder (/srv/app/src/orders/service.ts:31:7)
  Go       /srv/app/orders/handler.go:42 +0x1d
  other    src/orders/service.rb:17

The frame chosen is the one where the error was raised in the application's own code,
skipping library / framework frames (java.*, node_modules, site-packages, ...).
"""

import re
from pathlib import PurePosixPath

from app.models import NormalizedAlert

PYTHON = re.compile(r'File "(?P<path>[^"]+)", line (?P<line>\d+)(?:, in (?P<function>[\w.<>]+))?')
JAVA = re.compile(r"at (?P<qualified>[\w$.]+)\.(?P<method>[\w$<>]+)\((?P<file>[\w$]+\.(?:java|kt|scala|groovy)):(?P<line>\d+)\)")
DOTNET = re.compile(r"at (?P<qualified>[\w.`<>]+)\.(?P<method>[\w<>`]+)\([^)]*\) in (?P<path>.+?\.(?:cs|vb|fs)):line (?P<line>\d+)")
NODE = re.compile(r"at (?:(?P<function>[\w$.<>\[\] ]+?) \()?(?P<path>(?:file://)?[\w@./\\:-]+?\.(?:js|mjs|cjs|ts|tsx|jsx)):(?P<line>\d+)(?::(?P<column>\d+))?\)?")
GENERIC = re.compile(r"(?P<path>(?:[A-Za-z]:)?[\w@./\\-]*[\w-]+\.(?:py|go|rb|php|rs|c|cc|cpp|h|swift|ex|exs|java|kt|cs|js|ts)):(?:line )?(?P<line>\d+)")

# Frames from libraries and frameworks, not the application's own code.
LIBRARY = re.compile(
    r"^(java|javax|jdk|sun|kotlin|scala|org\.springframework|org\.apache|com\.sun|System|Microsoft)\.|"
    r"node_modules|node:internal|internal/|site-packages|dist-packages|/usr/lib/|\$GOROOT|/go/src/runtime/"
)


def _location(path: str, line: str | int, function: str | None = None, column: str | None = None,
              language: str = "", hint: str = "") -> dict:
    path = path.removeprefix("file://").replace("\\", "/")
    p = PurePosixPath(path)
    folder = str(p.parent) if str(p.parent) not in (".", "") else ""
    return {
        "path": path,
        "folder": folder + "/" if folder and not folder.endswith("/") else folder,
        "file": p.name,
        "line": int(line),
        "column": int(column) if column else None,
        "function": function,
        "language": language,
        "hint": hint,
        "goto": f"{path}:{line}",  # paste into the editor's "Go to file" (e.g. VS Code Ctrl+P)
    }


def _frames(text: str) -> list[tuple[dict, str]]:
    """Every code location in the text, with the text it was found in (to spot library frames)."""
    found = []
    for m in PYTHON.finditer(text):
        found.append((_location(m["path"], m["line"], m["function"], language="Python"), m["path"]))
    for m in JAVA.finditer(text):
        qualified = m["qualified"]
        package, _, cls = qualified.rpartition(".")
        folder = package.replace(".", "/")
        path = f"{folder}/{m['file']}" if folder else m["file"]
        hint = "Java package folder; in the repository usually under src/main/java/ (or src/main/kotlin/)."
        found.append((_location(path, m["line"], f"{cls}.{m['method']}", language="Java", hint=hint), qualified))
    for m in DOTNET.finditer(text):
        cls = m["qualified"].rpartition(".")[2]
        found.append((_location(m["path"], m["line"], f"{cls}.{m['method']}", language=".NET"), m["qualified"] + " " + m["path"]))
    if not found:
        for m in NODE.finditer(text):
            function = (m["function"] or "").strip() or None
            found.append((_location(m["path"], m["line"], function, m["column"], language="JavaScript"), m["path"]))
    if not found:
        for m in GENERIC.finditer(text):
            found.append((_location(m["path"], m["line"]), m["path"]))
    return found


def code_location(alert: NormalizedAlert) -> dict | None:
    """Where the alert's error was raised in the application's code, or None if the alert
    has no code location (e.g. an infrastructure metric alarm)."""
    labels = alert.labels or {}
    if labels.get("file") and str(labels.get("line", "")).isdigit():
        return _location(labels["file"], labels["line"], labels.get("function"), language=labels.get("language", ""))

    text = "\n".join(x for x in (alert.description, alert.title) if x)
    frames = _frames(text)
    if not frames:
        return None
    own = [loc for loc, where in frames if not LIBRARY.search(where)] or [loc for loc, _ in frames]
    # Python prints the raising frame last; Java, .NET and JavaScript print it first.
    return own[-1] if own[0]["language"] == "Python" else own[0]
