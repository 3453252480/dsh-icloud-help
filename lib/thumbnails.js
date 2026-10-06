/**
 * 缩略图生成 —— 纯逻辑层（不依赖 Cordis）。
 *
 * 关键事实（2026-10 实测）：
 *  - iPhone 的 HEIC 是「grid」容器，内部含 **60+ 个视频流**（HDR 增益图网格：
 *    主图 + 多张不同曝光的增益图，还有 8bit/10bit 多个变体）。因此用 ffmpeg 时
 *    **必须显式指定流号**（`-map 0:v:0`），否则报 "Invalid argument"。
 *    sharp/libheif 完全解不了这类 HEIC（报 "bad seek" + decoder error），
 *    实测 22/22 全部失败，所以 HEIC 一律走 ffmpeg。
 *  - 视频抽帧同样走 ffmpeg（sharp 不支持视频）。
 *  - 实测可生成缩略图：HEIC 22/22、视频 24/25（唯一失败的是个损坏的 .MOV）。
 *
 * 生成的缩略图缓存在磁盘，键为「路径 + 修改时间 + 尺寸」的哈希，
 * 源文件变动会自动失效。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 缩略图缓存目录。 */
const CACHE_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'icloud-help-thumbs')
  : join(homedir(), '.dsh', 'storages', 'icloud-help-thumbs')

/** 常见 ffmpeg 位置（本机实测路径优先）。 */
const FFMPEG_CANDIDATES = [
  'ffmpeg',
  join(
    homedir(),
    'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1.2-full_build', 'bin', 'ffmpeg.exe',
  ),
]

let ffmpegPath = null
let ffmpegChecked = false

/** 定位可用的 ffmpeg；找不到返回 null。 */
export function resolveFfmpeg() {
  if (ffmpegChecked) return ffmpegPath
  ffmpegChecked = true
  for (const p of FFMPEG_CANDIDATES) {
    try {
      if (p === 'ffmpeg') {
        // 依赖 PATH；用 spawn 探测过重，这里只检查是否是绝对路径存在
        continue
      }
      if (existsSync(p)) { ffmpegPath = p; break }
    } catch { /* 忽略 */ }
  }
  // 回退到 PATH 上的 ffmpeg
  if (!ffmpegPath) ffmpegPath = 'ffmpeg'
  return ffmpegPath
}

/** 判断扩展名是否需要走 ffmpeg（HEIC 与视频）。 */
export function needsFfmpeg(name) {
  return /\.(heic|heif|mp4|mov|m4v|avi|mkv|hevc|3gp)$/i.test(name)
}

/** 判断是否是视频。 */
export function isVideoName(name) {
  return /\.(mp4|mov|m4v|avi|mkv|hevc|3gp)$/i.test(name)
}

/** 计算缓存键。 */
function cacheKey(path, size, mtimeMs) {
  const h = createHash('sha1')
  h.update(path)
  h.update('|')
  h.update(String(mtimeMs))
  h.update('|')
  h.update(String(size))
  return h.digest('hex').slice(0, 24)
}

/** 确保缓存目录存在。 */
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

/** 运行 ffmpeg 并收集 stderr（用于探测流信息）。 */
function runFfmpegCapture(args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const bin = resolveFfmpeg()
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* 忽略 */ } resolve(out) }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stderr.on('data', (d) => { out += d.toString() })
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(out) } })
    child.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(out) } })
  })
}

/**
 * 从 HEIC 的多个流里挑出分辨率最大的那个（返回流索引）。
 *
 * iPhone 的 HEIC 是 grid 容器，内部含大量流：主图（最大，可能 4284x5712）、
 * 多张 HDR 增益图、8bit/10bit 变体，以及最小的缩略图预览流（如 312x416）。
 * 直接用 -map 0:v:0 常选到最小的那个，导致缩略图模糊。
 *
 * @returns 流索引，探测失败返回 null
 */
async function pickLargestStream(srcPath) {
  const info = await runFfmpegCapture(['-hide_banner', '-i', srcPath])
  if (!info) return null
  let best = null
  let bestPixels = 0
  // 两种行格式都要认：
  //  普通流      `Stream #0:61[0x41]: Video: hevc ..., 416x312, 1 fps`
  //  瓦片网格流  `Stream group #0:0[0x13]: Tile Grid: hevc ..., 1206x2622 (default)`
  // 后者是较新的 HEIC 变体（yuv444p tile grid），漏掉它会退化成用缩略图预览流。
  const patterns = [
    /Stream #0:(\d+)(?:\[[^\]]*\])?[^:]*:\s*(?:Video|Tile Grid):[^\n]*?(\d{2,5})x(\d{2,5})/g,
    /Stream group #0:(\d+)(?:\[[^\]]*\])?[^:]*:\s*(?:Video|Tile Grid):[^\n]*?(\d{2,5})x(\d{2,5})/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(info))) {
      const idx = Number(m[1])
      const px = Number(m[2]) * Number(m[3])
      if (px > bestPixels) { bestPixels = px; best = idx }
    }
  }
  return best
}

