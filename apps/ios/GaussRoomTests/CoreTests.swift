import XCTest
import simd
@testable import GaussRoom

final class CoreTests: XCTestCase {
    func testColumnMajorTransformIncludesTranslation() {
        var m = matrix_identity_float4x4
        m.columns.3 = SIMD4<Float>(1, 2, 3, 1)
        XCTAssertEqual(Geometry.transform(SIMD3<Float>(2, 3, 4), by: m), SIMD3<Float>(3, 5, 7))
    }
    func testPaddedRowsAreCopiedWithoutPadding() throws {
        let source = Data([1,2,3,4,99,99,5,6,7,8,99,99])
        XCTAssertEqual(try Geometry.packedRows(source, rowBytes: 6, widthBytes: 4, height: 2), Data([1,2,3,4,5,6,7,8]))
        XCTAssertThrowsError(try Geometry.packedRows(source, rowBytes: 3, widthBytes: 4, height: 2))
    }
    func testCropKeepsOnlyWholeFacesAndPreservesOriginal() {
        let mesh = Mesh(vertices: [[0,0,0],[1,0,0],[0,1,0],[2,2,2]], normals: Array(repeating: [0,0,1], count: 4), faces: [[0,1,2],[0,1,3]])
        let result = Geometry.cropped(mesh, min: [-0.1,-0.1,-0.1], max: [1.1,1.1,0.1])
        XCTAssertEqual(result.faces, [[0,1,2]])
        XCTAssertEqual(mesh.faces.count, 2)
    }
    func testUVAndDepthVisibility() {
        let k: [Float] = [100,0,0,0,100,0,50,50,1]
        let p = Geometry.project(SIMD3<Float>(0,0,-2), intrinsics: k, width: 100, height: 100)
        XCTAssertEqual(p?.x ?? -1, 0.5, accuracy: 0.0001)
        XCTAssertEqual(p?.y ?? -1, 0.5, accuracy: 0.0001)
        XCTAssertTrue(Geometry.depthVisible(projected: 2, observed: 2.01))
        XCTAssertFalse(Geometry.depthVisible(projected: 2, observed: 1))
        XCTAssertNil(Geometry.project(SIMD3<Float>(0,0,1), intrinsics: k, width: 100, height: 100))
    }
    func testDistance() { XCTAssertEqual(Geometry.distance([0,0,0], [3,4,0]), 5, accuracy: 0.0001) }
    func testSHA256() { XCTAssertEqual(PackageIO.sha256(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") }
    func testPackageRequiresTwoDistinctTopLevelJPGFrames() throws {
        let one = [(id: "f1", timestamp: 1.0, imagePath: "images/f1.jpg")]
        XCTAssertThrowsError(try PackageIO.validateFrames(one))
        XCTAssertThrowsError(try PackageIO.validateFrames(one + [(id: "f2", timestamp: 2.0, imagePath: "images/nested/f2.jpg")]))
        XCTAssertThrowsError(try PackageIO.validateFrames(one + [(id: "f1", timestamp: 2.0, imagePath: "images/f2.jpg")]))
        XCTAssertNoThrow(try PackageIO.validateFrames(one + [(id: "f2", timestamp: 2.0, imagePath: "images/f2.jpg")]))
    }
    func testTriangleDepthChecksInteriorPixels() {
        let triangle = [SIMD2<Float>(0,0), SIMD2<Float>(1,0), SIMD2<Float>(0,1)]
        let depths = [Float](repeating: 2, count: 16)
        let good = depths.withUnsafeBytes { Data($0) }
        var blocked = depths; blocked[5] = 1
        let bad = blocked.withUnsafeBytes { Data($0) }
        let confidence = Data(repeating: 2, count: 16)
        XCTAssertTrue(Geometry.triangleVisible(triangle, depths: [2,2,2], width: 4, height: 4, depth: good, confidence: confidence, confidenceWidth: 4, confidenceHeight: 4))
        XCTAssertFalse(Geometry.triangleVisible(triangle, depths: [2,2,2], width: 4, height: 4, depth: bad, confidence: confidence, confidenceWidth: 4, confidenceHeight: 4))
    }
    func testPackageRequiresDifferentImageContents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("images"), withIntermediateDirectories: true)
        let frameJSON = """
        {"frames":[{"id":"f1","timestamp":1,"image":{"path":"images/f1.jpg"},"depth":{"path":"depth/f1"},"confidence":{"path":"confidence/f1"}},{"id":"f2","timestamp":2,"image":{"path":"images/f2.jpg"},"depth":{"path":"depth/f2"},"confidence":{"path":"confidence/f2"}}]}
        """
        try Data(frameJSON.utf8).write(to: root.appendingPathComponent("frames.json"))
        try Data([1]).write(to: root.appendingPathComponent("images/f1.jpg"))
        try Data([1]).write(to: root.appendingPathComponent("images/f2.jpg"))
        XCTAssertThrowsError(try PackageIO.validateScan(root))
        try Data([2]).write(to: root.appendingPathComponent("images/f2.jpg"))
        XCTAssertNoThrow(try PackageIO.validateScan(root))
    }
    func testArchiveStageExcludesOrphanAndPreservesDraft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let scan = root.appendingPathComponent("scan"), staged = root.appendingPathComponent("staged")
        let fm = FileManager.default
        defer { try? fm.removeItem(at: root) }
        for dir in ["images", "depth", "confidence"] { try fm.createDirectory(at: scan.appendingPathComponent(dir), withIntermediateDirectories: true) }
        let json = """
        {"frames":[{"id":"f1","timestamp":1,"image":{"path":"images/f1.jpg"},"depth":{"path":"depth/f1"},"confidence":{"path":"confidence/f1"}},{"id":"f2","timestamp":2,"image":{"path":"images/f2.jpg"},"depth":{"path":"depth/f2"},"confidence":{"path":"confidence/f2"}}]}
        """
        try Data(json.utf8).write(to: scan.appendingPathComponent("frames.json"))
        for path in ["mesh.json", "edits.json", "images/f1.jpg", "images/f2.jpg", "images/orphan.jpg", "depth/f1", "depth/f2", "confidence/f1", "confidence/f2"] { try Data(path.utf8).write(to: scan.appendingPathComponent(path)) }
        try PackageIO.stageArchive(scan: scan, destination: staged)
        XCTAssertFalse(fm.fileExists(atPath: staged.appendingPathComponent("images/orphan.jpg").path))
        XCTAssertTrue(fm.fileExists(atPath: scan.appendingPathComponent("images/orphan.jpg").path))
        XCTAssertEqual(try Data(contentsOf: staged.appendingPathComponent("images/f1.jpg")), try Data(contentsOf: scan.appendingPathComponent("images/f1.jpg")))
    }
    func testKeyframeRequiresMotion() {
        let origin = matrix_identity_float4x4
        XCTAssertFalse(Geometry.isKeyframe(origin, after: origin))
        var moved = origin; moved.columns.3.x = 0.11
        XCTAssertTrue(Geometry.isKeyframe(moved, after: origin))
        let turn = simd_float4x4(simd_quatf(angle: .pi / 12, axis: SIMD3<Float>(0,1,0)))
        XCTAssertTrue(Geometry.isKeyframe(turn, after: origin))
    }
    func testEmptyEditsEncodeExplicitNullCrop() throws {
        let data = try JSONEncoder().encode(Edits(crop: nil))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(object["crop"] is NSNull)
        XCTAssertNotNil(object["measurements"] as? [Any])
    }
    func testFrameAdmissionDropsBusyAndPausedFrames() {
        var gate = FrameAdmission()
        XCTAssertFalse(gate.admit(trackingNormal: false))
        XCTAssertTrue(gate.admit(trackingNormal: true))
        XCTAssertFalse(gate.admit(trackingNormal: true))
        gate.pause()
        gate.finished()
        XCTAssertFalse(gate.admit(trackingNormal: true))
        gate.resume()
        XCTAssertTrue(gate.admit(trackingNormal: true))
    }
    func testGrayMeshExportsWithoutFrames() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("{\"frames\":[]}".utf8).write(to: root.appendingPathComponent("frames.json"))
        let mesh = Mesh(vertices: [[0,0,0],[1,0,0],[0,1,0]], normals: [[0,0,1],[0,0,1],[0,0,1]], faces: [[0,1,2]])
        let preview = root.appendingPathComponent("preview")
        try OBJExporter.export(scan: root, mesh: mesh, destination: root.appendingPathComponent("model.zip"), previewDirectory: preview)
        let obj = try String(contentsOf: preview.appendingPathComponent("model.obj"), encoding: .utf8)
        XCTAssertTrue(obj.contains("usemtl untextured\nf 1 2 3"))
    }
    func testReplaceExportPreservesNameAndReplacesContents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let dest = root.appendingPathComponent("scan.gaussroom.zip")
        let first = root.appendingPathComponent("one"), second = root.appendingPathComponent("two")
        try Data("old".utf8).write(to: first); try PackageIO.replaceExport(first, destination: dest)
        try Data("new".utf8).write(to: second); try PackageIO.replaceExport(second, destination: dest)
        XCTAssertEqual(try Data(contentsOf: dest), Data("new".utf8))
    }
    func testProjectSummaryDecodesProgressAndIncompleteTiming() throws {
        let json = """
        {"id":"p","name":"Room","state":"running","progress":0.5,"timing":{"elapsedMs":1200,"complete":false,"running":true},"steps":[{"id":"prepare","name":"准备","status":"running","progress":0.5,"timing":{"elapsedMs":1200,"complete":false,"running":true}}],"quality":{"geometry":"unverified","coverage":"unreviewed","appearance":"unreviewed","scale":"unmeasured","trainingComplete":false,"complete":false},"scene":null,"lastError":null}
        """
        let summary = try JSONDecoder().decode(ProjectSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.steps.first?.name, "准备")
        XCTAssertEqual(summary.progress, 0.5)
        XCTAssertEqual(summary.timing?.elapsedMs, 1200)
        XCTAssertEqual(summary.timing?.complete, false)
        XCTAssertEqual(summary.quality?.geometry, "unverified")
    }
}
