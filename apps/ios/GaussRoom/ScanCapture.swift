import Foundation
import Combine
import ARKit
import UIKit
import CoreImage
import simd

// Delegate-owned admission and one serial writer keep at most one frame packet in flight.
final class ScanCapture: NSObject, ObservableObject, ARSessionDelegate {
    @Published var state = "未开始"
    @Published var count = 0
    @Published var isScanning = false
    @Published var isPaused = false
    let session = ARSession()
    private let queue = DispatchQueue(label: "GaussRoom.capture")
    private let writer = DispatchQueue(label: "GaussRoom.writer")
    private let context = CIContext()
    private let fm = FileManager.default
    private var root: URL?
    private var frames: [[String: Any]] = [] // writer queue only
    private var anchors: [UUID: ARMeshAnchor] = [:] // delegate queue only
    private var gate = FrameAdmission()
    private var active = false, draining = false, paused = false
    private var drainFinal = false
    private var drainReason = ""
    private var nextID = 1
    private var lastTimestamp: TimeInterval = -.infinity
    private var lastPose: simd_float4x4?
    private var configuration: ARWorldTrackingConfiguration?
    private struct Packet {
        let image: CVPixelBuffer, depth: Data, confidence: Data
        let imageWidth: Int, imageHeight: Int, depthWidth: Int, depthHeight: Int, confidenceWidth: Int, confidenceHeight: Int
        let timestamp: TimeInterval, intrinsics: [Float], transform: [Float], id: String
        let anchors: [ARMeshAnchor]
    }
    override init() {
        super.init(); session.delegate = self; session.delegateQueue = queue
        NotificationCenter.default.addObserver(self, selector: #selector(thermalChanged), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func thermalChanged() {
        guard ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical else { return }
        queue.async { self.beginDrain(final: false, reason: "设备温度过高，已暂停") }
    }
    func start() throws {
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh), ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else { throw CaptureError.unsupported }
        guard ProcessInfo.processInfo.thermalState != .serious, ProcessInfo.processInfo.thermalState != .critical else { throw CaptureError.thermal }
        guard queue.sync(execute: { !active && !draining }) else { throw CaptureError.alreadyActive }
        let id = UUID().uuidString
        let directory = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Scans/" + id, isDirectory: true)
        for name in ["images", "depth", "confidence"] { try fm.createDirectory(at: directory.appendingPathComponent(name), withIntermediateDirectories: true) }
        try durableWrite(JSONEncoder().encode(Mesh(vertices: [], normals: [], faces: [])), to: directory.appendingPathComponent("mesh.json"))
        try durableWrite(JSONEncoder().encode(Edits(crop: nil)), to: directory.appendingPathComponent("edits.json"))
        try writeJSON(["frames": []], to: directory.appendingPathComponent("frames.json"))
        try durableWrite(JSONEncoder().encode(ScanMetadata(sessionId: UUID().uuidString, createdAt: Date())), to: directory.appendingPathComponent("capture-metadata.json"))
        let config = ARWorldTrackingConfiguration(); config.sceneReconstruction = .mesh; config.frameSemantics.insert(.sceneDepth)
        queue.sync {
            root = directory; frames = []; anchors = [:]; lastTimestamp = -.infinity; lastPose = nil; nextID = 1
            active = true; paused = false; draining = false; gate = FrameAdmission(); configuration = config
        }
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        DispatchQueue.main.async { self.state = "扫描中"; self.count = 0; self.isScanning = true; self.isPaused = false }
    }
    func pause() { queue.async { self.beginDrain(final: false, reason: "已暂停") } }
    func stop() { queue.async { self.beginDrain(final: true, reason: "已停止") } }
    func resume() {
        queue.async {
            guard self.active, self.paused, !self.draining, let config = self.configuration else { return }
            guard ProcessInfo.processInfo.thermalState != .serious, ProcessInfo.processInfo.thermalState != .critical else {
                DispatchQueue.main.async { self.state = "设备温度过高，无法继续" }; return
            }
            self.paused = false; self.gate.resume()
            // No resetTracking or removeExistingAnchors: retain this session's world origin.
            self.session.run(config, options: [])
            DispatchQueue.main.async { self.state = "扫描中"; self.isPaused = false }
        }
    }
    func sessionWasInterrupted(_ session: ARSession) { beginDrain(final: true, reason: "扫描中断，已保存") }
    func session(_ session: ARSession, didFailWithError error: Error) { beginDrain(final: true, reason: "扫描结束：\(error.localizedDescription)") }
    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { update(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { update(anchors) }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) { guard active, !paused else { return }; for anchor in anchors { self.anchors.removeValue(forKey: anchor.identifier) } }
    private func update(_ anchors: [ARAnchor]) { guard active, !paused else { return }; for case let mesh as ARMeshAnchor in anchors { self.anchors[mesh.identifier] = mesh } }
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard active, !draining, !paused, frame.timestamp > lastTimestamp + 1, let sceneDepth = frame.sceneDepth, let confidence = sceneDepth.confidenceMap, let root else { return }
        guard case .normal = frame.camera.trackingState else { return }
        if let lastPose, !Geometry.isKeyframe(frame.camera.transform, after: lastPose) { return }
        guard gate.admit(trackingNormal: true) else { return }
        do {
            let image = try copyImage(frame.capturedImage)
            let d = try copy(sceneDepth.depthMap, pixelBytes: 4), c = try copy(confidence, pixelBytes: 1)
            let k = frame.camera.intrinsics, t = frame.camera.transform
            let packet = Packet(image: image, depth: d, confidence: c,
                imageWidth: CVPixelBufferGetWidth(image), imageHeight: CVPixelBufferGetHeight(image),
                depthWidth: CVPixelBufferGetWidth(sceneDepth.depthMap), depthHeight: CVPixelBufferGetHeight(sceneDepth.depthMap),
                confidenceWidth: CVPixelBufferGetWidth(confidence), confidenceHeight: CVPixelBufferGetHeight(confidence),
                timestamp: frame.timestamp, intrinsics: [k.columns.0,k.columns.1,k.columns.2].flatMap { [$0.x,$0.y,$0.z] },
                transform: [t.columns.0,t.columns.1,t.columns.2,t.columns.3].flatMap { [$0.x,$0.y,$0.z,$0.w] },
                id: String(format: "f%06d", nextID), anchors: Array(anchors.values))
            lastTimestamp = frame.timestamp; lastPose = t
            writer.async {
                do {
                    try self.write(packet, root: root)
                    self.queue.async {
                        self.gate.finished(); self.nextID += 1
                        let saved = self.nextID - 1
                        DispatchQueue.main.async { self.count = saved }
                    }
                } catch {
                    self.queue.async {
                        self.gate.finished()
                        self.beginDrain(final: false, reason: "保存失败，已暂停：\(error.localizedDescription)")
                    }
                }
            }
        } catch {
            gate.finished(); beginDrain(final: false, reason: "复制失败，已暂停：\(error.localizedDescription)")
        }
    }
    private func write(_ packet: Packet, root: URL) throws {
        let capacity = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
        if let capacity, capacity < 512 * 1024 * 1024 { throw CaptureError.storage }
        let image = CIImage(cvPixelBuffer: packet.image)
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]) else { throw CaptureError.image }
        let ip = "images/\(packet.id).jpg", dp = "depth/\(packet.id).bin", cp = "confidence/\(packet.id).bin"
        try durableWrite(jpeg, to: root.appendingPathComponent(ip)); try durableWrite(packet.depth, to: root.appendingPathComponent(dp)); try durableWrite(packet.confidence, to: root.appendingPathComponent(cp))
        let entry: [String:Any] = ["id":packet.id,"timestamp":packet.timestamp,"image":["path":ip,"width":packet.imageWidth,"height":packet.imageHeight],"intrinsics":packet.intrinsics,"cameraToWorld":packet.transform,"depth":["path":dp,"width":packet.depthWidth,"height":packet.depthHeight,"format":"float32_le"],"confidence":["path":cp,"width":packet.confidenceWidth,"height":packet.confidenceHeight,"format":"uint8"]]
        let updated = frames + [entry]
        try durableWrite(JSONEncoder().encode(snapshotMesh(packet.anchors)), to: root.appendingPathComponent("mesh.json"))
        try writeJSON(["frames":updated], to: root.appendingPathComponent("frames.json"))
        frames = updated // Only advertise after all writes and index persistence succeed.
    }
    // Called on delegate queue. Writer sends completions asynchronously; neither queue waits for the other.
    private func beginDrain(final: Bool, reason: String) {
        guard active, let root else { return }
        if draining {
            if final { drainFinal = true; drainReason = reason }
            else if reason.contains("失败") { drainReason = reason }
            return
        }
        if paused && !final { return }
        drainFinal = final; drainReason = reason
        gate.pause(); paused = true; draining = true; session.pause()
        let snapshot = Array(anchors.values)
        DispatchQueue.main.async { self.state = "正在保存" }
        writer.async {
            var result = reason
            do { try self.durableWrite(JSONEncoder().encode(self.snapshotMesh(snapshot)), to: root.appendingPathComponent("mesh.json")) }
            catch { result = "保存失败：\(error.localizedDescription)" }
            self.queue.async {
                self.draining = false
                let finished = self.drainFinal
                let message = result == reason ? self.drainReason : result
                if finished { self.active = false; self.configuration = nil }
                DispatchQueue.main.async { self.state = message; self.isScanning = !finished; self.isPaused = !finished }
            }
        }
    }
    private func copyImage(_ source: CVPixelBuffer) throws -> CVPixelBuffer {
        var output: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, CVPixelBufferGetWidth(source), CVPixelBufferGetHeight(source), CVPixelBufferGetPixelFormatType(source), nil, &output) == kCVReturnSuccess, let target = output else { throw CaptureError.image }
        CVPixelBufferLockBaseAddress(source, .readOnly); defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
        CVPixelBufferLockBaseAddress(target, []); defer { CVPixelBufferUnlockBaseAddress(target, []) }
        let planes = CVPixelBufferGetPlaneCount(source)
        if planes == 0 {
            guard let src = CVPixelBufferGetBaseAddress(source), let dst = CVPixelBufferGetBaseAddress(target) else { throw CaptureError.image }
            let a = CVPixelBufferGetBytesPerRow(source), b = CVPixelBufferGetBytesPerRow(target)
            for row in 0..<CVPixelBufferGetHeight(source) { memcpy(dst.advanced(by: row*b), src.advanced(by: row*a), min(a,b)) }
        } else {
            guard CVPixelBufferGetPlaneCount(target) == planes else { throw CaptureError.image }
            for plane in 0..<planes {
                guard let src = CVPixelBufferGetBaseAddressOfPlane(source, plane), let dst = CVPixelBufferGetBaseAddressOfPlane(target, plane) else { throw CaptureError.image }
                let a = CVPixelBufferGetBytesPerRowOfPlane(source, plane), b = CVPixelBufferGetBytesPerRowOfPlane(target, plane)
                for row in 0..<CVPixelBufferGetHeightOfPlane(source, plane) { memcpy(dst.advanced(by: row*b), src.advanced(by: row*a), min(a,b)) }
            }
        }
        CVBufferPropagateAttachments(source, target); return target
    }
    private func copy(_ pixel: CVPixelBuffer, pixelBytes: Int) throws -> Data {
        CVPixelBufferLockBaseAddress(pixel, .readOnly); defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixel) else { throw CaptureError.image }
        let stride = CVPixelBufferGetBytesPerRow(pixel), height = CVPixelBufferGetHeight(pixel), width = CVPixelBufferGetWidth(pixel)
        return try Geometry.packedRows(Data(bytes: base, count: stride * height), rowBytes: stride, widthBytes: width * pixelBytes, height: height)
    }
    private func snapshotMesh(_ anchors: [ARMeshAnchor]) -> Mesh {
        var vertices: [[Float]] = [], normals: [[Float]] = [], faces: [[Int]] = []
        for anchor in anchors {
            let g = anchor.geometry, offset = vertices.count
            for i in 0..<g.vertices.count {
                let p = vector(g.vertices, i), n = vector(g.normals, i), world = Geometry.transform(p, by: anchor.transform)
                let normal = anchor.transform * SIMD4<Float>(n.x,n.y,n.z,0)
                vertices.append([world.x,world.y,world.z]); normals.append([normal.x,normal.y,normal.z])
            }
            let f = g.faces
            for i in 0..<f.count {
                let ptr = f.buffer.contents().advanced(by: i * f.indexCountPerPrimitive * f.bytesPerIndex)
                var face: [Int] = []
                for j in 0..<f.indexCountPerPrimitive { let p = ptr.advanced(by: j * f.bytesPerIndex); face.append(offset + (f.bytesPerIndex == 2 ? Int(p.loadUnaligned(as: UInt16.self)) : Int(p.loadUnaligned(as: UInt32.self)))) }
                if face.count == 3 { faces.append(face) }
            }
        }
        return Mesh(vertices: vertices, normals: normals, faces: faces)
    }
    private func vector(_ source: ARGeometrySource, _ i: Int) -> SIMD3<Float> {
        let p = source.buffer.contents().advanced(by: source.offset + source.stride * i)
        return SIMD3<Float>(p.loadUnaligned(fromByteOffset: 0, as: Float.self),p.loadUnaligned(fromByteOffset: 4, as: Float.self),p.loadUnaligned(fromByteOffset: 8, as: Float.self))
    }
    private func durableWrite(_ data: Data, to url: URL) throws { try data.write(to: url, options: .atomic); let file = try FileHandle(forWritingTo: url); defer { try? file.close() }; try file.synchronize() }
    private func writeJSON(_ value: Any, to url: URL) throws { try durableWrite(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), to: url) }
    enum CaptureError: LocalizedError {
        case unsupported, image, alreadyActive, storage, thermal
        var errorDescription: String? { switch self { case .unsupported: return "设备不支持 LiDAR 扫描"; case .image: return "无法读取图像"; case .alreadyActive: return "扫描尚未结束"; case .storage: return "存储空间不足"; case .thermal: return "设备温度过高" } }
    }
}
