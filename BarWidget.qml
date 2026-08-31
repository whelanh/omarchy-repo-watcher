import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar entry point. Hosts Panel.qml and injects the service into it, mirroring
// the first-party clock/audio widgets: one manifest kind, panel loaded inside.
BarWidget {
  id: root
  moduleName: "io.github.whelanh.repo-watcher"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("io.github.whelanh.repo-watcher") : null

  function syncService() {
    if (root.service && "settings" in root.service) root.service.settings = root.settings
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.service
  }

  function refresh() {
    if (root.service && root.service.refresh) root.service.refresh()
  }

  function markAllRead() {
    if (root.service && root.service.markAllRead) root.service.markAllRead()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: { injectPanel(); syncService() }
  onSettingsChanged: { injectPanel(); syncService() }
  onServiceChanged: { injectPanel(); syncService() }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.whelanh.repo-watcher"

    function refresh(): void { root.refresh() }
    function markAllRead(): void { root.markAllRead() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  readonly property int unread: root.service ? root.service.unreadCount : 0

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf126"
    slotSize: Style.bar.statusSlot
    active: root.unread > 0
    tooltipText: {
      var s = root.service
      if (!s) return "Repo Watcher"
      if (s.busy) return "Repo Watcher \u00b7 checking\u2026"
      if (s.unreadCount > 0) return "Repo Watcher \u00b7 " + s.unreadCount + " new"
      return "Repo Watcher"
    }
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else if (b === Qt.RightButton) root.markAllRead()
      else root.toggle()
    }

    Rectangle {
      visible: root.unread > 0
      anchors.right: parent.right
      anchors.rightMargin: 1
      anchors.top: parent.top
      anchors.topMargin: 1
      width: Math.max(badgeLabel.implicitWidth + Style.space(8), Style.space(14))
      height: Style.space(14)
      radius: height / 2
      color: root.bar ? root.bar.urgent : Color.urgent

      Text {
        id: badgeLabel
        anchors.centerIn: parent
        text: Model.badgeText(root.unread)
        color: "white"
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
      }
    }
  }
}
