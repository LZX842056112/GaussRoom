import Foundation
import CryptoKit
import Darwin

extension PackageIO {
    enum Error: LocalizedError {
        case invalidScan, coordinationFailed, insufficientFrames, invalidImagePath
        var errorDescription: String? {
            switch self {
            case .insufficientFrames: return "至少需要两张不同的关键帧。"
            case .invalidImagePath: return "扫描图片路径无效。"
            case .invalidScan: return "扫描数据无效。"
            case .coordinationFailed: return "无法生成压缩包。"
            }
        }
    }
    private struct FrameList: Decodable {
        struct Frame: Decodable { struct File: Decodable { let path: String }; let id: String; let timestamp: Double; let image: File; let depth: File; let confidence: File }
        let frames: [Frame]
    }
    static func validateFrames(_ frames: [(id: String, timestamp: Double, imagePath: String)]) throws {
        guard frames.count >= 2 else { throw Error.insufficientFrames }
        var ids = Set<String>(), paths = Set<String>(), previous = -Double.infinity
        for frame in frames {
            guard !frame.id.isEmpty, ids.insert(frame.id).inserted, frame.timestamp.isFinite, frame.timestamp > previous else { throw Error.insufficientFrames }
            let parts = frame.imagePath.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0] == "images", !parts[1].isEmpty, parts[1] != ".", parts[1] != "..", parts[1].lowercased().hasSuffix(".jpg"), paths.insert(frame.imagePath).inserted else { throw Error.invalidImagePath }
            previous = frame.timestamp
        }
    }
    static func validateScan(_ scan: URL) throws {
        let frameList = try JSONDecoder().decode(FrameList.self, from: Data(contentsOf: scan.appendingPathComponent("frames.json")))
        try validateFrames(frameList.frames.map { (id: $0.id, timestamp: $0.timestamp, imagePath: $0.image.path) })
        var hashes = Set<String>()
        for frame in frameList.frames {
            let data = try Data(contentsOf: scan.appendingPathComponent(frame.image.path), options: .mappedIfSafe)
            hashes.insert(sha256(data))
            if hashes.count >= 2 { break }
        }
        guard hashes.count >= 2 else { throw Error.insufficientFrames }
    }
    static func replaceExport(_ staged: URL, destination: URL) throws {
        guard rename(staged.path, destination.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    static func stageArchive(scan: URL, destination: URL) throws {
        let fm = FileManager.default
        let frames = try JSONDecoder().decode(FrameList.self, from: Data(contentsOf: scan.appendingPathComponent("frames.json"))).frames
        let paths = ["frames.json", "mesh.json", "edits.json"] + frames.flatMap { [$0.image.path, $0.depth.path, $0.confidence.path] }
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        for path in Set(paths) {
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains(":") }) else { throw Error.invalidScan }
            var source = scan
            for part in parts {
                source.appendPathComponent(String(part))
                guard try source.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw Error.invalidScan }
            }
            guard try source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw Error.invalidScan }
            let target = destination.appendingPathComponent(path)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: source, to: target)
        }
    }
    static func makeArchive(scan: URL, scanId: String, sessionId: String, createdAt: Date, model: String, systemVersion: String, destination: URL) throws {
        let fm = FileManager.default
        try validateScan(scan)
        guard UUID(uuidString: scanId) != nil, UUID(uuidString: sessionId) != nil else { throw Error.invalidScan }
        let temporary = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fm.removeItem(at: temporary) }
        try stageArchive(scan: scan, destination: temporary)
        let required = ["frames.json", "mesh.json", "edits.json"]
        guard required.allSatisfy({ fm.fileExists(atPath: temporary.appendingPathComponent($0).path) }) else { throw Error.invalidScan }
        guard let enumerator = fm.enumerator(at: temporary, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { throw Error.invalidScan }
        var entries: [[String:Any]] = []
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw Error.invalidScan }
            guard values.isRegularFile == true else { continue }
            let path = String(file.path.dropFirst(temporary.path.count + 1))
            guard path != "manifest.json", !path.isEmpty else { throw Error.invalidScan }
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            entries.append(["path":path,"bytes":data.count,"sha256":sha256(data)])
        }
        entries.sort { ($0["path"] as! String) < ($1["path"] as! String) }
        let manifest: [String:Any] = ["format":"gaussroom_scan_v1", "scanId":scanId, "createdAt":ISO8601DateFormatter().string(from:createdAt), "sessionId":sessionId, "device":["model":model,"systemVersion":systemVersion], "coordinateSystem":["handedness":"right","up":"y","units":"metres","cameraForward":"-z","matrixOrder":"column-major","imageOrientation":"sensor"], "frames":"frames.json", "mesh":"mesh.json", "edits":"edits.json", "files":entries]
        try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(to: temporary.appendingPathComponent("manifest.json"), options: .atomic)
        let staged = destination.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).zip")
        defer { try? fm.removeItem(at: staged) }
        var coordinationError: NSError?, operationError: Swift.Error?
        NSFileCoordinator().coordinate(readingItemAt: temporary, options: .forUploading, error: &coordinationError) { zip in
            do { try fm.copyItem(at: zip, to: staged) } catch { operationError = error }
        }
        if let error = coordinationError ?? (operationError as NSError?) { throw error }
        guard fm.fileExists(atPath: staged.path) else { throw Error.coordinationFailed }
        try replaceExport(staged, destination: destination)
    }
}
