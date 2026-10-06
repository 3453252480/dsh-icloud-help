# dsh-icloud-help

iCloud Windows 助手 —— 查看 iCloud 照片库中哪些文件仅在云端，并一键下载到本地。

## 功能

- **状态扫描**：区分照片库中「仅存云端 / 已下载到本地」的图片与视频，显示文件数、逻辑体积与清单。
- **一键下载**：后台队列把云端文件逐个拉回本地，带重试、可中断、实时进度。
- **自动下载**：默认开启。**只要扫描到有可下载的云端文件，立即开始下载**，不必等定时器；
  任何一次扫描（打开面板、前端刷新、后台定时）都会触发检查，关掉界面也生效。
  扫描结果有 3 秒缓存，短时间多次扫描只触发一次（50ms 防抖 + 防环标志）。
  **检查间隔可在界面上自定义**（分钟为单位，含 1/5/15/30/60 分钟快捷档），
  取值范围 10 秒 ~ 24 小时，默认 5 分钟。改完立即重排定时器，无需重启。
- **照片预览**：网格预览照片与视频封面，滑块无级调列（1–8），
  可选「按照片尺寸显示」（保持原始宽高比）；懒加载只拉可视区缩略图；
  右键可复制图片（直接粘贴到对话）、复制文件名、复制路径、查看大图。

在「设置 → iCloud 照片」（导航位于 agent-presets 与插件之间）中查看与操作。

## 技术要点

iCloud 照片目录（`%USERPROFILE%\Pictures\iCloud Photos\Photos`）是一个 Apple 私有重解析点
（tag `0x9000301a`），「仅云端」的文件是稀疏占位：

- **判据**：`fs.statSync().blocks === 0` 表示文件无本地数据块（即仅云端）。
  Node 在 Windows 上**不暴露** `FILE_ATTRIBUTE_*`（`st.attributes === undefined`），
  故不能用 `0x400000` 位；`blocks` 判据与 PowerShell 读到的 `0x400000` 属性位
  经 **59/59** 交叉验证一致。
- **下载**：读取云端文件会触发回源，但 iCloud 单次操作有 60 秒硬超时
  （`云操作未在超时时间结束之前完成` / HRESULT `0x8007017C`）。
  因此采用「短读触发 + 轮询 `blocks`」策略，超时属预期，回源请求在后台继续。
- **前提**：iCloud 客户端必须与 Apple 服务器保持有效连接。若所有 iCloud 进程的
  TCP 连接都只有 `Bound`/`CloseWait` 而无 `Established`，则下载必然全部超时，
  需重启 iCloud 客户端或重置照片同步。
- **缩略图**：iPhone 的 HEIC 有两种流形态，处理方式不同：
  - **多流 grid**（常见）：内部含 60+ 个流（主图 + HDR 增益图 + 8/10bit 变体
    + 缩略图预览），分辨率 312x416 到 4284x5712。显式 `-map 0:v:0` 常选到
    最小的预览流，要挑分辨率最大的流。
  - **Tile Grid**（较新变体，yuv444p）：整图是**一个** group 流。
    显式 `-map 0:0` 会解出 512x512 的拼贴小块（错的）；**不指定 map**
    才得到完整原图。且此时 ffmpeg 用复杂滤镜图，**不能**再传 `-vf`
    （报 `Simple and complex filtering cannot be used together`）。

  因此实际策略是：**ffmpeg 只负责抽出正确的完整帧，缩放交给 sharp**；
  抽帧时先不指定 map，用 sharp 读到的权威比例校验，不符再换「挑最大流」重试。
  - **尺寸探测**：HEIC 用 sharp 读容器元数据（能读、但解不了像素），
    JPEG/PNG 直接读文件头。这一步是「按照片尺寸」排版的基础。
  - **视频播放**：`/original` 实现了 HTTP Range（206 + `content-range`），
    否则无法拖动进度条、部分浏览器不播。

## 依赖

- **ffmpeg**（必需，用于 HEIC 与视频缩略图）。本机默认路径：
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe`，
  也可放在 `PATH` 上。缺失时 HEIC/视频无法生成缩略图（会在格子里显示「无法预览」）。
- **sharp**（可选，处理 JPEG/PNG 等普通位图更快）。

## HTTP 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/icloud-help/status` | 扫描结果 + 队列进度（`?force=1` 强制重扫） |
| POST | `/api/icloud-help/scan` | 强制重新扫描 |
| POST | `/api/icloud-help/download` | 启动下载，body `{ "scope": "all" \| "image" \| "video" }` |
| POST | `/api/icloud-help/stop` | 停止当前下载 |
| GET | `/api/icloud-help/config` | 读取配置 |
| POST | `/api/icloud-help/config` | 写入配置 |
| GET | `/api/icloud-help/items` | 可预览文件清单（含相对路径、尺寸、类别） |
| GET | `/api/icloud-help/thumb` | 缩略图，`?p=<相对路径>&s=<长边像素>` |
| GET | `/api/icloud-help/original` | 原图字节，`?p=<相对路径>`（供预览大图与复制） |

`p` 参数是**相对照片目录**的路径；后端会做穿越防护（拒绝 `..`、绝对路径与
超出目录的解析结果），越权请求一律 404。

配置文件位于 `~/.dsh/storages/icloud-help.json`：

```json
{
  "photosDir": "C:\\Users\\<you>\\Pictures\\iCloud Photos\\Photos",
  "scope": "all",
  "perFileBudgetSec": 300,
  "concurrency": 2,
  "autoStart": false,
  "autoIntervalSec": 120
}
```

## 许可

MIT

