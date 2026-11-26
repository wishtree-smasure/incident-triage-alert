/**
 * Finds where in the code an alert comes from: folder, file, line and function.
 *
 * Looks at the alert's labels first (the log watcher sets file / line / function), then
 * reads stack-trace lines in the message. Understands the usual formats:
 *   Python   File "app/orders/views.py", line 52, in create_order
 *   Java     at com.shop.payment.PaymentClient.authorize(PaymentClient.java:88)
 *   .NET     at Shop.Orders.Service.Create() in C:\src\Orders\Service.cs:line 42
 *   Node     at createOrder (/srv/app/src/orders/service.ts:31:7)
 *   Go       /srv/app/orders/handler.go:42 +0x1d
 *   other    src/orders/service.rb:17
 * The frame chosen is the one where the error was raised in the application's own code,
 * skipping library / framework frames (java.*, node_modules, site-packages, ...).
 */

import path from "node:path";
import type { NormalizedAlert } from "./models.js";

export interface CodeLocation {
  path: string;
  folder: string;
  file: string;
  line: number;
  column: number | null;
  function: string | null;
  language: string;
  hint: string;
  goto: string; // paste into the editor's "Go to file" (e.g. VS Code Ctrl+P)
}

const PYTHON = /File "(?<path>[^"]+)", line (?<line>\d+)(?:, in (?<function>[\w.<>]+))?/g;
const JAVA = /at (?<qualified>[\w$.]+)\.(?<method>[\w$<>]+)\((?<file>[\w$]+\.(?:java|kt|scala|groovy)):(?<line>\d+)\)/g;
const DOTNET = /at (?<qualified>[\w.`<>]+)\.(?<method>[\w<>`]+)\([^)]*\) in (?<path>.+?\.(?:cs|vb|fs)):line (?<line>\d+)/g;
const NODE = /at (?:(?<function>[\w$.<>\[\] ]+?) \()?(?<path>(?:file:\/\/)?[\w@./\\:-]+?\.(?:js|mjs|cjs|ts|tsx|jsx)):(?<line>\d+)(?::(?<column>\d+))?\)?/g;
const GENERIC = /(?<path>(?:[A-Za-z]:)?[\w@./\\-]*[\w-]+\.(?:py|go|rb|php|rs|c|cc|cpp|h|swift|ex|exs|java|kt|cs|js|ts)):(?:line )?(?<line>\d+)/g;

// Frames from libraries and frameworks, not the application's own code.
const LIBRARY =
  /^(java|javax|jdk|sun|kotlin|scala|org\.springframework|org\.apache|com\.sun|System|Microsoft)\.|node_modules|node:internal|internal\/|site-packages|dist-packages|\/usr\/lib\/|\$GOROOT|\/go\/src\/runtime\//;

function location(
  rawPath: string,
  line: string,
  fn: string | null = null,
  column: string | null = null,
  language = "",
  hint = "",
): CodeLocation {
  const p = rawPath.replace(/^file:\/\//, "").replace(/\\/g, "/");
  const parent = path.posix.dirname(p);
  const folder = parent === "." || parent === "" ? "" : parent;
  return {
    path: p,
    folder: folder && !folder.endsWith("/") ? `${folder}/` : folder,
    file: path.posix.basename(p),
    line: Number(line),
    column: column ? Number(column) : null,
    function: fn || null,
    language,
    hint,
    goto: `${p}:${line}`,
  };
}

/** Every code location in the text, with the text it was found in (to spot library frames). */
function frames(text: string): [CodeLocation, string][] {
  const found: [CodeLocation, string][] = [];
  for (const m of text.matchAll(PYTHON)) {
    const g = m.groups!;
    found.push([location(g.path, g.line, g.function ?? null, null, "Python"), g.path]);
  }
  for (const m of text.matchAll(JAVA)) {
    const g = m.groups!;
    const dot = g.qualified.lastIndexOf(".");
    const pkg = dot >= 0 ? g.qualified.slice(0, dot) : "";
    const cls = dot >= 0 ? g.qualified.slice(dot + 1) : g.qualified;
    const folder = pkg.replace(/\./g, "/");
    const hint = "Java package folder; in the repository usually under src/main/java/ (or src/main/kotlin/).";
    found.push([location(folder ? `${folder}/${g.file}` : g.file, g.line, `${cls}.${g.method}`, null, "Java", hint), g.qualified]);
  }
  for (const m of text.matchAll(DOTNET)) {
    const g = m.groups!;
    const cls = g.qualified.slice(g.qualified.lastIndexOf(".") + 1);
    found.push([location(g.path, g.line, `${cls}.${g.method}`, null, ".NET"), `${g.qualified} ${g.path}`]);
  }
  if (!found.length) {
    for (const m of text.matchAll(NODE)) {
      const g = m.groups!;
      found.push([location(g.path, g.line, g.function?.trim() || null, g.column ?? null, "JavaScript"), g.path]);
    }
  }
  if (!found.length) {
    for (const m of text.matchAll(GENERIC)) {
      const g = m.groups!;
      found.push([location(g.path, g.line), g.path]);
    }
  }
  return found;
}

/**
 * Where the alert's error was raised in the application's code, or null if the alert has no
 * code location (e.g. an infrastructure metric alarm).
 */
export function codeLocation(alert: Pick<NormalizedAlert, "labels" | "description" | "title">): CodeLocation | null {
  const labels = alert.labels ?? {};
  if (labels.file && /^\d+$/.test(String(labels.line ?? ""))) {
    return location(labels.file, String(labels.line), labels.function ?? null, null, labels.language ?? "");
  }
  const text = [alert.description, alert.title].filter(Boolean).join("\n");
  const all = frames(text);
  if (!all.length) return null;
  const own = all.filter(([, where]) => !LIBRARY.test(where)).map(([loc]) => loc);
  const pick = own.length ? own : all.map(([loc]) => loc);
  // Python prints the raising frame last; Java, .NET and JavaScript print it first.
  return pick[0].language === "Python" ? pick[pick.length - 1] : pick[0];
}
