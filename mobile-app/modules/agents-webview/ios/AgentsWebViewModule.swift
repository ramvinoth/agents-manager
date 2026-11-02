import ExpoModulesCore
import WebKit

/// A WKWebView that loads a page from agents://app and hands every request the
/// page makes to JavaScript (onRequest), which answers it through the app's
/// transport (direct or the E2EE relay) with `respond`. The page's sockets are
/// bridged the same way: the injected shim posts to the "agents" message
/// handler (onMessage) and the app posts events back with `post`.
/// The logic lives in src/lib/webBridge.ts; this is only the native plumbing.
public class AgentsWebViewModule: Module {
  /// In-flight page requests by id, and the ones WebKit has since stopped
  /// (answering a stopped task raises an exception).
  static var tasks: [String: WKURLSchemeTask] = [:]
  static var stopped = Set<String>()
  /// Live views by their viewId prop, so module functions can reach one.
  static var views: [String: WeakView] = [:]

  struct WeakView { weak var view: AgentsWebView? }

  public func definition() -> ModuleDefinition {
    Name("AgentsWebView")

    AsyncFunction("respond") { (id: String, status: Int, headers: [String: String], body: Data) in
      guard let task = Self.take(id) else { return }
      let url = task.request.url ?? URL(string: "agents://app/")!
      guard let res = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
        task.didFailWithError(NSError(domain: "AgentsWebView", code: 1))
        return
      }
      task.didReceive(res)
      task.didReceive(body)
      task.didFinish()
    }.runOnQueue(.main)

    AsyncFunction("fail") { (id: String, message: String) in
      guard let task = Self.take(id) else { return }
      task.didFailWithError(NSError(domain: "AgentsWebView", code: 2, userInfo: [NSLocalizedDescriptionKey: message]))
    }.runOnQueue(.main)

    AsyncFunction("post") { (viewId: String, json: String) in
      // `json` is JSON.stringify output, so it is a valid JS expression.
      Self.views[viewId]?.view?.webView.evaluateJavaScript("window.__agentsWs && window.__agentsWs(\(json))")
    }.runOnQueue(.main)

    View(AgentsWebView.self) {
      Events("onRequest", "onMessage", "onOpenExternal", "onLoadError")

      Prop("viewId") { (view: AgentsWebView, value: String) in
        if !view.viewId.isEmpty { Self.views[view.viewId] = nil }
        view.viewId = value
        Self.views[value] = WeakView(view: view)
      }
      Prop("script") { (view: AgentsWebView, value: String) in
        view.script = value
      }
      Prop("url") { (view: AgentsWebView, value: String) in
        view.url = value
      }
      OnViewDidUpdateProps { view in
        view.applyProps()
      }
    }
  }

  /// The task for `id` if WebKit still wants an answer; forgets it either way.
  static func take(_ id: String) -> WKURLSchemeTask? {
    let task = tasks.removeValue(forKey: id)
    if stopped.remove(id) != nil { return nil }
    return task
  }
}

public class AgentsWebView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onRequest = EventDispatcher()
  let onMessage = EventDispatcher()
  let onOpenExternal = EventDispatcher()
  let onLoadError = EventDispatcher()

  let webView: WKWebView
  var viewId = ""
  var script = ""
  var url = ""
  private var installedScript = ""
  private var loadedUrl = ""
  /// Request ids this view started, so a torn-down view stops answering them.
  private var mine = Set<String>()

  required init(appContext: AppContext? = nil) {
    // WKWebView copies its configuration at init, so the scheme handler must be
    // registered before it exists — through a proxy, since `self` isn't yet.
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let schemes = SchemeProxy()
    config.setURLSchemeHandler(schemes, forURLScheme: "agents")
    webView = WKWebView(frame: .zero, configuration: config)
    super.init(appContext: appContext)
    schemes.view = self
    webView.configuration.userContentController.add(MessageProxy(self), name: "agents")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.isOpaque = false
    webView.backgroundColor = .clear
    addSubview(webView)
  }

  deinit {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "agents")
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  public override func removeFromSuperview() {
    super.removeFromSuperview()
    webView.stopLoading()
    for id in mine { AgentsWebViewModule.stopped.insert(id) }
    if AgentsWebViewModule.views[viewId]?.view === self { AgentsWebViewModule.views[viewId] = nil }
  }

  /// Install the shim (before the page's own scripts), then load the url —
  /// once, and again only when it changes.
  func applyProps() {
    if script != installedScript {
      let ucc = webView.configuration.userContentController
      ucc.removeAllUserScripts()
      if !script.isEmpty {
        ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
      }
      installedScript = script
    }
    if url != loadedUrl, let u = URL(string: url) {
      loadedUrl = url
      webView.load(URLRequest(url: u))
    }
  }

  // MARK: agents:// requests (via SchemeProxy)

  fileprivate func start(_ task: WKURLSchemeTask) {
    let id = UUID().uuidString
    AgentsWebViewModule.tasks[id] = task
    mine.insert(id)
    let req = task.request
    var path = req.url?.path ?? "/"
    if path.isEmpty { path = "/" }
    if let q = req.url?.query { path += "?" + q }
    let body = req.httpBody ?? req.httpBodyStream.map(Self.drain) ?? Data()
    onRequest([
      "id": id,
      "method": req.httpMethod ?? "GET",
      "path": path,
      "headers": req.allHTTPHeaderFields ?? [:],
      "body": body.base64EncodedString(),
    ])
  }

  fileprivate func stop(_ task: WKURLSchemeTask) {
    for (id, t) in AgentsWebViewModule.tasks where t === task {
      AgentsWebViewModule.stopped.insert(id)
    }
  }

  private static func drain(_ stream: InputStream) -> Data {
    var data = Data()
    stream.open()
    defer { stream.close() }
    var buf = [UInt8](repeating: 0, count: 65536)
    while stream.hasBytesAvailable {
      let n = stream.read(&buf, maxLength: buf.count)
      if n <= 0 { break }
      data.append(buf, count: n)
    }
    return data
  }

  // MARK: Navigation — the page stays on agents://app; anything else opens outside the app.

  public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let u = action.request.url else { return decisionHandler(.cancel) }
    if u.scheme == "agents" || u.absoluteString == "about:blank" || action.targetFrame?.isMainFrame == false {
      return decisionHandler(.allow)
    }
    onOpenExternal(["url": u.absoluteString])
    decisionHandler(.cancel)
  }

  public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = action.request.url { onOpenExternal(["url": u.absoluteString]) }
    return nil
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    onLoadError(["message": error.localizedDescription])
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    onLoadError(["message": "The canvas stopped unexpectedly."])
  }

  fileprivate func received(_ message: WKScriptMessage) {
    if let s = message.body as? String { onMessage(["data": s]) }
  }
}

/// WKWebView retains its scheme handlers; the proxy keeps that from retaining
/// the view. A request that arrives with the view gone is failed, not left hanging.
private class SchemeProxy: NSObject, WKURLSchemeHandler {
  weak var view: AgentsWebView?
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let view else { return task.didFailWithError(NSError(domain: "AgentsWebView", code: 3)) }
    view.start(task)
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    view?.stop(task)
  }
}

/// WKUserContentController retains its handlers; the proxy keeps that from
/// retaining the view.
private class MessageProxy: NSObject, WKScriptMessageHandler {
  weak var view: AgentsWebView?
  init(_ view: AgentsWebView) { self.view = view }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    view?.received(message)
  }
}
