# Repo Watcher for Omarchy

An Omarchy Quattro bar widget with a repo glyph and an unread badge that
watches repositories you are interested in (but don't own) on **GitHub** and
**Codeberg**, and surfaces their recent activity in a popup panel with a
per-repository tab for each one.

Plugin id: `io.github.whelanh.repo-watcher`

## What it does

- **Commits** — the latest commits on the default branch.
- **Issues** — open and closed issues.
- **Pull requests** — open and closed pull requests.
- **Releases** — published releases (GitHub and Codeberg).
- **Discussions** — GitHub discussions (requires a token; see below).

Activity is fetched from each repository's dedicated API endpoints (not the
aggregate events feed), so commits, issues, pull requests, and releases all
show up instead of being crowded out by stars and watches. The panel shows an
`All` view plus one tab per watched repository, each marked with a stable
color dot, so you can read one repository at a time without scrolling through
the rest. The bar pill carries a red unread badge; new items inside the panel
carry an accent dot, and closing the panel marks them read.

## Install

```bash
omarchy plugin add https://github.com/whelanh/omarchy-repo-watcher.git --enable
omarchy bar move io.github.whelanh.repo-watcher --section right
```

## Usage

- **Left click** the repo glyph in the bar to open or close the panel.
- **Middle click** the glyph (or the ↻ button in the panel, or the `r` key) to
  refresh now.
- **Right click** the glyph to mark everything read.
- Add a repository by pasting any of `https://github.com/owner/repo`,
  `owner/repo`, `git@github.com:owner/repo.git`, or
  `https://codeberg.org/owner/repo`.
- Click a repository's row to open it in the browser, or click any individual
  event to open that commit/issue/PR/release.
- `Tab` / `Shift+Tab` switches to the neighbouring bar panel.

## Configuration

Settings and the watched list live in
`~/.config/omarchy/repo-watcher/config.json` and are edited from the panel's
settings view:

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| `repos` | `[]` | List of watched repositories. |
| `token` | `""` | Optional GitHub personal access token. |
| `notify` | `true` | Send a desktop notification on new activity. |
| `autoRefresh` | `true` | Poll once at startup, then once a day. |
| `refreshHours` | `24` | Automatic poll interval in hours. |
| `maxEvents` | `50` | Max items shown per repository (1–100). |

## GitHub token

Without a token GitHub allows **60 requests/hour**; with one it allows
**5000/hour**. Each refresh makes several requests per repository (commits,
issues + pull requests, releases), so a token is recommended for more than a
couple of repositories. Discussions are fetched through GitHub's GraphQL API,
which always requires a token — without one, discussions are simply skipped.
Codeberg does not need a token.

1. Create a *fine-grained* token at <https://github.com/settings/tokens> with
   read-only access to public repositories (no write/private scopes needed).
2. Paste it into the panel's settings (stored in `config.json`, never written
   to `shell.json`). You can also reuse `gh auth token`.

## Data and privacy

- Talks only to the public APIs of GitHub and Codeberg, for the repositories
  you add.
- The token, if set, is stored in `~/.config/omarchy/repo-watcher/config.json`.
- Does not request elevated privileges, runs no background service, and starts
  no second Quickshell process (the polling lives in the shell's own service).

## Development checks

```bash
omarchy plugin validate .
qmllint -I "$OMARCHY_PATH/shell" Panel.qml Service.qml
```

## Remove

```bash
omarchy plugin remove io.github.whelanh.repo-watcher
```

## License

Plugin code is MIT licensed. See [LICENSE](LICENSE).
