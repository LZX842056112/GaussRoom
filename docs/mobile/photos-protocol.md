# 通用手机照片接口

适用范围：手机浏览器采集照片，Windows 运行现有照片重建。原有 LiDAR ZIP 接口保持兼容。普通照片项目使用 `inputKind: photos`，实际尺度未实测。

## 网页与授权

网关增加公开的 GET/HEAD `/mobile/`、`/mobile/app.js`、`/mobile/style.css`、`/mobile/state.mjs`。仅这四个精确路径不需要配对。其余 API 继续使用 `/api/mobile/v1`，写请求必须带 Bearer，读请求可用现有 HttpOnly Cookie。

配对仍用 `POST /pair {code,deviceName}`。网页收到 token 后保存在当前 origin 的 localStorage，并调用 `POST /session` 设置查看器 Cookie。401 时提示重新配对，不能自动授权旧设备的批次。设备和批次 ID 都不能作为 URL 凭证。

## API

- `GET /capabilities` -> `{photoFormats:[".jpg",".jpeg",".png",...],limits:{maxFileBytes:67108864,maxFiles:500,maxBatchBytes:4294967296,minLongEdge:1000},trainingPresets:["fast","standard","full"]}`。HEIC/HEIF 仅在解码能力成立时出现。不得返回本机路径。
- `GET /photo-sessions` -> 批次数组，只有当前设备的数据。
- `POST /photo-sessions {name,trainingPreset}` -> 新批次；preset 缺省为 standard。
- `GET /photo-sessions/:id` -> 当前批次。
- `DELETE /photo-sessions/:id` -> `{removed,projectId}`。删除本设备批次及关联的普通照片项目、原件和重建结果；运行中的项目返回 409。仍要求 Bearer，Cookie 单独无权删除。网页操作前须确认不可撤销。
- `POST /photo-sessions/:id/files {name,bytes}` -> `{fileId,session}`。服务器产生 fileId；name 仅为显示名称。
- `PUT /photo-sessions/:id/files/:fileId` -> 二进制完整照片；字节数必须等于声明值。成功返回当前批次。失败重传当前文件，不拼接部分内容。
- `DELETE /photo-sessions/:id/files/:fileId` -> 当前批次。仅可移除未提交批次的文件，原始手机照片保持不变。
- `POST /photo-sessions/:id/commit` -> `{projectId}`。重复提交幂等。提交不启动训练。

批次 DTO：`{id,name,trainingPreset,status,projectId,files,uniqueCount,totalBytes}`。status 为 `open | committing | committed | deleting`；projectId 未创建时为 null。deleting 表示删除尚未完成，可重试 DELETE；该状态不再提供项目授权或重建入口。

file DTO：`{id,name,bytes,status,error,sha256,width,height,duplicateOf}`。status 为 `pending | uploading | ready | duplicate | failed`；尚无值的字段为 null。重复文件以完整内容 SHA256 判定，标记 duplicate 并引用现有 ready 文件。uniqueCount 只统计 ready。totalBytes 是未移除文件的声明总字节数（含重复文件），用于容量预留。

所有 ID 为服务器 UUID。不使用客户端文件名作为路径或身份。错误返回 `{error}`，状态码沿用现有网关规则。未知或他人的 ID 返回 404；撤销后的请求返回 401；批次忙或提交状态冲突返回 409；超限返回 413。

## 批次和文件规则