/** 运行 ffmpeg 抽一帧/解码为 JPEG。 */
function runFfmpeg(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg()
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try { child.kill('SIGKILL') } catch { /* 忽略 */ }
        reject(new Error(`ffmpeg 超时 (${timeoutMs}ms)`))
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`无法启动 ffmpeg: ${err.message}`))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-300)}`))
    })
  })
}

/**
 * 生成（或取用缓存）一个缩略图。
 *
 * @param srcPath 源文件绝对路径
 * @param size    长边像素（默认 400）
 * @returns { ok, path, mime, error }
 */
export async function getThumbnail(srcPath, size = 400) {
  ensureCacheDir()
  let st
  try {
    st = statSync(srcPath)
  } catch (err) {
    return { ok: false, error: `无法读取源文件: ${err.message}` }
  }
  if (!st.isFile()) return { ok: false, error: '不是文件' }

  const name = srcPath.split(/[\\/]/).pop() || ''
  const key = cacheKey(srcPath, size, st.mtimeMs)
  const outPath = join(CACHE_DIR, `${key}.jpg`)

  // 命中缓存直接返回。
  if (existsSync(outPath)) {
    return { ok: true, path: outPath, mime: 'image/jpeg', cached: true }
  }

  const useFfmpeg = needsFfmpeg(name)
  try {
    if (useFfmpeg) {
      // HEIC 的流选择有两种情况，必须分开处理：
      //
      //  1. 普通 HEIC（多流 grid）：内部有 60+ 个流（主图 + HDR 增益图 + 8/10bit
      //     变体 + 缩略图预览），分辨率从 312x416 到 4284x5712。此时
      //     `-map 0:v:0` 常选到最小的预览流 → 要挑分辨率最大的流。
      //
      //  2. Tile Grid HEIC（较新变体，yuv444p）：整个图是**一个** group 流，
      //     显式 `-map 0:0` 反而会解出 512x512 的拼贴小块；**不指定 map**
      //     ffmpeg 自己选才对（实测 1206x2622 正确）。
      //
      // 所以策略是「先不指定 map，生成后校验比例；比例明显不对再换挑最大流」。
      const isVid = isVideoName(name)
      const expected = await probeSize(srcPath)   // 权威比例（HEIC 也支持）

      /**
       * 抽一帧到临时 PNG（尽量原尺寸），随后统一交给 sharp 缩放。
       *
       * 为什么不直接用 ffmpeg 缩放：HEIC 有两种流形态——
       *  - 多流 grid：显式 `-map` 时是普通滤镜图，可用 `-vf scale`；
       *  - Tile Grid（单 group 流）：**不能**用 `-vf`（报 simple/complex 冲突），
       *    且 `-map 0:0` 会解出 512x512 的拼贴小块（错的），
       *    只有「不指定 map」才得到完整原图（实测 1206x2622）。
       * 所以这里只负责「拿到正确的完整帧」，缩放交给 sharp，两边都稳。
       */
      async function shootFrame(mapSpec, outFile) {
        if (existsSync(outFile)) { try { unlinkSync(outFile) } catch { /* 忽略 */ } }
        const a = ['-y', '-loglevel', 'error']
        if (isVid) a.push('-ss', '1')   // 视频跳过开头，避免黑帧
        a.push('-i', srcPath)
        if (mapSpec) a.push('-map', mapSpec)
        a.push('-frames:v', '1', '-update', '1', outFile)
        try { await runFfmpeg(a, 60_000) } catch { /* 由存在性检查兜底 */ }
        if (!existsSync(outFile)) return null
        try { return await probeSize(outFile) } catch { return null }
      }

      /** 比例是否可信（与权威比例差 <8%）。 */
      function aspectOk(got) {
        if (!got || !got.height || !expected.height) return true  // 无从判断就不拦
        const a = got.width / got.height
        const b = expected.width / expected.height
        return Math.abs(a - b) / b < 0.08
      }

      const rawFile = join(CACHE_DIR, `${key}.raw.png`)

      // 第一选择：不指定 map（对 Tile Grid 是唯一正确解）。
      let got = await shootFrame(null, rawFile)
      // 比例不对 → 换成挑最大分辨率流重试（多流 grid 的情况）。
      if (!aspectOk(got)) {
        const best = await pickLargestStream(srcPath)
        if (best !== null) {
          const got2 = await shootFrame(`0:${best}`, rawFile)
          if (aspectOk(got2)) got = got2
        }
      }
      // 视频的 -ss 1 可能超出时长导致没输出，退回第 0 帧。
      if (!got && isVid) {
        got = await shootFrame(null, rawFile)
      }
      if (!got) throw new Error('ffmpeg 未能抽出有效帧')

      // 统一用 sharp 缩放到目标尺寸（保比例，长边 = size）。
      const sharp = (await import('sharp')).default
      const buf = await sharp(rawFile, { failOn: 'none' })
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
      await writeFile(outPath, buf)
      try { unlinkSync(rawFile) } catch { /* 中间产物，删不掉也不影响 */ }
    } else {
      // 普通位图走 sharp（更快更稳）。
      const sharp = (await import('sharp')).default
      const buf = await sharp(srcPath, { failOn: 'none' })
        .rotate()               // 按 EXIF 方向自动摆正
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
      await writeFile(outPath, buf)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (!existsSync(outPath)) return { ok: false, error: '生成失败（无输出）' }
  // 顺带回报缩略图尺寸，前端可用于「按照片尺寸」排版（无需再探测原图）。
  let w = 0, hgt = 0
  try {
    const png = await probeSize(outPath)
    w = png.width; hgt = png.height
  } catch { /* 忽略 */ }
  return { ok: true, path: outPath, mime: 'image/jpeg', cached: false, width: w, height: hgt }
}

/**
 * 读取图片真实尺寸（原图分辨率，非缩放后）。
 *
 * 分工要点：
 *  - **HEIC**：sharp 能读容器元数据拿到真实尺寸（4284x5712 这类），
 *    但解不了像素（libheif 缺 HDR/网格解码）。所以尺寸交给 sharp。
 *  - **JPEG/PNG**：直接读文件头，最快。
 *  - 兜底：都没读到就返回 0/0，调用方退回默认比例。
 *
 * @returns { width, height }，失败时 0/0
 */
export async function probeSize(p) {
  const ext = (p.split('.').pop() || '').toLowerCase()

  // HEIC/HEIF 走 sharp 读元数据（它能读不会解的那部分）。
  if (ext === 'heic' || ext === 'heif') {
    try {
      const sharp = (await import('sharp')).default
      const m = await sharp(p).metadata()
      if (m.width > 0 && m.height > 0) {
        // EXIF 方向为 5-8 时宽高需要互换。
        const rot = m.orientation >= 5 && m.orientation <= 8
        return rot
          ? { width: m.height, height: m.width }
          : { width: m.width, height: m.height }
      }
    } catch { /* 落到下面的文件头解析 */ }
  }

  let buf
  try {
    const { open } = await import('node:fs/promises')
    const fh = await open(p, 'r')
    try {
      buf = Buffer.alloc(65536)
      await fh.read(buf, 0, 65536, 0)
    } finally { await fh.close().catch(() => {}) }
  } catch { return { width: 0, height: 0 } }

  // PNG: 签名 + IHDR
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: 扫描 SOFn 段
  if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue }
      const marker = buf[i + 1]
      // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (len <= 0) break
      i += 2 + len
    }
  }
  return { width: 0, height: 0 }
}

/** 读取源文件的原始字节（供「复制图片」与「查看大图」）。 */
export async function readOriginal(srcPath, maxBytes = 40 * 1024 * 1024) {
  const st = statSync(srcPath)
  if (st.size > maxBytes) {
    return { ok: false, error: `文件过大（${Math.round(st.size / 1048576)}MB），超过 ${Math.round(maxBytes / 1048576)}MB 上限` }
  }
  const buf = await readFile(srcPath)
  return { ok: true, buffer: buf }
}

/** 缓存目录路径（供诊断）。 */
export function cacheDir() { return CACHE_DIR }

/** 清理缓存（供维护用）。 */
export async function clearCache() {
  try {
    if (!existsSync(CACHE_DIR)) return { removed: 0 }
    const { rm } = await import('node:fs/promises')
    await rm(CACHE_DIR, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) }
  }
}
