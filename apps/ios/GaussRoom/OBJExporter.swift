import Foundation
import simd

private struct FrameList: Decodable { let frames: [TextureFrame] }
private struct TextureFrame: Decodable {
    struct Image: Decodable { let path: String; let width: Int; let height: Int }
    struct Depth: Decodable { let path: String; let width: Int; let height: Int }
    let image: Image; let depth: Depth; let confidence: Depth; let intrinsics: [Float]; let cameraToWorld: [Float]
}

// Each material uses one original image. A face is assigned only when its normal
// faces the camera and its vertices and interior samples agree with frame depth.
enum OBJExporter {
    enum Failure: Error { case invalidMesh, noTextures, zip }
    private struct Candidate { let frame: TextureFrame; let depth: Data; let confidence: Data; let inverse: simd_float4x4; let position: SIMD3<Float> }
    static func export(scan: URL, mesh: Mesh, destination: URL, previewDirectory: URL? = nil) throws {
        let fm = FileManager.default
        let frames = try JSONDecoder().decode(FrameList.self, from: Data(contentsOf: scan.appendingPathComponent("frames.json"))).frames
        let candidates: [Candidate] = frames.compactMap { frame in
            guard frame.cameraToWorld.count == 16, frame.intrinsics.count == 9, frame.depth.width > 0, frame.depth.height > 0,
                  let data = try? Data(contentsOf: scan.appendingPathComponent(frame.depth.path)), data.count == frame.depth.width * frame.depth.height * 4,
                  frame.confidence.width > 0, frame.confidence.height > 0, let confidence = try? Data(contentsOf: scan.appendingPathComponent(frame.confidence.path)), confidence.count == frame.confidence.width * frame.confidence.height else { return nil }
            let v = frame.cameraToWorld
            let m = simd_float4x4(columns: (SIMD4(v[0],v[1],v[2],v[3]), SIMD4(v[4],v[5],v[6],v[7]), SIMD4(v[8],v[9],v[10],v[11]), SIMD4(v[12],v[13],v[14],v[15])))
            return Candidate(frame: frame, depth: data, confidence: confidence, inverse: m.inverse, position: SIMD3(v[12],v[13],v[14]))
        }
        guard !mesh.faces.isEmpty else { throw Failure.invalidMesh }
        let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: temp, withIntermediateDirectories: true); defer { try? fm.removeItem(at: temp) }
        var obj = "mtllib model.mtl\n", mtl = "newmtl untextured\nKd 0.65 0.65 0.65\n", used = Set<Int>(), textureIndex = 1
        for v in mesh.vertices { guard v.count == 3 else { throw Failure.invalidMesh }; obj += "v \(v[0]) \(v[1]) \(v[2])\n" }
        for face in mesh.faces {
            guard face.count == 3, face.allSatisfy({ $0 >= 0 && $0 < mesh.vertices.count }) else { throw Failure.invalidMesh }
            let points = face.map { i -> SIMD3<Float> in let v = mesh.vertices[i]; return SIMD3(v[0],v[1],v[2]) }
            let normal = simd_cross(points[1]-points[0], points[2]-points[0]), centre = (points[0]+points[1]+points[2])/3
            guard simd_length_squared(normal) > 1e-12 else { continue }
            var best: (Int, [SIMD2<Float>], Float)?
            for (index,candidate) in candidates.enumerated() {
                let toCamera = candidate.position-centre
                guard simd_length_squared(toCamera) > 1e-12, simd_dot(normal,toCamera) > 0 else { continue }
                let samples = points + [centre, (points[0]+points[1])/2, (points[1]+points[2])/2, (points[2]+points[0])/2]
                var uv: [SIMD2<Float>] = [], valid = true
                for point in samples {
                    let camera = Geometry.transform(point, by: candidate.inverse)
                    guard let projection = Geometry.project(camera, intrinsics: candidate.frame.intrinsics, width: candidate.frame.image.width, height: candidate.frame.image.height) else { valid = false; break }
                    let x = min(Int(projection.x * Float(candidate.frame.depth.width)), candidate.frame.depth.width - 1)
                    let y = min(Int(projection.y * Float(candidate.frame.depth.height)), candidate.frame.depth.height - 1)
                    let cx = min(Int(projection.x * Float(candidate.frame.confidence.width)), candidate.frame.confidence.width - 1)
                    let cy = min(Int(projection.y * Float(candidate.frame.confidence.height)), candidate.frame.confidence.height - 1)
                    guard candidate.confidence[cy * candidate.frame.confidence.width + cx] > 0 else { valid = false; break }
                    let offset = (y * candidate.frame.depth.width + x) * 4
                    let bits: UInt32 = candidate.depth.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self) }
                    guard Geometry.depthVisible(projected: -camera.z, observed: Float(bitPattern: UInt32(littleEndian: bits))) else { valid = false; break }
                    uv.append(projection)
                }
                guard valid else { continue }
                let cameraDepths = points.map { -Geometry.transform($0, by: candidate.inverse).z }
                guard Geometry.triangleVisible(Array(uv.prefix(3)), depths: cameraDepths, width: candidate.frame.depth.width, height: candidate.frame.depth.height, depth: candidate.depth, confidence: candidate.confidence, confidenceWidth: candidate.frame.confidence.width, confidenceHeight: candidate.frame.confidence.height) else { continue }
                let score = simd_dot(simd_normalize(normal), simd_normalize(toCamera)) / max(simd_length_squared(toCamera), 0.01)
                if best == nil || score > best!.2 { best = (index, Array(uv.prefix(3)), score) }
            }
            guard let (index, uv, _) = best else {
                obj += "usemtl untextured\nf \(face[0]+1) \(face[1]+1) \(face[2]+1)\n"
                continue
            }
            used.insert(index)
            obj += "usemtl frame\(index)\n"
            for p in uv { obj += "vt \(p.x) \(1-p.y)\n" }
            obj += "f \(face[0]+1)/\(textureIndex) \(face[1]+1)/\(textureIndex+1) \(face[2]+1)/\(textureIndex+2)\n"; textureIndex += 3
        }

        for i in used.sorted() {
            let name = "frame\(i).jpg"
            try fm.copyItem(at: scan.appendingPathComponent(candidates[i].frame.image.path), to: temp.appendingPathComponent(name))
            mtl += "newmtl frame\(i)\nKd 1 1 1\nmap_Kd \(name)\n"
        }
        try Data(obj.utf8).write(to: temp.appendingPathComponent("model.obj")); try Data(mtl.utf8).write(to: temp.appendingPathComponent("model.mtl"))
        if let previewDirectory { try fm.copyItem(at: temp, to: previewDirectory) }
        var coordinationError: NSError?, operationError: Error?
        NSFileCoordinator().coordinate(readingItemAt: temp, options: .forUploading, error: &coordinationError) { url in do { try fm.copyItem(at: url, to: destination) } catch { operationError = error } }
        if let error = coordinationError ?? (operationError as NSError?) { throw error }
        guard fm.fileExists(atPath: destination.path) else { throw Failure.zip }
    }
}