- 每张最多 64 MiB，每批最多 500 个文件、4 GiB。创建批次和文件时校验实际结构、训练档位、容量和磁盘空间。
- 文件顺序上传。服务器流式写入临时文件，计算 SHA256，完整解码，并检查长边不少于 1000 像素。JPEG、PNG 始终支持；HEIC/HEIF 需解码器能力，失败须清楚提示。保留原始上传字节及 EXIF，不在手机压缩原件。
- pending、uploading 或 failed 文件阻止提交；用户重试或移除后再提交。至少两个 ready 文件，duplicate 不计作独立照片。
- 网络中断后文件标为 failed；重试从该文件第 0 字节开始。已完成照片保持。服务重启将未完成 uploading 恢复为 failed，保留 ready 文件。
- 浏览器仅保存 token、批次 ID 和可恢复状态，不持久化照片原始 Blob。刷新后读取服务器状态，提示重新选择尚未上传的照片。重新选择全部照片也安全，服务器按内容去重。
- 每批串行修改锁。流式上传、验证、哈希等 await 后，写入、建项目、授权前重新调用当前请求的权限检查。
- 提交前检查 ready 原件的实际哈希。恢复记录必须在项目创建前持久化，项目 ID 使用现有内部预分配参数。原始照片最终位于该项目自己的 `source-images/`。不修改 LiDAR 记录、旧模型或用户其他文件。
- 恢复只操作日志证明属于当前批次的项目和路径；不能删除或覆盖无关项目。已提交项目恢复设备授权时，只有尚未撤销的原设备可获得授权。

## 模块接口

`tools/workbench/lib/photo-sessions.mjs` 导出：

```js
createPhotoSessions({root,projectStore,jobStore,validatePhoto,getCapabilities,grantProject,revokeProject,isDeviceActive})
```

返回 `{handle,capabilities,ownsProject}`。

- `handle(request,response,pathname,deviceId,checkAuthorization)` -> Promise<boolean>；处理上述 photo-sessions 路由。匹配返回 true，其他路径返回 false；错误交给现有网关捕获。
- `capabilities()` -> Promise<Capabilities>。
- `ownsProject(id)` -> boolean，表示由该照片服务创建的已提交项目；最终权限仍须检查 device.projects。
- `validatePhoto(path,extension)` -> Promise<PhotoInfo>。
- `getCapabilities()` -> Promise<{photoFormats}>。服务补齐 limits 和 trainingPresets。
- `grantProject(deviceId,projectId)` 同步将项目加入现有设备授权集合。
- `revokeProject(deviceId,projectId)` 同步清理已删除项目的授权。`jobStore.current/liveProject` 用于阻止删除正在运行的项目。
- `isDeviceActive(deviceId)` -> boolean；用于启动恢复，已撤销设备不得重新获得授权。

PhotoInfo：`{format,extension,width,height,sha256,bytes}`。extension 是 `.jpg | .png | .heic | .heif`，format 为 `JPEG | PNG | HEIC | HEIF`。

`tools/workbench/py/validate_photo.py`：

```text
--image PATH --extension .jpg --min-long-edge 1000 [--ffmpeg PATH]
--capabilities [--ffmpeg PATH]
```

成功 stdout 为 JSON。图片验证返回 PhotoInfo；capabilities 模式返回 `{photoFormats:[...]}`，Node 补齐 limits 和 trainingPresets。错误 stderr 简短说明，非零退出。文件尺寸和像素数量有上限，不能信任扩展名或仅调用 JPEG verify。HEIC 能力需实际检查，不能只因 ffmpeg 文件存在就宣称支持；可使用小型、有公开许可和来源记录的 HEIC 测试样本。

## 手机交互

页内系统拍照控件使用 capture=environment；相册入口多选。不能唤起相机时提示先拍照再选图。HEIC 无法在浏览器生成缩略图时显示名称和类型，仍可上传。缩略图小尺寸生成，限制并发，原件不压缩。

页面显示配对、批次名称/preset、文件状态/重试/移除、提交按钮、开始重建按钮。上传只创建项目，用户明确开始计算。已提交项目用原 `/projects/:id` 和 `/projects/:id/run`；running/aborting 时每两秒刷新，显示步骤、耗时及质量。忙时保留项目并提示等待，避免后台重复自动启动。查看器通过 Cookie 使用 `scene.viewerUrl`，不把 token 放 URL。
