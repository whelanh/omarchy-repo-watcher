// GitHub Watch — pure parsing and normalization helpers, shared by the QML
// (Service.qml / Panel.qml / BarWidget.qml) and unit-testable under node.
// Deliberately Qt-free so nothing here depends on the QML runtime.
//
// Forges are supported through per-forge API bases. GitHub and Codeberg
// (Gitea/Forgejo) share near-identical REST shapes for commits, issues, pull
// requests, and releases, so one parser serves both. Discussions are a
// GitHub-only feature and require a token (GraphQL always authenticates).

var MAX_JSON_BYTES = 1048576

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
var FORGES = {
  github: { label: "GitHub", apiBase: "https://api.github.com", webBase: "https://github.com", pageParam: "per_page" },
  codeberg: { label: "Codeberg", apiBase: "https://codeberg.org/api/v1", webBase: "https://codeberg.org", pageParam: "limit" }
}

// ---------------------------------------------------------------------------
// Repo keys
// ---------------------------------------------------------------------------
//
// A watched repo is stored as a canonical key string:
//   github   -> "owner/repo"
//   codeberg -> "codeberg.org/owner/repo"
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
    : (host === "" ? "github" : null)
  if (known === null) return null

  text = text.replace(/\.git$/, "")
  text = text.replace(/[?#].*$/, "")
  text = text.replace(/^\/+|\/+$/g, "")

  var parts = text.split("/").filter(function(p) { return p !== "" })
  if (parts.length < 2) return null
  var owner = parts[0]
  var repo = parts[1]
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null

  var key = known === "github" ? owner + "/" + repo : host + "/" + owner + "/" + repo
  return { forge: known, owner: owner, repo: repo, key: key }
}

// Parse a stored key back into its parts, or null for anything unrecognized.
function parseRepoKey(key) {
  var k = String(key === undefined || key === null ? "" : key).replace(/^\s+|\s+$/g, "")
  if (k === "") return null
  var m = k.match(/^codeberg\.org\/([^/]+)\/([^/]+)$/)
  if (m) return { forge: "codeberg", owner: m[1], repo: m[2], key: k }
  var g = k.match(/^([^/]+)\/([^/]+)$/)
  if (g) return { forge: "github", owner: g[1], repo: g[2], key: k }
  return null
}

function repoWebUrl(key) {
  var r = parseRepoKey(key)
  if (!r) return ""
  return FORGES[r.forge].webBase + "/" + r.owner + "/" + r.repo
}

function repoForgeLabel(key) {
  var r = parseRepoKey(key)
  return r ? FORGES[r.forge].label : ""
}

// A stable hue (0-359) for a repo key, so each repository gets a consistent,
// distinguishable accent dot without any stored state.
function repoHue(key) {
  var s = String(key || "")
  var h = 0
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
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

function curlGet(url, maxTimeSec, maxBytes, token) {
  var cap = parseInt(maxBytes, 10)
  if (!isFinite(cap) || cap < 1) cap = MAX_JSON_BYTES
  var secs = parseInt(maxTimeSec, 10)
  if (!isFinite(secs) || secs < 1) secs = 15
  var argv = [
    "curl", "-sS", "--max-time", String(secs), "--max-filesize", String(cap),
    "-H", "Accept: application/vnd.github+json",
    "-H", "User-Agent: omarchy-repo-watcher"
  ]
  var t = String(token === undefined || token === null ? "" : token).replace(/^\s+|\s+$/g, "")
  if (t !== "") argv.push("-H", "Authorization: Bearer " + t)
  // No -f: HTTP errors are distinguished by the trailing status code rather
  // than by curl exiting, so a 404 (e.g. Gitea/Forgejo's empty-releases
  // endpoint) can be handled as "no items" instead of a hard failure.
  argv.push("-w", "\n%{http_code}", url)
  return argv
}

// One fetch task per endpoint. "issues" covers both issues and pull requests:
// the issues endpoint returns PRs too (they carry a `pull_request` field), so
// one request serves both kinds and halves the rate-limit cost.
function fetchTasks(repoKey, maxEvents, token) {
  var r = parseRepoKey(repoKey)
  if (!r) return []
  var forge = FORGES[r.forge]
  var n = clampPage(maxEvents)
  var base = forge.apiBase + "/repos/" + r.owner + "/" + r.repo
  var tasks = [
    { repo: repoKey, kind: "commits", argv: curlGet(base + "/commits?" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, token) },
    { repo: repoKey, kind: "issues", argv: curlGet(base + "/issues?state=all&" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, token) },
    { repo: repoKey, kind: "releases", argv: curlGet(base + "/releases?" + forge.pageParam + "=" + n, 15, MAX_JSON_BYTES, token) }
  ]
  if (r.forge === "github" && String(token || "").trim() !== "") {
    tasks.push({ repo: repoKey, kind: "discussions", argv: graphqlDiscussions(r, n, token) })
  }
  return tasks
}

function graphqlDiscussions(r, n, token) {
  var query = "query { repository(owner: \"" + r.owner + "\", name: \"" + r.repo + "\") { discussions(first: " + n + ", orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url createdAt author { login } } } } }"
  var body = JSON.stringify({ query: query })
  var t = String(token === undefined || token === null ? "" : token).replace(/^\s+|\s+$/g, "")
  return [
    "curl", "-sS", "--max-time", "20", "--max-filesize", String(MAX_JSON_BYTES),
    "-H", "Accept: application/vnd.github+json",
    "-H", "User-Agent: omarchy-repo-watcher",
    "-H", "Authorization: Bearer " + t,
    "-H", "Content-Type: application/json",
    "-X", "POST",
    "-d", body,
    "-w", "\n%{http_code}",
    "https://api.github.com/graphql"
  ]
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

function makeItem(kind, repo, epoch, url, title, author, number, ref, action) {
  return {
    kind: kind,
    repo: repo,
    epoch: epoch,
    url: String(url || ""),
    title: String(title || ""),
    author: String(author || ""),
    number: number === undefined || number === null ? null : number,
    ref: ref === undefined || ref === null ? null : ref,
    action: String(action || "")
  }
}

function commitTitle(message) {
  var text = String(message === undefined || message === null ? "" : message)
    .split("\n")[0].replace(/^\s+|\s+$/g, "")
  return text === "" ? "(no message)" : text
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

function normalizeConfig(raw) {
  var data = {}
  try { data = JSON.parse(String(raw || "")) || {} } catch (e) { data = {} }
  if (typeof data !== "object") data = {}

  var repos = []
  var seen = {}
  var list = Array.isArray(data.repos) ? data.repos : []
  for (var i = 0; i < list.length; i++) {
    var parsed = normalizeRepoUrl(list[i])
    if (!parsed || seen[parsed.key]) continue
    seen[parsed.key] = true
    repos.push(parsed.key)
  }

  var maxEvents = clampPage(data.maxEvents)
  var refreshHours = parseInt(data.refreshHours, 10)
  if (!isFinite(refreshHours) || refreshHours < 1) refreshHours = DEFAULTS.refreshHours
  if (refreshHours > 168) refreshHours = 168

  return {
    repos: repos,
    token: typeof data.token === "string" ? data.token : "",
    autoRefresh: data.autoRefresh !== false,
    refreshHours: refreshHours,
    notify: data.notify !== false,
    maxEvents: maxEvents,
    seen: (data.seen && typeof data.seen === "object") ? data.seen : {}
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
    KINDS: KINDS,
    KIND_ORDER: KIND_ORDER,
    DEFAULTS: DEFAULTS,
    FORGES: FORGES,
    normalizeRepoUrl: normalizeRepoUrl,
    parseRepoKey: parseRepoKey,
    repoWebUrl: repoWebUrl,
    repoForgeLabel: repoForgeLabel,
    repoHue: repoHue,
    fetchTasks: fetchTasks,
    curlGet: curlGet,
    rejectOversized: rejectOversized,
    splitHttpStatus: splitHttpStatus,
    parseResponse: parseResponse,
    commitTitle: commitTitle,
    kindLabel: kindLabel,
    kindPluralLabel: kindPluralLabel,
    badgeText: badgeText,
    relativeTime: relativeTime,
    normalizeConfig: normalizeConfig,
    groupByRepo: groupByRepo
  }
}
