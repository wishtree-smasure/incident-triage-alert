// Alerts view: instant filters and live updates without reloading the page.
// The server renders the list (?partial=1); this script only fetches and swaps it,
// keeping open alerts open and highlighting alerts that arrived since the last update.
(function () {
  "use strict";
  var EVERY_MS = 5000;
  var form = document.getElementById("filters");
  var region = document.getElementById("live-region");
  var live = document.getElementById("live");
  var liveText = document.getElementById("live-text");
  var toggle = document.getElementById("live-toggle");
  var search = form.elements.q;
  if (!window.fetch || !window.URLSearchParams) return; // very old browser: the <noscript> refresh does the job

  var paused = false, offline = false, lastUpdate = Date.now(), requestNo = 0, typingTimer = null;
  var openIds = new Set();
  var seenIds = new Set();
  var repeats = new Map(); // alert id -> how many times seen, to flash the ×N badge when it goes up
  live.hidden = false;

  function currentQuery() {
    var params = new URLSearchParams();
    // form.elements includes the selects / radios in the swapped region (they use form="filters").
    new FormData(form).forEach(function (value, key) { if (value) params.set(key, value); });
    return params;
  }

  function relative(date) {
    var s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function tick() {
    region.querySelectorAll("time[datetime]").forEach(function (el) {
      var iso = el.getAttribute("datetime");
      var date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
      if (isNaN(date)) return;
      if (!el.title) el.title = date.toLocaleString();
      el.textContent = relative(date);
    });
    live.classList.toggle("paused", paused);
    live.classList.toggle("offline", offline);
    if (offline) liveText.textContent = "Offline, retrying…";
    else if (paused) liveText.textContent = "Paused";
    else liveText.textContent = "Live · updated " + relative(new Date(lastUpdate));
  }

  function afterSwap(highlightNew) {
    region.querySelectorAll("details[data-id]").forEach(function (d) {
      var id = d.dataset.id;
      if (openIds.has(id)) d.open = true;
      if (highlightNew && !seenIds.has(id)) d.classList.add("new");
      seenIds.add(id);
      var badge = d.querySelector(".repeat");
      var n = badge ? Number(badge.dataset.n) : 1;
      if (highlightNew && repeats.has(id) && n > repeats.get(id) && badge) badge.classList.add("bumped");
      repeats.set(id, n);
    });
    var root = document.getElementById("alerts-live");
    var stoppers = root ? Number(root.dataset.stoppers) : 0;
    document.title = (stoppers ? "(" + stoppers + " SEV1) " : "") + "Incident Triage";
    tick();
  }

  // userAction: the filters changed (update the URL, don't flash rows that were only hidden by a filter).
  function refresh(userAction) {
    var params = currentQuery();
    if (userAction) {
      var qs = params.toString();
      history.replaceState(null, "", qs ? "/?" + qs : "/");
    }
    params.set("partial", "1");
    var mine = ++requestNo;
    if (userAction) region.classList.add("loading");
    return fetch("/?" + params.toString(), { headers: { Accept: "text/html" } })
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.text(); })
      .then(function (html) {
        if (mine !== requestNo) return; // a newer request is on its way
        // Don't pull a dropdown out from under the user during a background update.
        var active = document.activeElement;
        if (!userAction && active && active.tagName === "SELECT" && region.contains(active)) return;
        region.innerHTML = html;
        offline = false;
        lastUpdate = Date.now();
        afterSwap(!userAction);
      })
      .catch(function () { offline = true; tick(); })
      .then(function () { if (mine === requestNo) region.classList.remove("loading"); });
  }

  // Filters: dropdowns and level buttons apply at once; search applies as you type.
  document.addEventListener("change", function (e) {
    if (e.target.form === form && e.target !== search) refresh(true);
  });
  search.addEventListener("input", function () {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { refresh(true); }, 250);
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); refresh(true); });

  // "Clear filters" links: reset in place instead of reloading.
  region.addEventListener("click", function (e) {
    var a = e.target.closest("a.clear, .empty a[href='/']");
    if (!a) return;
    e.preventDefault();
    search.value = "";
    history.replaceState(null, "", "/");
    region.querySelectorAll("select[form=filters]").forEach(function (s) { s.value = ""; });
    var all = region.querySelector("input[name=level][value='']");
    if (all) all.checked = true;
    refresh(true);
  });

  // Remember which alerts are open, so updates don't collapse them.
  region.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!d.dataset || !d.dataset.id) return;
    if (d.open) openIds.add(d.dataset.id); else openIds.delete(d.dataset.id);
    d.classList.remove("new");
  }, true);

  // Keyboard: "/" jumps to search, Escape clears it.
  document.addEventListener("keydown", function (e) {
    var typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); search.select(); }
    else if (e.key === "Escape" && document.activeElement === search && search.value) { search.value = ""; refresh(true); }
  });

  toggle.addEventListener("click", function () {
    paused = !paused;
    toggle.textContent = paused ? "Resume" : "Pause";
    if (!paused) refresh(false);
    tick();
  });

  setInterval(function () {
    if (!paused && !document.hidden) refresh(false);
  }, EVERY_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !paused) refresh(false);
  });
  setInterval(tick, 1000);
  afterSwap(false);
})();
