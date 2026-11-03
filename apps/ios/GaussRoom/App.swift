import SwiftUI
import ARKit
import RealityKit
import SceneKit
import WebKit
import UniformTypeIdentifiers

@main struct GaussRoomApp: App {
    @Environment(\.scenePhase) private var phase
    @StateObject private var capture = ScanCapture()
    var body: some Scene { WindowGroup { ContentView(capture: capture).onChange(of: phase) { _, value in if value != .active { capture.pause() } } } }
}
struct LiveView: UIViewRepresentable {
    let session: ARSession
    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        view.session = session
        view.debugOptions.insert(.showSceneUnderstanding)
        return view
    }
    func updateUIView(_ view: ARView, context: Context) {}
}
struct ContentView: View {
    @ObservedObject var capture: ScanCapture
    @State private var scans: [URL] = []
    @State private var error = ""
    var body: some View {
        NavigationStack {
            VStack {
                LiveView(session: capture.session).frame(height: 280)
                Text("\(capture.state) · \(capture.count) 帧")
                HStack {
                    Button("开始扫描") { do { try capture.start(); refresh() } catch { self.error = error.localizedDescription } }.disabled(capture.isScanning)
                    if capture.isPaused { Button("继续") { capture.resume() } }
                    else { Button("暂停") { capture.pause() }.disabled(!capture.isScanning) }
                    Button("停止并保存") { capture.stop(); refresh() }.disabled(!capture.isScanning)
                }
                List(scans, id: \.self) { scan in NavigationLink(scan.lastPathComponent) { ScanDetail(scan: scan) }.disabled(capture.isScanning) }
                NavigationLink("连接电脑") { ConnectionView() }
                if !error.isEmpty { Text(error).foregroundStyle(.red) }
            }.navigationTitle("GaussRoom").onAppear(perform: refresh)
        }
    }
    private func refresh() {
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Scans")
        scans = ((try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []).sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
}
struct MeshView: UIViewRepresentable {
    let mesh: Mesh
    let preview: URL?
    var tapped: (SIMD3<Float>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(tapped: tapped) }
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.allowsCameraControl = true; view.autoenablesDefaultLighting = true; view.backgroundColor = .black
        view.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:))))
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) {
        context.coordinator.tapped = tapped
        if let preview, let scene = try? SCNScene(url: preview.appendingPathComponent("model.obj"), options: nil) { view.scene = scene; return }
        let vertices = mesh.vertices.filter { $0.count == 3 }.map { SCNVector3($0[0],$0[1],$0[2]) }
        let indices = mesh.faces.filter { $0.count == 3 && $0.allSatisfy { $0 >= 0 && $0 < vertices.count } }.flatMap { $0.map { UInt32($0) } }
        let source = SCNGeometrySource(vertices: vertices), element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let geometry = SCNGeometry(sources: [source], elements: [element]); geometry.firstMaterial?.diffuse.contents = UIColor.systemTeal; geometry.firstMaterial?.isDoubleSided = true
        let scene = SCNScene(); scene.rootNode.addChildNode(SCNNode(geometry: geometry)); view.scene = scene
    }
    final class Coordinator: NSObject {
        var tapped: (SIMD3<Float>) -> Void
        init(tapped: @escaping (SIMD3<Float>) -> Void) { self.tapped = tapped }
        @objc func tap(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view as? SCNView, let hit = view.hitTest(gesture.location(in: view)).first else { return }
            let p = hit.worldCoordinates; tapped(SIMD3(p.x,p.y,p.z))
        }
    }
}
struct ScanDetail: View {
    let scan: URL
    @State private var original = Mesh(vertices: [], normals: [], faces: [])
    @State private var edits = Edits(crop: nil)
    @State private var first: SIMD3<Float>?
    @State private var minText = "", maxText = "", message = ""
    @State private var output: URL?
    @State private var preview: URL?
    @State private var working = false
    private var display: Mesh { if let c = edits.crop { return Geometry.cropped(original, min: c.min, max: c.max) }; return original }
    var body: some View {
        ScrollView {
            VStack {
                MeshView(mesh: display, preview: preview) { point in
                    if let first { edits.measurements.append(Measurement(start: [first.x,first.y,first.z], end: [point.x,point.y,point.z])); self.first = nil; save() } else { first = point }
                }.frame(height: 350).allowsHitTesting(!working)
                Text("点选两处测距（米，估算）")
                ForEach(Array(edits.measurements.enumerated()), id: \.offset) { _, m in Text(String(format: "%.3f 米", Geometry.distance(m.start,m.end))) }
                HStack { TextField("最小 x,y,z", text: $minText); TextField("最大 x,y,z", text: $maxText) }.textFieldStyle(.roundedBorder).disabled(working)
                HStack {
                    Button("裁剪") { if let a = parse(minText), let b = parse(maxText), zip(a,b).allSatisfy({ $0.0 <= $0.1 }) { edits.crop = Crop(min:a,max:b); save() } else { message = "请输入有效范围" } }
                    Button("撤销裁剪") { edits.crop = nil; save() }
                    Button("清除测量") { edits.measurements = []; first = nil; save() }
                }.disabled(working)
                Button("生成彩色模型并导出 OBJ") { exportOBJ() }.disabled(working)
                Button("导出完整扫描包") { exportScan() }.disabled(working)
                if let output { ShareLink(item: output) { Text("分享导出文件") } }
                Text(message).foregroundStyle(.secondary)
            }.padding()
        }.navigationTitle("查看扫描").onAppear(perform: load)
    }
    private func parse(_ text: String) -> [Float]? { let values = text.split(separator:",").compactMap { Float($0.trimmingCharacters(in: .whitespaces)) }; return values.count == 3 && values.allSatisfy(\.isFinite) ? values : nil }
    private func load() {
        do { original = try JSONDecoder().decode(Mesh.self, from: Data(contentsOf: scan.appendingPathComponent("mesh.json"))); edits = (try? JSONDecoder().decode(Edits.self, from: Data(contentsOf: scan.appendingPathComponent("edits.json")))) ?? Edits(crop:nil) } catch { message = "读取失败：\(error.localizedDescription)" }
    }
    private func save() { preview = nil; output = nil; do { try JSONEncoder().encode(edits).write(to: scan.appendingPathComponent("edits.json"), options: .atomic) } catch { message = "保存失败：\(error.localizedDescription)" } }
    private func exportOBJ() {
        let mesh = display, scanURL = scan
        let temp = FileManager.default.temporaryDirectory
        let result = temp.appendingPathComponent(UUID().uuidString + ".zip")
        let model = temp.appendingPathComponent(UUID().uuidString, isDirectory: true)
        working = true; message = "正在生成彩色模型"
        Task {
            do {
                try await Task.detached { try OBJExporter.export(scan: scanURL, mesh: mesh, destination: result, previewDirectory: model) }.value
                output = result; preview = model; message = "已生成彩色模型"; working = false
            } catch { message = "导出失败：\(error.localizedDescription)"; working = false }
        }
    }
    private func exportScan() {
        do { let url = FileManager.default.temporaryDirectory.appendingPathComponent(scan.lastPathComponent + ".gaussroom.zip"); let metadata = try JSONDecoder().decode(ScanMetadata.self, from: Data(contentsOf: scan.appendingPathComponent("capture-metadata.json"))); try PackageIO.makeArchive(scan: scan, scanId: scan.lastPathComponent, sessionId: metadata.sessionId, createdAt: metadata.createdAt, model: "iPhone", systemVersion: UIDevice.current.systemVersion, destination: url); output = url; message = "已生成扫描包" } catch { message = "导出失败：\(error.localizedDescription)" }
    }
}
struct ScanMetadata: Codable { let sessionId: String; let createdAt: Date }
struct ConnectionView: View {
    @State private var address = "http://", code = "", projectId = "", message = ""
    @State private var client: MobileClient?
    @State private var viewer: URLRequest?
    @State private var summary: ProjectSummary?
    @State private var pollVersion = 0
    @State private var showingPicker = false
    var body: some View {
        Form {
            TextField("电脑地址，例如 http://192.168.1.2:8124", text: $address).textInputAutocapitalization(.never).keyboardType(.URL)
            TextField("配对码", text: $code)
            Button("配对") { Task { await pair() } }
            Button("选择扫描包并上传") { showingPicker = true }.disabled(client == nil)
            TextField("项目 ID", text: $projectId).textInputAutocapitalization(.never)
            Button("开始增强") { Task { do { try await client?.run(projectId); message = "已启动"; pollVersion += 1 } catch { message = "启动失败：\(error.localizedDescription)" } } }.disabled(client == nil)
            Button("刷新项目并查看") { Task { await openViewer() } }.disabled(client == nil)
            Text(message)
            if let summary, summary.id == projectId {
                Section("项目进度") {
                    Text("\(summary.name) · \(statusText(summary.state))")
                    ProgressView(value: min(1, max(0, summary.progress)))
                    Text("总耗时：\(timeText(summary.timing))")
                    ForEach(summary.steps) { step in
                        VStack(alignment: .leading) {
                            Text("\(step.name) · \(statusText(step.status))")
                            Text("\(Int(step.progress * 100))% · \(timeText(step.timing))").font(.caption)
                        }
                    }
                    if let quality = summary.quality {
                        Text("几何：\(statusText(quality.geometry)) · 覆盖：\(statusText(quality.coverage))")
                        Text("外观：\(statusText(quality.appearance)) · 尺度：\(statusText(quality.scale))")
                        Text(quality.trainingComplete ? "训练已完成" : "训练未完成")
                    }
                    if let error = summary.lastError { Text(error).foregroundStyle(.red) }
                }
            }
            if let viewer { OnlineView(request: viewer).frame(height: 400) }
        }.navigationTitle("连接电脑")
        .task(id: projectId + "|" + String(pollVersion)) { await pollProject() }
        .fileImporter(isPresented: $showingPicker, allowedContentTypes: [.zip]) { result in
            Task {
                do { let url = try result.get(); guard url.startAccessingSecurityScopedResource() else { message = "无法读取文件"; return }; defer { url.stopAccessingSecurityScopedResource() }
                    let scanId = try scanIdFromArchiveName(url)
                    let scan = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Scans").appendingPathComponent(scanId)
                    try PackageIO.validateScan(scan)
                    guard let client else { return }; projectId = try await client.upload(file:url, scanId:scanId); message = "上传完成"; pollVersion += 1
                } catch { message = "上传失败：\(error.localizedDescription)" }
            }
        }
    }
    // Full scan archives are exported with the scan UUID as their filename.
    private func scanIdFromArchiveName(_ url: URL) throws -> String {
        let name = url.lastPathComponent.replacingOccurrences(of: ".gaussroom.zip", with: "")
        guard UUID(uuidString: name) != nil else { throw MobileClient.Failure.invalidURL }; return name
    }
    private func pair() async {
        guard let url = URL(string: address), ["http","https"].contains(url.scheme ?? ""), url.host != nil else { message = "地址无效"; return }
        let instance = MobileClient(base:url, token:TokenStore.load(for:url.absoluteString) ?? "")
        do { if !code.isEmpty { _ = try await instance.pair(code:code, deviceName:UIDevice.current.name) }; client = instance; message = "已连接"; pollVersion += 1 } catch { message = "配对失败：\(error.localizedDescription)" }
    }
    private func statusText(_ value: String) -> String {
        switch value {
        case "running": return "运行中"
        case "aborting": return "正在停止"
        case "done", "success", "passed", "verified", "reviewed", "calibrated": return "已完成"
        case "pending", "unverified", "unreviewed", "unmeasured": return "待处理"
        case "failed": return "失败"
        case "blocked", "needs_input": return "需要处理"
        case "aborted": return "已停止"
        case "partial", "missing", "needs_improvement": return "未完成"
        default: return value
        }
    }
    private func timeText(_ timing: ProjectSummary.Timing?) -> String {
        guard let timing, let ms = timing.elapsedMs else { return "无记录" }
        let seconds = Int(ms / 1000)
        return "\(seconds / 60) 分 \(seconds % 60) 秒" + (timing.complete ? "" : "（记录不完整）")
    }
    private func pollProject() async {
        guard let client, !projectId.isEmpty else { return }
        let id = projectId
        while !Task.isCancelled {
            do {
                let result = try await client.project(id)
                guard !Task.isCancelled else { return }
                summary = result
                guard result.state == "running" || result.state == "aborting" else { return }
                try await Task.sleep(nanoseconds: 2_000_000_000)
            } catch {
                guard !Task.isCancelled else { return }
                message = "读取失败：\(error.localizedDescription)"
                guard let summary, summary.id == id, summary.state == "running" || summary.state == "aborting" else { return }
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            }
        }
    }
    private func openViewer() async {
        guard let client else { return }
        do { let project = try await client.project(projectId); summary = project; message = "状态：\(project.state)"; if let scene = project.scene { viewer = try await client.viewerRequest(scene.viewerUrl, store: WKWebsiteDataStore.default().httpCookieStore) } } catch { message = "读取失败：\(error.localizedDescription)" }
    }
}
struct OnlineView: UIViewRepresentable {
    let request: URLRequest
    func makeUIView(context: Context) -> WKWebView { let config = WKWebViewConfiguration(); config.websiteDataStore = .default(); let v = WKWebView(frame:.zero, configuration:config); v.load(request); return v }
    func updateUIView(_ view: WKWebView, context: Context) { if view.url != request.url { view.load(request) } }
}
