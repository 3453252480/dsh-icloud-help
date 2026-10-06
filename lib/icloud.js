/**
 * iCloud 照片目录扫描与云端文件下载 —— 纯逻辑层（不依赖 Cordis）。
 *
 * 核心事实（2026-10 实测于 AppleInc.iCloud 15.10.39.0 / Node v24）：
 *  - iCloud 照片目录本身带 Apple 私有重解析标签 0x9000301a。
 *  - 「仅在云端」的文件在 NTFS 上是稀疏占位：**数据块为 0，但报告真实大小**。
 *  - 判据选择：Node 的 `fs.statSync` **不暴露** Windows FILE_ATTRIBUTE_*（实测
 *    `st.attributes === undefined`），故不能用 0x400000 位。改用 `st.blocks === 0`，
 *    与 PowerShell 读到的 0x400000 属性位交叉验证 **59/59 完全一致**。
 *  - 读取云端文件内容会触发联网下载；单次读取有 60 秒超时，超时抛
 *    "云操作未在超时时间结束之前完成"（HRESULT 0x8007017C）。
 *    因此必须后台队列 + 逐个重试，进度靠 blocks 变化判定。
 */

import { open, stat } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 图片扩展名集合（小写，含点）。 */
export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp',
  '.tif', '.tiff', '.webp', '.dng', '.raw', '.avif',
])

/** 视频扩展名集合（小写，含点）。 */
export const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.hevc', '.3gp',
])

/** 判断文件扩展名属于哪一类。 */
export function classify(name) {
  const i = name.lastIndexOf('.')
  if (i < 0) return 'other'
  const ext = name.slice(i).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'other'
}

/** 判断单个路径是否仍在云端（blocks 为 0 表示无本地数据块）。 */
export function isCloudOnlyStat(p) {
  try {
    const st = statSync(p, { throwIfNoEntry: false })
    if (!st || !st.isFile()) return false
    return st.blocks === 0
  } catch {
    return false
  }
}

/** 扫描一个 iCloud 照片目录。同步实现，只读目录项与元数据，不触碰文件内容。 */
export function scanDirectory(root) {
  const entries = []
  const summary = {
    total: 0, images: 0, videos: 0, others: 0,
    cloudOnly: 0, cloudOnlyImages: 0, cloudOnlyVideos: 0,
    cloudOnlyBytes: 0, localBytes: 0,
  }

  let names
  try {
    names = readdirSync(root)
  } catch (err) {
    return {
      root, ok: false,
      error: err instanceof Error ? err.message : String(err),
      entries: [], summary, scannedAt: Date.now(),
    }
  }

  for (const name of names) {
    if (name === 'desktop.ini' || name.startsWith('.')) continue
    const full = join(root, name)
    let st
    try {
      st = statSync(full, { throwIfNoEntry: false }) ?? undefined
    } catch {
      continue
    }
    if (!st || !st.isFile()) continue

    // blocks === 0 → 云端占位（与 PowerShell 的 0x400000 属性位等价，已交叉验证）
    const cloudOnly = st.blocks === 0
    const kind = classify(name)

    entries.push({
      name, path: full, size: st.size, kind,
      cloudOnly, mtimeMs: st.mtimeMs,
    })

    summary.total++
    if (kind === 'image') summary.images++
    else if (kind === 'video') summary.videos++
    else summary.others++
    if (cloudOnly) {
      summary.cloudOnly++
      summary.cloudOnlyBytes += st.size
      if (kind === 'image') summary.cloudOnlyImages++
      else if (kind === 'video') summary.cloudOnlyVideos++
    } else {
      summary.localBytes += st.size
    }
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { root, ok: true, entries, summary, scannedAt: Date.now() }
}

/** 单次「短读」尝试：触发 iCloud 回源，超时视为预期。 */
async function pokeOnce(path, timeoutMs) {
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(1)
    await Promise.race([
      fh.read(buf, 0, 1, 0),
      new Promise((_, rej) => {
        const t = setTimeout(() => rej(new Error('read-timeout')), timeoutMs)
        if (typeof t.unref === 'function') t.unref()
      }),
    ])
    return true
  } catch {
    // 超时/未完成属于预期：回源请求通常已下发，继续轮询即可。
    return false
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/**
 * 触发单个文件的 iCloud 回源下载。
 *
 * 关键：不能依赖单次读取——iCloud 单次操作有 60 秒超时。这里采用
 * 「反复短读 + 检查 blocks」的轮询策略：每次只读 1 字节，触发回源后立即放弃，
 * 让 iCloud 守护进程在后台继续传；随后轮询 blocks 直到变为非 0。
 *
 * @param path      目标文件
 * @param opts.budgetMs  总预算（默认 5 分钟）
 * @param opts.pollMs    轮询间隔
 * @param opts.onTick    每次轮询回调（已等待毫秒数）
 * @param opts.signal    取消信号 `{ cancelled: boolean }`
 * @returns 是否成功变为本地就绪
 */
export async function ensureLocal(path, opts = {}) {
  const budgetMs = opts.budgetMs ?? 300_000
  const pollMs = opts.pollMs ?? 2_000
  const started = Date.now()

  // 已经就绪则直接返回。
  if (!isCloudOnlyStat(path)) return true

  // 阶段一：触发回源。超时是预期内的，忽略即可。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.cancelled) return false
    await pokeOnce(path, 8_000)
    if (!isCloudOnlyStat(path)) return true
  }

  // 阶段二：轮询 blocks，等待后台下载完成。
  while (Date.now() - started < budgetMs) {
    if (opts.signal?.cancelled) return false
    opts.onTick?.(Date.now() - started)
    if (!isCloudOnlyStat(path)) return true

    // 周期性补一次触发，因为部分文件需要多次请求才会真正开始传输。
    await pokeOnce(path, 5_000)
    await sleep(pollMs)
  }

  return !isCloudOnlyStat(path)
}

/** 判断一个文件当前是否仍在云端（需要继续拉取）。 */
export async function isStillCloudOnly(path) {
  try {
    const st = await stat(path)
    return st.blocks === 0
  } catch {
    return false
  }
}

/** 简易 sleep。 */
export function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}
