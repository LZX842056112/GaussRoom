# GaussRoom iPhone 端

此目录包含 iOS 17 及以上版本的 Swift 源码、Xcode 工程和 XCTest。需要带 LiDAR 的 iPhone 扫描。当前环境是 Windows：尚未编译或在设备上验收。

## 在 Mac 上构建

1. 安装 Xcode 15 或更新版本，打开 `GaussRoom.xcodeproj`。
2. 选择 `GaussRoom` target，在 Signing & Capabilities 选择开发团队和唯一的 Bundle Identifier。
3. 选择带 LiDAR 的 iPhone，运行 `GaussRoom` scheme，允许相机和局域网访问。
4. 在 Xcode 中运行 `GaussRoomTests`。也可先用 `xcodebuild -list -project GaussRoom.xcodeproj` 查看 scheme，再运行 `xcodebuild test -project GaussRoom.xcodeproj -scheme GaussRoom -destination 'platform=iOS Simulator,name=iPhone 15'`。模拟器名称要与本机安装的设备匹配。

## 使用和设备验收

扫描页使用 RealityKit 显示随扫描更新的深度着色网格。请在真机确认网格可见，并在暂停、继续后仍与同一房间表面对齐。该显示使用系统的 `showSceneUnderstanding`，不代表扫描已覆盖全部表面。

- 开始扫描，缓慢移动手机，停止后打开本地扫描。确认帧数增加，关闭重开 App 后数据仍可读取。
- 转动模型；选择“生成彩色模型并导出 OBJ”以生成彩色预览。点两处估算距离。输入世界坐标的最小和最大值来裁剪，撤销后确认原网格恢复。裁剪保留完全位于范围内的三角面。
- 至少记录两张内容不同的关键帧，再导出完整扫描包；不足两帧时仍可保留本地扫描。导出彩色 OBJ ZIP 和完整扫描包。确认 OBJ、MTL、图片可在其他工具打开；用电脑的离线导入检查扫描包和校准。
- 在电脑启用网关，用地址和配对码连接。导出完整扫描包到“文件”，在连接页选择它上传，启动增强，再打开场景。中断上传后再次选择相同文件，检查服务器偏移和续传结果。上传前 App 会检查本机对应的扫描，因此需要保留该本地扫描。
- 分别测试暂停和继续、来电、锁屏、切后台、存储空间不足、高温和重启。切后台会请求暂停；AR 会话中断或失败会结束扫描。确认已保存的数据可读取，新扫描不会合并旧世界坐标。

纹理选择检查面朝向、顶点和边的深度，并检查三角形覆盖的深度图像素。遮挡检测受深度图分辨率和传感器误差限制。没有合适纹理的面使用灰色材质。测距为估算值。

局域网可以使用 HTTP；扫描包和配对令牌在 HTTP 连接中没有传输加密。只在可信网络中使用，或在网关提供 HTTPS 时使用 HTTPS。
