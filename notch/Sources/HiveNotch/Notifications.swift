import AppKit
import UserNotifications

enum NoticeRoute: Equatable, Sendable {
    case notch
    case board(agentId: String?, taskId: String?)

    init(kind: NoticeKind, agentId: String?, taskId: String?) {
        switch kind {
        case .approval, .paused: self = .notch
        case .budget, .failed: self = .board(agentId: agentId, taskId: taskId)
        }
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let kind = (userInfo["kind"] as? String).flatMap(NoticeKind.init(rawValue:)) else { return nil }
        self.init(kind: kind, agentId: userInfo["agentId"] as? String, taskId: userInfo["taskId"] as? String)
    }
}

struct NoticeContent: Equatable {
    let title: String
    let body: String
    let userInfo: [String: String]

    init(_ notice: Notice) {
        title = switch notice.kind {
        case .approval: "Approval needed"
        case .budget: "Budget reached"
        case .failed: "Run failed"
        case .paused: "Hive is paused"
        }
        body = notice.text
        var info = ["kind": notice.kind.rawValue]
        info["agentId"] = notice.agentId
        info["taskId"] = notice.taskId
        userInfo = info
    }
}

/// Banners for the daemon's `notify` events. An unbundled dev build has no bundle identifier, and
/// UserNotifications refuses to run without one, so it posts nothing.
@MainActor
final class NoticeCenter: NSObject, UNUserNotificationCenterDelegate {
    private let open: (NoticeRoute) -> Void

    init(open: @escaping (NoticeRoute) -> Void) {
        self.open = open
    }

    private var available: Bool { Bundle.main.bundleIdentifier != nil }

    func start() {
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }

    func post(_ notice: Notice) {
        guard available else { return }
        let content = NoticeContent(notice)
        let banner = UNMutableNotificationContent()
        banner.title = content.title
        banner.body = content.body
        banner.userInfo = content.userInfo
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: banner, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let route = NoticeRoute(userInfo: response.notification.request.content.userInfo)
        completionHandler()
        guard let route else { return }
        Task { @MainActor in self.open(route) }
    }
}
