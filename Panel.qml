import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Repo Watcher popup: the watched-repository feed, add/remove controls, and
// settings. BarWidget.qml injects the service reference; the panel never
// writes the config file itself — every mutation goes through the service so
// there is a single writer.
Panel {
  id: root
  moduleName: "io.github.whelanh.repo-watcher"
  ipcTarget: "io.github.whelanh.repo-watcher"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null

  readonly property var barIdentity: hostWidget || root

  // "feed" | "settings"
  property string view: "feed"

  // Ticked while open so relative timestamps stay honest.
  property date now: new Date()

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var grouped: Model.groupByRepo(root.service ? root.service.feed : [])
  readonly property var repos: root.service ? root.service.config.repos : []
  readonly property int unread: root.service ? root.service.unreadCount : 0
  readonly property bool busy: root.service ? root.service.busy : false
  readonly property string errorText: root.service ? root.service.lastError : ""

  // Per-repository tab selection. "" means "All".
  property string selectedRepo: ""

  readonly property var tabs: [""].concat(root.repos)

  readonly property var activeGroups: {
    var groups = root.grouped
    if (root.selectedRepo === "") return groups
    var out = []
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].repo === root.selectedRepo) out.push(groups[i])
    }
    return out
  }

  // Stable per-repo accent dot, distinct from the "new" dot.
  function repoColor(repo) {
    return Qt.hsla(Model.repoHue(repo), 0.6, 0.55, 1.0)
  }

  readonly property string updatedText: root.service && root.service.lastUpdated > 0
    ? "Updated " + Model.relativeTime(root.service.lastUpdated, root.now.getTime())
    : ""

  readonly property string heroMeta: {
    if (root.busy) return "Checking\u2026"
    if (root.errorText !== "") return root.errorText
    if (root.updatedText !== "") return root.updatedText
    return repos.length > 0 ? "Watching " + repos.length + " repositor" + (repos.length === 1 ? "y" : "ies") : "No repositories yet"
  }

  // ---- Panel lifecycle. Closing marks everything read, so the "new" dot is
  //      a signal about what arrived since the last time the panel was open.
  function open() {
    setCenterHoverRevealSuppressed(false)
    root.now = new Date()
    root.controller.show()
  }

  function openFromHotkey() {
    root.controller.show()
    root.now = new Date()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.controller.hide()
    if (root.service && root.service.markAllRead) root.service.markAllRead()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function refresh() {
    if (root.service && root.service.refresh) root.service.refresh()
  }

  function addRepo() {
    var text = String(repoField.text || "").replace(/^\s+|\s+$/g, "")
    if (text === "") return
    if (root.service && root.service.addRepo) root.service.addRepo(text)
    repoField.text = ""
  }

  function openRepo(fullName) {
    var url = Model.repoWebUrl(fullName)
    if (url) Quickshell.execDetached(["omarchy-launch-browser", url])
  }

  function openItem(url) {
    if (url) Quickshell.execDetached(["omarchy-launch-browser", url])
  }

  function enterSettings() {
    root.view = "settings"
    tokenDraft = root.service ? root.service.config.token : ""
    tokenField.text = tokenDraft
  }

  function leaveSettings() {
    root.view = "feed"
  }

  // Commit the token explicitly: editingFinished alone is not reliable here,
  // because clicking Done does not move focus off the (non-focusable) field.
  function commitSettings() {
    if (root.service) root.service.updatePrefs({ token: tokenField.text })
    root.leaveSettings()
  }

  property string tokenDraft: ""

  Timer {
    interval: 60000
    running: root.opened
    repeat: true
    onTriggered: root.now = new Date()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(640))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: repoField.activeFocus || tokenField.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r") root.refresh()
      }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: parent.width
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            title: "Repo Watcher"
            meta: root.heroMeta
            detail: root.unread > 0 ? root.unread + " new" : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            trailingControl: Component {
              Row {
                spacing: Style.space(2)

                PanelActionButton {
                  iconText: "\uf021"
                  tooltipText: "Refresh now"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.refresh()
                }

                PanelActionButton {
                  iconText: "\uf013"
                  tooltipText: "Settings"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.enterSettings()
                }
              }
            }
          }

          // ---- Activity view -------------------------------------------------
          Column {
            width: parent.width
            visible: root.view === "feed"
            spacing: Style.space(10)

            Row {
              width: parent.width
              spacing: Style.space(8)

              TextField {
                id: repoField
                width: parent.width - addButton.width - parent.spacing
                placeholderText: "github.com/owner/repo, codeberg.org/owner/repo, or sourceforge.net/p/project"
                foreground: root.foreground
                onAccepted: root.addRepo()
              }

              Button {
                id: addButton
                anchors.verticalCenter: repoField.verticalCenter
                text: "Add"
                foreground: root.foreground
                accent: Color.accent
                fontFamily: root.fontFamily
                onClicked: root.addRepo()
              }
            }

            Text {
              visible: root.errorText !== ""
              width: parent.width
              text: root.errorText
              color: root.bar ? root.bar.urgent : Color.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // Watched repositories.
            Column {
              visible: root.repos.length > 0
              width: parent.width
              spacing: Style.space(4)

              PanelSectionHeader {
                text: "WATCHED REPOSITORIES"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Repeater {
                model: root.repos

                Item {
                  required property var modelData
                  width: parent ? parent.width : implicitWidth
                  height: Math.max(repoLabel.implicitHeight, Style.space(34))

                  Text {
                    id: repoLabel
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: modelData
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    width: Math.max(0, parent.width - removeBtn.width - openBtn.width - Style.space(16))
                  }

                  PanelActionButton {
                    id: openBtn
                    anchors.right: removeBtn.left
                    anchors.rightMargin: Style.space(2)
                    anchors.verticalCenter: parent.verticalCenter
                    iconText: "\uf08e"
                    tooltipText: "Open in browser"
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    onClicked: root.openRepo(modelData)
                  }

                  PanelActionButton {
                    id: removeBtn
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    iconText: "\uf1f8"
                    tooltipText: "Stop watching"
                    foreground: root.foreground
                    hoverColor: root.bar ? root.bar.urgent : Color.urgent
                    fontFamily: root.fontFamily
                    onClicked: {
                      if (root.selectedRepo === modelData) root.selectedRepo = ""
                      if (root.service) root.service.removeRepo(modelData)
                    }
                  }
                }
              }
            }

            PanelSeparator {
              visible: root.repos.length > 0
              foreground: root.foreground
            }

            // Activity feed.
            Column {
              width: parent.width
              spacing: Style.space(4)

              PanelSectionHeader {
                text: "ACTIVITY"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              // Repo tabs: "All" plus one tab per watched repository, so
              // activity can be read one repository at a time instead of one
              // long list. Each repository also carries a stable color dot.
              Flickable {
                width: parent.width
                height: tabRow.implicitHeight
                contentWidth: tabRow.implicitWidth
                contentHeight: tabRow.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                interactive: tabRow.implicitWidth > width
                visible: root.repos.length > 0

                Row {
                  id: tabRow
                  spacing: Style.space(6)

                  Repeater {
                    model: root.tabs

                    Button {
                      required property var modelData
                      text: modelData === "" ? "All" : Model.repoLabel(modelData)
                      active: root.selectedRepo === modelData
                      foreground: root.foreground
                      accent: Color.accent
                      fontFamily: root.fontFamily
                      onClicked: root.selectedRepo = modelData
                    }
                  }
                }
              }

              Text {
                visible: !root.busy && root.grouped.length === 0
                width: parent.width
                text: root.repos.length === 0
                  ? "Add a repository above, then refresh to see its recent activity."
                  : "No activity found."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }

              Repeater {
                model: root.activeGroups

                Column {
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(2)

                  Row {
                    width: parent.width
                    spacing: Style.space(6)

                    Rectangle {
                      anchors.verticalCenter: parent.verticalCenter
                      width: 8
                      height: 8
                      radius: 4
                      color: root.repoColor(modelData.repo)
                    }

                    Text {
                      width: parent.width - Style.space(14)
                      text: modelData.repo
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      elide: Text.ElideRight
                    }
                  }

                  Repeater {
                    model: modelData.items
                    delegate: EventRow {
                      event: modelData
                      foreground: root.foreground
                      dim: root.dim
                      accent: Color.accent
                      fontFamily: root.fontFamily
                      activate: function(url) { root.openItem(url) }
                    }
                  }
                }
              }
            }
          }

          // ---- Settings view -------------------------------------------------
          Column {
            width: parent.width
            visible: root.view === "settings"
            spacing: Style.space(10)

            Button {
              text: "Done"
              foreground: root.foreground
              accent: Color.accent
              fontFamily: root.fontFamily
              onClicked: root.commitSettings()
            }

            PanelSectionHeader {
              text: "ACCESS TOKEN (OPTIONAL)"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            TextField {
              id: tokenField
              width: parent.width
              password: true
              placeholderText: "ghp_..."
              foreground: root.foreground
              onEditingFinished: {
                if (root.service) root.service.updatePrefs({ token: tokenField.text })
              }
            }

            Text {
              width: parent.width
              text: "Without a token GitHub allows 60 requests/hour; with one it allows 5000. Discussions are GitHub-only and require a token. Create one at github.com/settings/tokens (read-only public access is enough)."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSeparator { foreground: root.foreground }

            Toggle {
              width: parent.width
              label: "Notify on new activity"
              description: "Send a desktop notification when a watched repository has new commits, issues, discussions, or releases."
              checked: root.service ? root.service.config.notify : true
              foreground: root.foreground
              accent: Color.accent
              fontFamily: root.fontFamily
              onClicked: { if (root.service) root.service.updatePrefs({ notify: !root.service.config.notify }) }
            }

            Toggle {
              width: parent.width
              label: "Check automatically"
              description: "Poll once at startup and then at the interval below. Turn off to refresh only manually."
              checked: root.service ? root.service.config.autoRefresh : true
              foreground: root.foreground
              accent: Color.accent
              fontFamily: root.fontFamily
              onClicked: { if (root.service) root.service.updatePrefs({ autoRefresh: !root.service.config.autoRefresh }) }
            }

            Row {
              width: parent.width
              spacing: Style.space(12)

              NumberField {
                label: "Check every (hours)"
                value: root.service ? root.service.config.refreshHours : 24
                from: 1
                to: 168
                stepSize: 1
                foreground: root.foreground
                accent: Color.accent
                fontFamily: root.fontFamily
                onModified: function(value) { if (root.service) root.service.updatePrefs({ refreshHours: value }) }
              }

              NumberField {
                label: "Max items per repository"
                value: root.service ? root.service.config.maxEvents : 50
                from: 1
                to: 100
                stepSize: 5
                foreground: root.foreground
                accent: Color.accent
                fontFamily: root.fontFamily
                onModified: function(value) { if (root.service) root.service.updatePrefs({ maxEvents: value }) }
              }
            }
          }
        }
      }
    }
  }

  // One activity row: kind label + title, with author/time beneath and an
  // accent dot for anything new since the panel was last open.
  component EventRow: Item {
    id: row
    property var event: ({})
    property color foreground: Color.foreground
    property color dim: Qt.darker(foreground, 1.5)
    property color accent: Color.accent
    property string fontFamily: Style.font.family
    property var activate: function(url) {}

    width: parent ? parent.width : implicitWidth
    height: Math.max(Style.space(44), title.implicitHeight + sub.implicitHeight + Style.space(8))

    readonly property bool isNew: event.isNew === true
    readonly property string kindLabel: Model.kindLabel(event.kind)
    readonly property string subText: {
      var parts = []
      if (kindLabel !== "") parts.push(kindLabel)
      if (event.author !== "") parts.push(event.author)
      var rel = Model.relativeTime(event.epoch, root.now.getTime())
      if (rel !== "") parts.push(rel)
      return parts.join(" \u00b7 ")
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: row.activate(event.url)
    }

    Rectangle {
      id: dot
      x: Style.space(2)
      anchors.verticalCenter: parent.verticalCenter
      width: 6
      height: 6
      radius: 3
      visible: row.isNew
      color: row.accent
    }

    Column {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(16)
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: 1

      Text {
        id: title
        width: parent.width
        text: event.title
        color: row.foreground
        font.family: row.fontFamily
        font.pixelSize: Style.font.body
        font.bold: row.isNew
        elide: Text.ElideRight
      }

      Text {
        id: sub
        width: parent.width
        text: row.subText
        color: row.dim
        font.family: row.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }
  }
}
