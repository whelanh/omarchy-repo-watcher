// Unit tests for Model.js. Run with: node tests/model.test.js
// Pure Node, no QML runtime and no dependencies.
const assert = require("assert")
const M = require("../Model.js")

// normalizeRepoUrl — GitHub and Codeberg forms.
assert.deepStrictEqual(M.normalizeRepoUrl("https://github.com/owner/repo").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("owner/repo").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("git@github.com:owner/repo.git").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("ssh://git@github.com/owner/repo.git").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("github.com/owner/repo").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("https://github.com/owner/repo/issues/12").key, "owner/repo")
assert.deepStrictEqual(M.normalizeRepoUrl("https://codeberg.org/scid/scid").key, "codeberg.org/scid/scid")
assert.deepStrictEqual(M.normalizeRepoUrl("codeberg.org/scid/scid").key, "codeberg.org/scid/scid")
assert.deepStrictEqual(M.normalizeRepoUrl("git@codeberg.org:scid/scid.git").key, "codeberg.org/scid/scid")
assert.strictEqual(M.normalizeRepoUrl("owner"), null)
assert.strictEqual(M.normalizeRepoUrl(""), null)
assert.strictEqual(M.normalizeRepoUrl("https://gitlab.com/x/y"), null)

// parseRepoKey round-trips the canonical key.
assert.deepStrictEqual(M.parseRepoKey("owner/repo"),
  { forge: "github", owner: "owner", repo: "repo", key: "owner/repo" })
assert.deepStrictEqual(M.parseRepoKey("codeberg.org/scid/scid"),
  { forge: "codeberg", owner: "scid", repo: "scid", key: "codeberg.org/scid/scid" })
assert.strictEqual(M.parseRepoKey("bogus"), null)

// repoWebUrl / repoHue.
assert.strictEqual(M.repoWebUrl("owner/repo"), "https://github.com/owner/repo")
assert.strictEqual(M.repoWebUrl("codeberg.org/scid/scid"), "https://codeberg.org/scid/scid")
assert.strictEqual(M.repoHue("x/y"), M.repoHue("x/y"))

// fetchTasks: 3 REST endpoints for Codeberg, plus GraphQL discussions for a
// tokenized GitHub repo. GitHub uses per_page, Codeberg uses limit.
assert.strictEqual(M.fetchTasks("owner/repo", 50, "").length, 3)
assert.strictEqual(M.fetchTasks("owner/repo", 50, "tok").length, 4)
assert.strictEqual(M.fetchTasks("codeberg.org/scid/scid", 50, "tok").length, 3)
assert.ok(M.fetchTasks("owner/repo", 50, "")[0].argv.join(" ").indexOf("per_page=50") !== -1)
assert.ok(M.fetchTasks("codeberg.org/scid/scid", 50, "")[0].argv.join(" ").indexOf("limit=50") !== -1)
const disc = M.fetchTasks("owner/repo", 50, "tok").find(t => t.kind === "discussions")
assert.ok(disc.argv.indexOf("POST") !== -1)
assert.ok(disc.argv.join(" ").indexOf("api.github.com/graphql") !== -1)

// splitHttpStatus strips curl's trailing status code.
assert.deepStrictEqual(M.splitHttpStatus("[1,2]\n200"), { body: "[1,2]", status: 200 })
assert.deepStrictEqual(M.splitHttpStatus('{"message":"x"}\n404'), { body: '{"message":"x"}', status: 404 })
assert.deepStrictEqual(M.splitHttpStatus("[1,2]"), { body: "[1,2]", status: 0 })

// parseResponse: commits.
const commits = [{
  sha: "a1", html_url: "https://github.com/o/r/commit/a1",
  commit: {
    message: "Fix bug\n\nbody",
    author: { name: "Alice", date: "2026-08-30T10:00:00Z" },
    committer: { name: "Alice", date: "2026-08-30T10:00:00Z" }
  },
  author: { login: "alice" }
}]
let r = M.parseResponse("commits", JSON.stringify(commits), "o/r", 200)
assert.strictEqual(r.error, "")
assert.strictEqual(r.items.length, 1)
assert.strictEqual(r.items[0].title, "Fix bug")
assert.strictEqual(r.items[0].author, "alice")
assert.strictEqual(r.items[0].epoch, Date.parse("2026-08-30T10:00:00Z"))

// Codeberg commits have a null top-level author; fall back to commit.author.name.
const cbCommit = [{
  sha: "b", html_url: "https://codeberg.org/o/r/commit/b",
  commit: { message: "M", author: { name: "Uwe", date: "2026-08-01T00:00:00+02:00" }, committer: { name: "Uwe", date: "2026-08-01T00:00:00+02:00" } },
  author: null
}]
r = M.parseResponse("commits", JSON.stringify(cbCommit), "codeberg.org/o/r", 200)
assert.strictEqual(r.items[0].author, "Uwe")

// parseResponse: issues+pulls split by the pull_request field.
const issues = [
  { number: 1, title: "I", html_url: "u", user: { login: "bob" }, state: "open", created_at: "2026-08-01T00:00:00Z" },
  { number: 2, title: "P", html_url: "u", user: { login: "c" }, state: "open", created_at: "2026-08-02T00:00:00Z", pull_request: {} }
]
r = M.parseResponse("issues", JSON.stringify(issues), "o/r", 200)
assert.strictEqual(r.items[0].kind, "issue")
assert.strictEqual(r.items[1].kind, "pr")

// parseResponse: releases.
const rel = [{ tag_name: "v1", name: "One", html_url: "u", published_at: "2026-08-03T00:00:00Z", author: { login: "d" } }]
r = M.parseResponse("releases", JSON.stringify(rel), "o/r", 200)
assert.strictEqual(r.items[0].kind, "release")
assert.strictEqual(r.items[0].ref, "v1")

// parseResponse: discussions (GraphQL).
const gql = { data: { repository: { discussions: { nodes: [
  { number: 3, title: "Q", url: "u", createdAt: "2026-08-26T09:00:00Z", author: { login: "eve" } }
] } } } }
r = M.parseResponse("discussions", JSON.stringify(gql), "o/r", 200)
assert.strictEqual(r.error, "")
assert.strictEqual(r.items[0].kind, "discussion")
assert.strictEqual(r.items[0].title, "#3 Q")

// parseResponse status handling.
assert.deepStrictEqual(M.parseResponse("releases", '{"message":"nf"}', "c.org/a/b", 404), { items: [], error: "" })
assert.strictEqual(M.parseResponse("commits", '{"message":"nf"}', "c.org/a/b", 404).error, "repository not found")
assert.strictEqual(M.parseResponse("commits", '{"message":"API rate limit exceeded"}', "a/b", 403).error, "API rate limit exceeded")
assert.strictEqual(M.parseResponse("commits", "Forbidden", "a/b", 403).error, "HTTP 403")

// normalizeConfig: dedup + forge keys.
assert.deepStrictEqual(
  M.normalizeConfig(JSON.stringify({ repos: ["owner/repo", "https://codeberg.org/scid/scid", "codeberg.org/scid/scid", "bogus"], maxEvents: 200, refreshHours: 0 })).repos,
  ["owner/repo", "codeberg.org/scid/scid"])
assert.strictEqual(M.normalizeConfig(JSON.stringify({})).maxEvents, 50)

console.log("Model tests passed")
