import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Headless singleton behind GitHub Watch.
//
// A bar widget is instantiated once per monitor, so all polling and state live
// here: the shell mounts exactly one service per plugin, which keeps a
// two-monitor setup from doubling every request.
//
// The service owns the config file (~/.config/omarchy/repo-watcher/config.json)
// — the list of watched repositories, an optional GitHub token, and per-repo
// read/notified cursors. The panel talks to it through the reference injected
// by BarWidget.qml, so there is a single writer for the file.
Item {
  id: root

  // Injected by the shell.
  property var shell: null
  property var settings: ({})

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: home + "/.config/omarchy/repo-watcher"
  readonly property string configPath: configDir + "/config.json"

  // Secure, bounded config I/O lives in a Python helper so reads and writes
  // are descriptor-bound (no-follow, regular-file, owner/mode, byte caps).
  readonly property string helperScript: decodeURIComponent(
    String(Qt.resolvedUrl("bin/repo-watcher-config")).replace(/^file:\/\//, ""))

  // Single source of truth, plus derived state for the bar and panel.
  property var config: Model.normalizeConfig("")
  property bool configLoaded: false

  property var itemsByRepo: ({})
  property var feed: []
  property int unreadCount: 0
  property int lastUpdated: 0
  property bool busy: false
  property string lastError: ""

  // Fetch queue (one task per endpoint) and per-refresh notification batch.
  property var fetchTasks: []
  property var currentTask: null
  property var accumulator: ({})
  property var batchNotify: []
  property int lastAutoRefresh: 0
  property bool bootPolled: false

  // Config-write coalescing (see saveConfig/flushSave).
  property string pendingSave: ""
  property bool saveBusy: false
  property string configReadText: ""
  property string configReadError: ""

  readonly property bool autoRefresh: config.autoRefresh === true
  readonly property bool notify: config.notify === true
  readonly property int refreshHours: config.refreshHours
  readonly property int maxEvents: config.maxEvents
  readonly property string token: config.token

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // ---------------------------------------------------------------------------
  // Config file
  // ---------------------------------------------------------------------------

  // Loading and saving go through the Python helper (see the Processes at the
  // bottom). applyConfig is invoked from loadProc once the file is read.

  function applyConfig(text) {
    root.config = Model.normalizeConfig(text)
    root.configLoaded = true
    root.rebuild()
    // The first time settings load, do the automatic poll the user asked for:
    // once at boot, then daily. Guarded so a later reload (our own config
    // writes, or a manual edit) does not re-trigger the boot poll.
    if (!root.bootPolled) {
      root.bootPolled = true
      if (root.autoRefresh && root.config.repos.length > 0) {
        root.lastAutoRefresh = Date.now()
        Qt.callLater(root.refresh)
      }
    }
  }

  // Persist the config with a private mode via the helper. Writes are
  // coalesced: a burst of saves during a refresh writes once, and a save
  // requested mid-write is flushed when the current one finishes.
  function saveConfig() {
    root.pendingSave = JSON.stringify(root.config, null, 2) + "\n"
    // Bound the payload before launch so an oversized config is never piped
    // to the writer.
    if (root.pendingSave.length > Model.MAX_CONFIG_BYTES) {
      root.pendingSave = ""
      root.lastError = "config too large to save"
      return
    }
    if (!root.saveBusy) root.flushSave()
  }

  function flushSave() {
    if (root.saveBusy || root.pendingSave === "") return
    root.saveBusy = true
    saveProc.command = ["timeout", "15", "python3", root.helperScript, "write", root.configPath]
    saveProc.stdinEnabled = true
    saveProc.running = true
  }

  // Reassign `config` to a fresh object so QML bindings that read nested
  // fields (config.repos, config.notify, ...) re-evaluate. Mutating a nested
  // field in place is invisible to the QML change-notification system.
  function commitConfig() {
    var c = root.config
    var next = {}
    for (var key in c) next[key] = c[key]
    root.config = next
  }

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  function refresh() {
    if (root.busy) return
    var repos = root.config.repos || []
    if (repos.length === 0) { root.lastUpdated = Date.now(); return }
    root.busy = true
    root.lastError = ""
    root.batchNotify = []
    root.accumulator = ({})
    root.fetchTasks = []
    for (var i = 0; i < repos.length; i++) {
      var tasks = Model.fetchTasks(repos[i], root.maxEvents, root.token)
      for (var j = 0; j < tasks.length; j++) root.fetchTasks.push(tasks[j])
    }
    root.fetchNext()
  }

  function fetchNext() {
    if (root.fetchTasks.length === 0) { root.finishRefresh(); return }
    root.currentTask = root.fetchTasks.shift()
    fetchProc.command = root.currentTask.argv
    // Open stdin only for requests that carry an Authorization header, so the
    // token can be written to curl's `-H @-` and never appears in argv.
    fetchProc.stdinEnabled = root.currentTask.stdin !== ""
    fetchProc.running = true
  }

  function finishRefresh() {
    for (var repo in root.accumulator) {
      var items = root.accumulator[repo] || []
      items.sort(function(a, b) { return b.epoch - a.epoch })
      root.applyRepo(repo, items)
    }
    root.accumulator = ({})
    root.saveConfig()
    root.busy = false
    root.lastUpdated = Date.now()
    if (root.batchNotify.length > 0) {
      root.sendNotification(root.batchNotify)
      root.batchNotify = []
    }
  }

  function noteError(repo, message) {
    if (root.lastError !== "") return
    var msg = String(message || "")
    if (/rate limit/i.test(msg)) {
      // The limit is shared across every GitHub repository, not a property of
      // this one — attribute it globally and make the fix obvious.
      root.lastError = "GitHub rate limit reached (60/hour without a token) \u00b7 add a token in Settings"
    } else {
      root.lastError = repo + ": " + msg
    }
  }

  function handleStdout(raw) {
    var task = root.currentTask
    if (!task) return
    var split = Model.splitHttpStatus(String(raw || ""))
    var body = split.body
    var status = split.status
    if (body.trim() === "") return
    if (Model.rejectOversized(body, Model.MAX_JSON_BYTES)) {
      root.noteError(task.repo, "response too large")
      return
    }
    var result = Model.parseResponse(task.kind, body, task.repo, status)
    if (result.error !== "") {
      root.noteError(task.repo, result.error)
      return
    }
    var acc = root.accumulator[task.repo] || []
    root.accumulator[task.repo] = acc.concat(result.items)
  }

  // Merge a repo's fresh items into the feed and advance its cursors. The
  // first fetch of a repo is a baseline: nothing is flagged new and nothing is
  // notified, so adding a busy repo does not announce its whole history.
  function applyRepo(fullName, items) {
    items.sort(function(a, b) { return b.epoch - a.epoch })
    // The "max items" preference is a display cap per repository: fetch enough
    // of each category, then keep only the newest N across all of them.
    var cap = root.maxEvents
    if (cap > 0 && items.length > cap) items = items.slice(0, cap)

    var seen = root.config.seen || {}
    var state = seen[fullName] || null
    var baseline = state === null || state === undefined

    var readEpoch = state && Number(state.read) ? Number(state.read) : 0
    var notifiedEpoch = state && Number(state.notified) ? Number(state.notified) : 0
    var maxEpoch = items.length > 0 ? items[0].epoch : 0

    root.itemsByRepo[fullName] = items

    var toNotify = []
    if (!baseline && root.notify) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].epoch > notifiedEpoch) toNotify.push(items[i])
      }
    }

    seen[fullName] = {
      read: baseline ? maxEpoch : readEpoch,
      notified: maxEpoch > notifiedEpoch ? maxEpoch : notifiedEpoch
    }
    root.config.seen = seen

    root.rebuild()
    root.commitConfig()

    if (toNotify.length > 0) root.batchNotify = root.batchNotify.concat(toNotify)
  }

  // Recompute the flat feed and unread count from the per-repo item lists and
  // the current read cursors.
  function rebuild() {
    var seen = root.config.seen || {}
    var flat = []
    for (var repo in root.itemsByRepo) {
      var items = root.itemsByRepo[repo] || []
      var state = seen[repo] || null
      var readEpoch = state && Number(state.read) ? Number(state.read) : 0
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        var copy = {}
        for (var k in it) copy[k] = it[k]
        copy.isNew = it.epoch > readEpoch
        flat.push(copy)
      }
    }
    flat.sort(function(a, b) { return b.epoch - a.epoch })
    // Aggregate cap: never hold more than MAX_FEED_ITEMS in memory or on
    // screen, and derive the unread count from the capped set.
    if (flat.length > Model.MAX_FEED_ITEMS) flat = flat.slice(0, Model.MAX_FEED_ITEMS)
    var unread = 0
    for (var j = 0; j < flat.length; j++) if (flat[j].isNew) unread++
    root.feed = flat
    root.unreadCount = unread
  }

  // ---------------------------------------------------------------------------
  // Repo and preference editing
  // ---------------------------------------------------------------------------

  function addRepo(input) {
    var parsed = Model.normalizeRepoUrl(input)
    if (!parsed) {
      root.lastError = "Not a recognized repository: " + String(input || "")
      return false
    }
    var repos = root.config.repos.slice()
    if (repos.indexOf(parsed.key) === -1) repos.push(parsed.key)
    root.config.repos = repos
    root.lastError = ""
    root.commitConfig()
    root.saveConfig()
    root.refresh()
    return true
  }

  function removeRepo(fullName) {
    var repos = root.config.repos.slice()
    var idx = repos.indexOf(fullName)
    if (idx !== -1) repos.splice(idx, 1)
    root.config.repos = repos

    var seen = root.config.seen || {}
    delete seen[fullName]
    root.config.seen = seen

    var next = {}
    for (var r in root.itemsByRepo) if (r !== fullName) next[r] = root.itemsByRepo[r]
    root.itemsByRepo = next

    root.rebuild()
    root.commitConfig()
    root.saveConfig()
  }

  function markAllRead() {
    var seen = root.config.seen || {}
    for (var repo in root.itemsByRepo) {
      var items = root.itemsByRepo[repo] || []
      var maxEpoch = items.length > 0 ? items[0].epoch : 0
      var state = seen[repo] || { read: 0, notified: 0 }
      var read = Number(state.read) || 0
      if (maxEpoch > read) state.read = maxEpoch
      seen[repo] = state
    }
    root.config.seen = seen
    root.rebuild()
    root.commitConfig()
    root.saveConfig()
  }

  function updatePrefs(patch) {
    var c = root.config
    for (var key in patch) {
      c[key] = key === "token"
        ? String(patch[key] === undefined || patch[key] === null ? "" : patch[key]).replace(/^\s+|\s+$/g, "")
        : patch[key]
    }
    root.commitConfig()
    root.saveConfig()
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  function sendNotification(items) {
    var counts = {}
    var repos = []
    var repoSet = {}
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      counts[it.kind] = (counts[it.kind] || 0) + 1
      if (!repoSet[it.repo]) { repoSet[it.repo] = true; repos.push(it.repo) }
    }
    var parts = []
    for (var j = 0; j < Model.KIND_ORDER.length; j++) {
      var kind = Model.KIND_ORDER[j]
      if (counts[kind]) parts.push(counts[kind] + " " + Model.kindPluralLabel(kind, counts[kind]))
    }
    var description = repos.join(", ") + ": " + parts.join(", ")
    notifyProc.command = [
      "omarchy-notification-send",
      "--app-name", "Repo Watcher",
      "-u", "normal",
      "Repo Watcher",
      description
    ]
    notifyProc.running = true
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  // Hourly tick; fires the actual poll only when the configured daily interval
  // has elapsed. Combined with the boot-time poll in applyConfig, this gives
  // "check once on boot, then once a day" without a busy loop.
  Timer {
    id: autoTimer
    interval: 3600000
    repeat: true
    running: root.configLoaded && root.autoRefresh
    onTriggered: {
      if (!root.autoRefresh || (root.config.repos || []).length === 0) return
      var elapsed = Date.now() - root.lastAutoRefresh
      if (elapsed >= root.refreshHours * 3600000) {
        root.lastAutoRefresh = Date.now()
        root.refresh()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Processes
  // ---------------------------------------------------------------------------

  // One-time setup + migration: create the directory private (0700), tighten
  // an existing file to 0600, then load the config. Both run through the
  // helper under a deadline.
  Process {
    id: setupProc
    command: ["timeout", "15", "python3", root.helperScript, "setup", root.configPath]
    onExited: function(code) { loadProc.running = true }
  }

  Process {
    id: loadProc
    command: ["timeout", "15", "python3", root.helperScript, "read", root.configPath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.configReadText = String(text || "")
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.configReadError = String(text || "").trim()
    }
    onExited: function(code) {
      if (code === 0) {
        root.applyConfig(root.configReadText)
      } else if (code === 1) {
        // No config file yet (fresh install): use defaults.
        root.applyConfig("")
      } else {
        // Invalid or unsafe config: fall back to defaults and surface why.
        root.applyConfig("")
        root.lastError = root.configReadError !== "" ? root.configReadError : "config could not be read safely; using defaults"
      }
    }
  }

  // Writes the config through the helper, which creates the file 0600 inside
  // the verified 0700 directory (see flushSave). Coalesces bursts of saves.
  Process {
    id: saveProc
    onStarted: {
      if (root.pendingSave !== "") {
        saveProc.write(root.pendingSave)
        root.pendingSave = ""
      }
      saveProc.stdinEnabled = false
    }
    onExited: function(code) {
      root.saveBusy = false
      if (code === 0) {
        if (root.pendingSave !== "") root.flushSave()
      } else {
        // Any failure leaves the previous config intact (temp + rename);
        // surface it and drop the pending write rather than retry forever.
        root.lastError = "failed to save config"
        root.pendingSave = ""
      }
    }
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleStdout(text)
    }
    onStarted: {
      // The process is running and stdin is open; write the Authorization
      // header (if any) and close stdin so curl's `-H @-` sees EOF and stops
      // reading.
      if (root.currentTask && root.currentTask.stdin !== "") {
        fetchProc.write(root.currentTask.stdin)
        fetchProc.stdinEnabled = false
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        var repo = root.currentTask ? root.currentTask.repo : ""
        root.noteError(repo, "fetch failed")
      }
      root.fetchNext()
    }
  }

  Process {
    id: notifyProc
  }

  Component.onCompleted: {
    setupProc.running = true
  }
}
