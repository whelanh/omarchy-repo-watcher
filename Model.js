// Repo Watcher — pure parsing and normalization helpers, shared by the QML
// (Service.qml / Panel.qml / BarWidget.qml) and unit-testable under node.
// Deliberately Qt-free so nothing here depends on the QML runtime.
//
// Forges are supported through per-forge endpoints. GitHub and Codeberg
// (Gitea/Forgejo) share near-identical REST shapes for commits, issues, pull
// requests, and releases, so one parser serves both. SourceForge exposes only
// an RSS commit feed. Discussions are a GitHub-only feature and require a
// token (GraphQL always authenticates).

var MAX_JSON_BYTES = 1048576

// Hard caps on config and derived data, so an attacker-controlled config file
// (or an unexpectedly large API response) cannot create an unbounded request
// queue, feed model, notification batch, or serialized save.
var MAX_CONFIG_BYTES = 65536
var MAX_REPOS = 50
var MAX_TOKEN_LENGTH = 255
var MAX_SEEN_ENTRIES = 200
var MAX_KEY_LENGTH = 200
var MAX_STRING_LENGTH = 500
var MAX_FEED_ITEMS = 2000

// Kinds surfaced by the plugin, in the order the panel and notifications show
// them.
var KINDS = {
  commit: { label: "Commit" },
  issue: { label: "Issue" },
  pr: { label: "Pull request" },
  discussion: { label: "Discussion" },
  release: { label: "Release" }
}

var KIND_ORDER = ["commit", "issue", "pr", "discussion", "release"]

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

var DEFAULTS = {
  repos: [],
  token: "",
  autoRefresh: true,
  refreshHours: 24,
  notify: true,
  maxEvents: 50,
  seen: {}
}

// Per-forge endpoints. `pageParam` differs between GitHub (per_page) and
// Gitea/Forgejo (limit). `webBase` is used to open a repository in a browser.
// SourceForge has no REST API here — commits come from its RSS feed.
var FORGES = {
  github: { label: "GitHub", apiBase: "https://api.github.com", webBase: "https://github.com", pageParam: "per_page" },
  codeberg: { label: "Codeberg", apiBase: "https://codeberg.org/api/v1", webBase: "https://codeberg.org", pageParam: "limit" },
  sourceforge: { label: "SourceForge", apiBase: "https://sourceforge.net", webBase: "https://sourceforge.net", pageParam: "" }
}

// ---------------------------------------------------------------------------
// Repo keys
// ---------------------------------------------------------------------------
//
// A watched repo is stored as a canonical key string:
//   github      -> "owner/repo"
//   codeberg    -> "codeberg.org/owner/repo"
//   sourceforge -> "sourceforge.net/project"
// GitHub stays bare so existing configs and the common case read naturally;
// any other forge carries its host, which disambiguates it and encodes the
// forge at the same time.

function normalizeRepoUrl(input) {
  var text = String(input === undefined || input === null ? "" : input).replace(/^\s+|\s+$/g, "")
  if (text === "") return null

  text = text.replace(/^git\+/, "")
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  text = text.replace(/^git@/, "")

  // Pull off a leading host if there is one (a leading token containing a dot).
  var host = ""
  var m = text.match(/^([A-Za-z0-9.-]+)[:\/](.*)$/)
  if (m && m[1].indexOf(".") !== -1) {
    host = m[1].toLowerCase()
    text = m[2]
  }
  var known = (host === "github.com" || host === "www.github.com") ? "github"
    : (host === "codeberg.org") ? "codeberg"
    : (host === "sourceforge.net" || host === "www.sourceforge.net") ? "sourceforge"
    : (host === "" ? "github" : null)
  if (known === null) return null

  text = text.replace(/[?#].*$/, "")
  text = text.replace(/^\/+|\/+$/g, "")

  // SourceForge identifies a repository by a single project name, not
  // owner/repo. Accept the project page and the raw feed URL alike.
  if (known === "sourceforge") {
    var project = sourceforgeProject(text)
    if (!project) return null
    return { forge: "sourceforge", owner: "", repo: project, key: "sourceforge.net/" + project }
  }

  text = text.replace(/\.git$/, "")
  var parts = text.split("/").filter(function(p) { return p !== "" })
  if (parts.length < 2) return null
  var owner = parts[0]
  var repo = parts[1]
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null

  var key = known === "github" ? owner + "/" + repo : host + "/" + owner + "/" + repo
  return { forge: known, owner: owner, repo: repo, key: key }
}

// Extract a SourceForge project name from a path like "p/scidvspc/code/feed",
// "p/scidvspc", "projects/scidvspc", or "scidvspc".
function sourceforgeProject(text) {
  var parts = String(text || "").split("/").filter(function(p) { return p !== "" })
  if (parts.length === 0) return null
  if (parts[0] === "p" || parts[0] === "projects") return parts.length >= 2 ? parts[1] : null
  var project = parts[0]
  return /^[A-Za-z0-9._-]+$/.test(project) ? project : null
}

// Parse a stored key back into its parts, or null for anything unrecognized.
function parseRepoKey(key) {
  var k = String(key === undefined || key === null ? "" : key).replace(/^\s+|\s+$/g, "")
  if (k === "") return null
  var s = k.match(/^sourceforge\.net\/([A-Za-z0-9._-]+)$/)
  if (s) return { forge: "sourceforge", owner: "", repo: s[1], key: k }
  var m = k.match(/^codeberg\.org\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/)
  if (m) return { forge: "codeberg", owner: m[1], repo: m[2], key: k }
  var g = k.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/)
  if (g) return { forge: "github", owner: g[1], repo: g[2], key: k }
  return null
}

function repoWebUrl(key) {
  var r = parseRepoKey(key)
  if (!r) return ""
  if (r.forge === "sourceforge") return FORGES.sourceforge.webBase + "/p/" + r.repo
  return FORGES[r.forge].webBase + "/" + r.owner + "/" + r.repo
}

function repoForgeLabel(key) {
  var r = parseRepoKey(key)
  return r ? FORGES[r.forge].label : ""
}

// Short display name for a repo key: "owner/repo" for GitHub and Codeberg,
// just the project name for SourceForge. Compact enough for the per-repo tabs;
// the full key stays in the list and feed headers for disambiguation.
function repoLabel(key) {
  var r = parseRepoKey(key)
  if (!r) return String(key || "")
  if (r.forge === "sourceforge") return r.repo
  return r.owner + "/" + r.repo
}

// A stable hue (0-359) for a repo key, so each repository gets a consistent,
// distinguishable accent dot without any stored state.
function repoHue(key) {
  var s = String(key || "")
  var h = 0
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

// Prototype-free object, so keys loaded from the config file (or otherwise
// external) cannot collide with Object.prototype (e.g. "__proto__").
function safeMap() {
  return Object.create(null)
}

function isSafeKey(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype"
}

function truncate(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  return s.length > max ? s.slice(0, max) : s
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function clampPage(n) {
  var v = parseInt(n, 10)
  if (!isFinite(v) || v < 1) v = 50
  if (v > 100) v = 100
  return v
}

// Build a GET request. Returns { argv, stdin }: `stdin` carries the
// Authorization header (if any) so the token never appears in `argv`, which
// is world-readable via /proc/<pid>/cmdline. The caller writes `stdin` to the
// process and closes it; curl reads the header with `-H @-`.
function curlGet(url, maxTimeSec, maxBytes, token) {
  var cap = parseInt(maxBytes, 10)
  if (!isFinite(cap) || cap < 1) cap = MAX_JSON_BYTES
  var secs = parseInt(maxTimeSec, 10)
  if (!isFinite(secs) || secs < 1) secs = 15
  var argv = [
    "curl", "-q", "-sS", "--max-time", String(secs), "--max-filesize", String(cap),
    "-H", "Accept: application/vnd.github+json",
    "-H", "User-Agent: omarchy-repo-watcher"
  ]
  var t = String(token === undefined || token === null ? "" : token).replace(/^\s+|\s+$/g, "")
  var stdin = ""
  if (t !== "") {
    argv.push("-H", "@-")
    stdin = "Authorization: Bearer " + t + "\n"
  }
  // No -f: HTTP errors are distinguished by the trailing status code rather
  // than by curl exiting, so a 404 (e.g. Gitea/Forgejo's empty-releases
  // endpoint) can be handled as "no items" instead of a hard failure.
  argv.push("-w", "\n%{http_code}", url)
  return { argv: argv, stdin: stdin }
}

// One fetch task per endpoint. "issues" covers both issues and pull requests:
// the issues endpoint returns PRs too (they carry a `pull_request` field), so
// one request serves both kinds and halves the rate-limit cost. SourceForge
// only offers an RSS commit feed, so it is a single task.
function fetchTasks(repoKey, maxEvents, token) {
  var r = parseRepoKey(repoKey)
  if (!r) return []
  if (r.forge === "sourceforge") {
    var feed = "https://sourceforge.net/p/" + r.repo + "/code/feed"
    return [makeTask(repoKey, "rss", curlGet(feed, 20, MAX_JSON_BYTES, ""))]
  }
  var forge = FORGES[r.forge]
  var n = clampPage(maxEvents)
  var base = forge.apiBase + "/repos/" + r.owner + "/" + r.repo
  // The token is a GitHub credential; sending it to another forge (Codeberg)
  // makes that forge reject it as a malformed token of its own.
  var auth = r.forge === "github" ? token : ""
  var tasks = [
    makeTask(repoKey, "commits", curlGet(base + "/commits?" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, auth)),
    makeTask(repoKey, "issues", curlGet(base + "/issues?state=all&" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, auth)),
    makeTask(repoKey, "releases", curlGet(base + "/releases?" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, auth))
  ]
  if (r.forge === "github" && String(token || "").trim() !== "") {
    tasks.push(makeTask(repoKey, "discussions", graphqlDiscussions(r, n, token)))
  }
  return tasks
}

function makeTask(repo, kind, request) {
  return { repo: repo, kind: kind, argv: request.argv, stdin: request.stdin }
}

function graphqlDiscussions(r, n, token) {
  var query = "query { repository(owner: \"" + r.owner + "\", name: \"" + r.repo + "\") { discussions(first: " + n + ", orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url createdAt author { login } } } } }"
  var body = JSON.stringify({ query: query })
  var t = String(token === undefined || token === null ? "" : token).replace(/^\s+|\s+$/g, "")
  return {
    argv: [
      "curl", "-q", "-sS", "--max-time", "20", "--max-filesize", String(MAX_JSON_BYTES),
      "-H", "Accept: application/vnd.github+json",
      "-H", "User-Agent: omarchy-repo-watcher",
      "-H", "@-",
      "-H", "Content-Type: application/json",
      "-X", "POST",
      "-d", body,
      "-w", "\n%{http_code}",
      "https://api.github.com/graphql"
    ],
    stdin: "Authorization: Bearer " + t + "\n"
  }
}

function rejectOversized(raw, maxBytes) {
  var cap = parseInt(maxBytes, 10)
  if (!isFinite(cap) || cap < 1) cap = MAX_JSON_BYTES
  return String(raw || "").length > cap
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Split curl's trailing `-w "\n%{http_code}"` off a response body.
// Returns { body, status }, where status is 0 when no code was appended.
function splitHttpStatus(text) {
  var t = String(text || "")
  var idx = t.lastIndexOf("\n")
  if (idx === -1) return { body: t, status: 0 }
  var tail = t.slice(idx + 1).replace(/^\s+|\s+$/g, "")
  if (/^\d{3}$/.test(tail)) return { body: t.slice(0, idx), status: parseInt(tail, 10) }
  return { body: t, status: 0 }
}

function errorMessage(raw, status) {
  try {
    var d = JSON.parse(String(raw || ""))
    if (d && d.message) return String(d.message)
    if (d && Array.isArray(d.errors) && d.errors.length && d.errors[0].message)
      return String(d.errors[0].message)
  } catch (e) {}
  return "HTTP " + status
}

// Parse a response for a given endpoint kind. Returns { items, error }, where
// error is "" on success and a human message otherwise.
function parseResponse(kind, raw, repoKey, status) {
  if (status === 404) {
    // A repo with no releases 404s Gitea/Forgejo's /releases endpoint (GitHub
    // returns an empty array instead). Treat that as empty. A 404 on commits
    // or issues means the repository itself does not exist.
    return (kind === "releases" || kind === "discussions")
      ? { items: [], error: "" }
      : { items: [], error: "repository not found" }
  }
  if (status !== 0 && status !== 200) {
    return { items: [], error: errorMessage(raw, status) }
  }

  // SourceForge returns an RSS feed rather than JSON.
  if (kind === "rss") return { items: parseRss(raw, repoKey), error: "" }

  var data
  try { data = JSON.parse(String(raw || "")) } catch (e) {
    return { items: [], error: "invalid response" }
  }

  if (kind === "discussions") {
    if (data && Array.isArray(data.errors) && data.errors.length > 0)
      return { items: [], error: String(data.errors[0].message || "GraphQL error") }
    var nodes = data && data.data && data.data.repository && data.data.repository.discussions
      ? data.data.repository.discussions.nodes : null
    if (!Array.isArray(nodes))
      return { items: [], error: data && data.message ? String(data.message) : "unexpected response" }
    return { items: parseDiscussionNodes(nodes, repoKey), error: "" }
  }

  if (!Array.isArray(data))
    return { items: [], error: data && data.message ? String(data.message) : "unexpected response" }

  if (kind === "commits") return { items: parseCommits(data, repoKey), error: "" }
  if (kind === "issues") return { items: parseIssuesAndPulls(data, repoKey), error: "" }
  if (kind === "releases") return { items: parseReleases(data, repoKey), error: "" }
  return { items: [], error: "unknown endpoint" }
}

function parseCommits(data, repoKey) {
  var out = []
  for (var i = 0; i < data.length; i++) {
    var c = data[i]
    if (!c || !c.sha) continue
    var commit = c.commit || {}
    var author = commit.author || {}
    var committer = commit.committer || {}
    var epoch = Date.parse(String(committer.date || author.date || ""))
    if (!isFinite(epoch)) epoch = 0
    var by = c.author && c.author.login ? String(c.author.login)
      : (author.name ? String(author.name) : "")
    out.push(makeItem("commit", repoKey, epoch,
      c.html_url || repoWebUrl(repoKey) + "/commit/" + c.sha,
      commitTitle(commit.message), by, null, null, "pushed"))
  }
  return out
}

function parseIssuesAndPulls(data, repoKey) {
  var out = []
  for (var i = 0; i < data.length; i++) {
    var it = data[i]
    if (!it || it.number === undefined || it.number === null) continue
    var isPr = it.pull_request !== undefined && it.pull_request !== null
    var epoch = Date.parse(String(it.created_at || ""))
    if (!isFinite(epoch)) epoch = 0
    out.push(makeItem(isPr ? "pr" : "issue", repoKey, epoch,
      it.html_url || "",
      "#" + it.number + " " + String(it.title || ""),
      it.user && it.user.login ? String(it.user.login) : "",
      it.number, null, it.state === "closed" ? "closed" : String(it.state || "opened")))
  }
  return out
}

function parseReleases(data, repoKey) {
  var out = []
  for (var i = 0; i < data.length; i++) {
    var rel = data[i]
    if (!rel) continue
    var epoch = Date.parse(String(rel.published_at || rel.created_at || ""))
    if (!isFinite(epoch)) epoch = 0
    var name = String(rel.name || rel.tag_name || "")
    out.push(makeItem("release", repoKey, epoch,
      rel.html_url || "",
      (rel.tag_name ? String(rel.tag_name) + " " : "") + name,
      rel.author && rel.author.login ? String(rel.author.login) : "",
      null, rel.tag_name || null, "published"))
  }
  return out
}

function parseDiscussionNodes(nodes, repoKey) {
  var out = []
  for (var i = 0; i < nodes.length; i++) {
    var d = nodes[i]
    if (!d) continue
    var epoch = Date.parse(String(d.createdAt || ""))
    if (!isFinite(epoch)) epoch = 0
    out.push(makeItem("discussion", repoKey, epoch,
      d.url || "",
      "#" + d.number + " " + String(d.title || ""),
      d.author && d.author.login ? String(d.author.login) : "",
      d.number, null, "created"))
  }
  return out
}

// ---------------------------------------------------------------------------
// SourceForge RSS
// ---------------------------------------------------------------------------

// Parse a SourceForge commit RSS feed into commit items. The feed is regular
// RSS 2.0: each <item> carries <title>, <link>, <dc:creator>, and <pubDate>.
function parseRss(raw, repoKey) {
  var out = []
  var text = String(raw || "")
  var itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g
  var m
  while ((m = itemRe.exec(text)) !== null) {
    var block = m[1]
    var title = rssField(block, "title")
    var link = rssField(block, "link")
    var creator = rssField(block, "creator") || rssField(block, "author")
    if (title === "" && link === "") continue
    out.push(makeItem("commit", repoKey, parseRfc2822(rssField(block, "pubDate")),
      link, commitTitle(title), creator, null, null, "pushed"))
  }
  out.sort(function(a, b) { return b.epoch - a.epoch })
  return out
}

// Extract a tag's text content, tolerating a namespace prefix (dc:creator).
function rssField(block, name) {
  var re = new RegExp("<(?:[A-Za-z0-9_-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?" + name + ">", "i")
  var m = String(block || "").match(re)
  if (!m) return ""
  var value = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/^\s+|\s+$/g, "")
  return decodeXml(value)
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

var RFC2822_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

// Parse an RFC 2822 date like "Sun, 30 Aug 2026 04:05:57 -0000" to epoch ms.
// Hand-written rather than Date.parse, whose RFC 2822 support is spotty in
// the QML runtime.
function parseRfc2822(value) {
  var s = String(value || "").replace(/^\s+|\s+$/g, "")
  var m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(.+)$/)
  if (!m) return 0
  var day = parseInt(m[1], 10)
  var month = RFC2822_MONTHS[m[2]]
  if (month === undefined) return 0
  var year = parseInt(m[3], 10)
  var offset = 0
  var zone = m[7].replace(/^\s+|\s+$/g, "")
  if (/^[+-]\d{4}$/.test(zone)) {
    var sign = zone.charAt(0) === "-" ? -1 : 1
    offset = sign * (parseInt(zone.substr(1, 2), 10) * 60 + parseInt(zone.substr(3, 2), 10))
  }
  return Date.UTC(year, month, day, parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)) - offset * 60000
}

function makeItem(kind, repo, epoch, url, title, author, number, ref, action) {
  return {
    kind: kind,
    repo: truncate(repo, MAX_KEY_LENGTH),
    epoch: epoch,
    url: truncate(url, MAX_STRING_LENGTH),
    title: truncate(title, MAX_STRING_LENGTH),
    author: truncate(author, MAX_STRING_LENGTH),
    number: number === undefined || number === null ? null : number,
    ref: ref === undefined || ref === null ? null : truncate(ref, MAX_STRING_LENGTH),
    action: truncate(action, MAX_STRING_LENGTH)
  }
}

function commitTitle(message) {
  var text = String(message === undefined || message === null ? "" : message)
    .split("\n")[0].replace(/^\s+|\s+$/g, "")
  if (text === "") return "(no message)"
  return truncate(text, MAX_STRING_LENGTH)
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function kindLabel(kind) {
  var k = KINDS[kind]
  return k ? k.label : String(kind || "")
}

function kindPluralLabel(kind, n) {
  var label = kindLabel(kind).toLowerCase()
  return n === 1 ? label : label + "s"
}

function badgeText(count) {
  var n = Math.max(0, count | 0)
  if (n === 0) return ""
  return n > 99 ? "99+" : String(n)
}

function relativeTime(epoch, nowEpoch) {
  var e = Number(epoch)
  var n = nowEpoch === undefined || nowEpoch === null ? Date.now() : Number(nowEpoch)
  if (!isFinite(e) || e <= 0) return ""
  var diff = n - e
  if (diff < 0) diff = 0
  var minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return minutes + "m ago"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h ago"
  var days = Math.floor(hours / 24)
  if (days < 7) return days + "d ago"
  var d = new Date(e)
  var now = new Date(n)
  if (d.getFullYear() === now.getFullYear()) return MONTHS[d.getMonth()] + " " + d.getDate()
  return MONTHS[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear()
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function defaultsConfig() {
  return {
    repos: [],
    token: "",
    autoRefresh: true,
    refreshHours: DEFAULTS.refreshHours,
    notify: true,
    maxEvents: DEFAULTS.maxEvents,
    seen: safeMap()
  }
}

function normalizeConfig(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  // Producer-side byte cap: reject an oversized config before parsing it.
  if (text.length > MAX_CONFIG_BYTES) return defaultsConfig()

  var data = {}
  try { data = JSON.parse(text) || {} } catch (e) { data = {} }
  if (typeof data !== "object" || Array.isArray(data)) data = {}

  // Repos: bounded count, each normalized, length-capped, and deduplicated.
  var repos = []
  var seenSet = safeMap()
  var list = Array.isArray(data.repos) ? data.repos : []
  for (var i = 0; i < list.length && repos.length < MAX_REPOS; i++) {
    var parsed = normalizeRepoUrl(list[i])
    if (!parsed || parsed.key.length > MAX_KEY_LENGTH || seenSet[parsed.key]) continue
    seenSet[parsed.key] = true
    repos.push(parsed.key)
  }

  // Token: bounded length, whitespace-trimmed.
  var token = typeof data.token === "string" ? data.token.replace(/^\s+|\s+$/g, "") : ""
  if (token.length > MAX_TOKEN_LENGTH) token = ""

  var maxEvents = clampPage(data.maxEvents)
  var refreshHours = parseInt(data.refreshHours, 10)
  if (!isFinite(refreshHours) || refreshHours < 1) refreshHours = DEFAULTS.refreshHours
  if (refreshHours > 168) refreshHours = 168

  // Seen: prototype-free map, bounded entries, safe length-capped keys, and
  // numeric-only cursors.
  var seen = safeMap()
  var rawSeen = (data.seen && typeof data.seen === "object" && !Array.isArray(data.seen)) ? data.seen : null
  if (rawSeen) {
    var keys = Object.keys(rawSeen)
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k]
      if (!isSafeKey(key) || key.length > MAX_KEY_LENGTH) continue
      var entry = rawSeen[key]
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      var read = Number(entry.read)
      var notified = Number(entry.notified)
      seen[key] = {
        read: isFinite(read) ? read : 0,
        notified: isFinite(notified) ? notified : 0
      }
      if (Object.keys(seen).length >= MAX_SEEN_ENTRIES) break
    }
  }

  return {
    repos: repos,
    token: token,
    autoRefresh: data.autoRefresh !== false,
    refreshHours: refreshHours,
    notify: data.notify !== false,
    maxEvents: maxEvents,
    seen: seen
  }
}

function groupByRepo(feed) {
  var map = {}
  var order = []
  var list = Array.isArray(feed) ? feed : []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    var repo = String(item.repo || "")
    if (!map[repo]) { map[repo] = []; order.push(repo) }
    map[repo].push(item)
  }
  var out = []
  for (var j = 0; j < order.length; j++) out.push({ repo: order[j], items: map[order[j]] })
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    MAX_JSON_BYTES: MAX_JSON_BYTES,
    MAX_CONFIG_BYTES: MAX_CONFIG_BYTES,
    MAX_REPOS: MAX_REPOS,
    MAX_TOKEN_LENGTH: MAX_TOKEN_LENGTH,
    MAX_SEEN_ENTRIES: MAX_SEEN_ENTRIES,
    MAX_KEY_LENGTH: MAX_KEY_LENGTH,
    MAX_STRING_LENGTH: MAX_STRING_LENGTH,
    MAX_FEED_ITEMS: MAX_FEED_ITEMS,
    KINDS: KINDS,
    KIND_ORDER: KIND_ORDER,
    DEFAULTS: DEFAULTS,
    FORGES: FORGES,
    safeMap: safeMap,
    normalizeRepoUrl: normalizeRepoUrl,
    parseRepoKey: parseRepoKey,
    repoWebUrl: repoWebUrl,
    repoForgeLabel: repoForgeLabel,
    repoLabel: repoLabel,
    repoHue: repoHue,
    fetchTasks: fetchTasks,
    curlGet: curlGet,
    rejectOversized: rejectOversized,
    splitHttpStatus: splitHttpStatus,
    parseResponse: parseResponse,
    parseRss: parseRss,
    parseRfc2822: parseRfc2822,
    commitTitle: commitTitle,
    kindLabel: kindLabel,
    kindPluralLabel: kindPluralLabel,
    badgeText: badgeText,
    relativeTime: relativeTime,
    normalizeConfig: normalizeConfig,
    groupByRepo: groupByRepo
  }
}
