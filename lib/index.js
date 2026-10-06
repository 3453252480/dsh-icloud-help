/**
 * iCloud Windows Help — Host half.
 *
 * 提供两件事：
 *  1. 扫描 iCloud 照片目录，区分「仅云端 / 已在本地」的图片与视频；
 *  2. 后台队列把云端文件逐个拉回本地，带重试、可中断、实时进度。
 *
 * 浏览器端通过 webServer 上注册的 REST 端点访问：
 *   GET  /api/icloud-help/status    — 当前扫描结果 + 队列进度
 *   POST /api/icloud-help/scan      — 强制重新扫描
 *   POST /api/icloud-help/download  — 启动下载（body: { scope: 'all'|'image'|'video' }）
 *   POST /api/icloud-help/stop      — 停止当前下载
 *   GET  /api/icloud-help/config    — 读取插件配置
 *   POST /api/icloud-help/config    — 写入插件配置
 *   GET  /api/icloud-help/thumb     — 缩略图（?p=<相对路径>&s=<长边像素>）
 *   GET  /api/icloud-help/original  — 原图字节（?p=<相对路径>），供预览大图与复制
 *   GET  /api/icloud-help/items     — 列出可预览的文件（含尺寸信息）
 */

import { join, dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { scanDirectory, ensureLocal, isCloudOnlyStat, classify } from './icloud.js'
import { getThumbnail, readOriginal, cacheDir, resolveFfmpeg, probeSize } from './thumbnails.js'

const DEFAULT_PHOTOS_DIR = join(homedir(), 'Pictures', 'iCloud Photos', 'Photos')
const CONFIG_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages')
  : join(homedir(), '.dsh', 'storages')
const CONFIG_FILE = join(CONFIG_DIR, 'icloud-help.json')
const ROUTE_PREFIX = '/api/icloud-help'

/**
 * 自动检查间隔（秒）。
 * 下限 10 秒用于快速验证；界面上按「分钟」输入，换算后仍受这里夹取。
 * 上限 24 小时，避免填出无意义的超长间隔。
 */
const MIN_INTERVAL_SEC = 10
const MAX_INTERVAL_SEC = 86_400
const DEFAULT_INTERVAL_SEC = 300

function resolveConfig(raw) {
  const dir = raw?.photosDir?.trim()
  return {
    photosDir: dir && dir.length > 0 ? dir : DEFAULT_PHOTOS_DIR,
    scope: raw?.scope === 'image' || raw?.scope === 'video' ? raw.scope : 'all',
    perFileBudgetSec: clamp(raw?.perFileBudgetSec ?? 300, 30, 3600),
    concurrency: clamp(raw?.concurrency ?? 2, 1, 4),
    autoStart: raw?.autoStart === true,
    autoIntervalSec: clamp(raw?.autoIntervalSec ?? DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
  }
}

function clamp(v, lo, hi) {
  const n = Number.isFinite(v) ? v : lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {}
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(cfg) {
  try {
    if (!existsSync(dirname(CONFIG_FILE))) mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {
    /* 忽略写入失败 */
  }
}

/** 按扩展名猜 MIME（原图端点用）。 */
function guessMime(p) {
  const e = (p.split('.').pop() || '').toLowerCase()
  switch (e) {
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'tif': case 'tiff': return 'image/tiff'
    case 'heic': case 'heif': return 'image/heic'
    case 'avif': return 'image/avif'
    case 'mp4': case 'm4v': return 'video/mp4'
    case 'mov': return 'video/quicktime'
    default: return 'application/octet-stream'
  }
}

/** Host 插件注册入口。 */
export function apply(ctx, rawConfig) {
  let config = resolveConfig(rawConfig ?? readConfig())
  let lastScan = null

  /** 下载队列状态。 */
  let queue = []
  let phase = 'idle'
  const cancelSignal = { cancelled: false }
  let currentNames = []
  let startedAt
  let finishedAt
  let lastMessage

  /** 短时缓存，避免前端高频轮询时反复扫盘。 */
  let scanCacheAt = 0
  const SCAN_TTL_MS = 3_000

  /** 防止「扫描 → 自动下载 → 再扫描」互相触发成环空转。 */
  let autoChecking = false

  /**
   * 防抖触发一次「检测到即下载」。
   * 扫描可能在一次交互里被连着调用多次（如前端同时拉 status 与 items），
   * 这里合并到一个定时器后的检查里，避免重复扫盘与重复启动下载。
   */
  function scheduleKick(reason = 'scan') {
    if (!config.autoStart) return
    if (autoChecking) return
    if (kickTimer !== null) return
    kickTimer = setTimeout(() => {
      kickTimer = null
      if (!config.autoStart) return
      if (phase === 'running' || phase === 'stopping') return
      autoDownloadNow(reason)
    }, 50)
    if (typeof kickTimer.unref === 'function') kickTimer.unref()
  }

  function getScan(force = false) {
    if (!force && lastScan && Date.now() - scanCacheAt < SCAN_TTL_MS) return lastScan
    lastScan = scanDirectory(config.photosDir)
    scanCacheAt = Date.now()
    // 扫描一结束就检查是否需要下载：不再等定时器，做到「检测到即下载」。
    // 放在这里而不是定时器里，是因为所有路径（前端轮询、手动刷新、自动检查）
    // 最终都经过 getScan，是最能保证「不漏」的位置。
    scheduleKick('scan')
    return lastScan
  }

  /**
   * 找出符合当前 scope 的云端待下载文件。
   * 与 buildQueue/autoTick 共用同一套筛选口径，避免三处逻辑漂移。
   */
  function cloudPending(scan) {
    if (!scan || !scan.ok) return []
    return scan.entries
      .filter((e) => e.cloudOnly)
      .filter((e) => {
        if (config.scope === 'image') return e.kind === 'image'
        if (config.scope === 'video') return e.kind === 'video'
        return e.kind === 'image' || e.kind === 'video'
      })
  }

  /**
   * 立即检测并下载（「检测到就下载」的唯一入口）。
   * 返回是否有任务被启动。下载进行中或已有队列时不重复触发。
   */
  function autoDownloadNow(reason = 'scan') {
    if (!config.autoStart) return false
    if (phase === 'running' || phase === 'stopping') return false
    // 防止 autoDownloadNow → getScan → scheduleKick → autoDownloadNow 成环空转。
    if (autoChecking) return false
    autoChecking = true

    try {
      let scan
      try {
        scan = getScan(true)
      } catch (err) {
        autoLastMessage = `自动检查异常：${err instanceof Error ? err.message : String(err)}`
        return false
      }
      if (!scan || !scan.ok) {
        autoLastMessage = `自动检查失败：${scan?.error || '目录不可读'}`
        return false
      }

      const pending = cloudPending(scan)
      autoLastCheck = Date.now()
      if (pending.length === 0) {
        autoLastMessage = '自动检查：没有新的云端文件'
        return false
      }

      autoLastMessage = `自动检查：发现 ${pending.length} 个云端文件，开始下载`
      const r = startDownload(config.scope)
      if (!r.started) autoLastMessage = `自动检查：跳过下载（${r.reason || '未启动'}）`
      return r.started === true
    } finally {
      autoChecking = false
    }
  }

  function progress() {
    const done = queue.filter((q) => q.state === 'done')
    const failed = queue.filter((q) => q.state === 'failed')
    return {
      phase,
      total: queue.length,
      done: done.length,
      failed: failed.length,
      current: [...currentNames],
      doneBytes: done.reduce((s, q) => s + q.size, 0),
      totalBytes: queue.reduce((s, q) => s + q.size, 0),
      startedAt,
      finishedAt,
      lastMessage,
    }
  }

  /** 按范围与扫描结果构建待下载队列。 */
  function buildQueue(scope) {
    const scan = getScan(true)
    return scan.entries
      .filter((e) => e.cloudOnly)
      .filter((e) => {
        if (scope === 'all') return e.kind === 'image' || e.kind === 'video'
        if (scope === 'image') return e.kind === 'image'
        return e.kind === 'video'
      })
      .map((e) => ({
        path: e.path, name: e.name, size: e.size, kind: e.kind,
        state: 'pending', attempts: 0,
      }))
  }

  /** 处理单项：触发回源 + 预算内轮询等待。 */
  async function processItem(item) {
    if (cancelSignal.cancelled) {
      item.state = 'skipped'
      return
    }
    item.state = 'downloading'
    item.startedAt = Date.now()
    item.attempts++

    // 已经就绪（可能是别的并发/上一批拉下来的）则直接完成。
    if (!isCloudOnlyStat(item.path)) {
      item.state = 'done'
      item.finishedAt = Date.now()
      currentNames = currentNames.filter((n) => n !== item.name)
      return
    }

    try {
      const ok = await ensureLocal(item.path, {
        budgetMs: config.perFileBudgetSec * 1000,
        signal: cancelSignal,
      })
      item.state = ok ? 'done' : 'failed'
      if (!ok) item.error = `超过 ${config.perFileBudgetSec}s 仍未下载完成`
    } catch (err) {
      item.state = 'failed'
      item.error = err instanceof Error ? err.message : String(err)
    } finally {
      item.finishedAt = Date.now()
      currentNames = currentNames.filter((n) => n !== item.name)
    }
  }

  /** 并发跑完整队列。 */
  async function runQueue() {
    phase = 'running'
    startedAt = Date.now()
    finishedAt = undefined
    lastMessage = `开始下载 ${queue.length} 个文件`

    let cursor = 0
    const workers = Array.from({ length: config.concurrency }, async () => {
      while (true) {
        if (cancelSignal.cancelled) return
        const idx = cursor++
        const item = queue[idx]
        if (!item) return
        currentNames.push(item.name)
        lastMessage = `下载中：${item.name}`
        await processItem(item)
      }
    })

    await Promise.all(workers)
    phase = cancelSignal.cancelled ? 'idle' : 'done'
    finishedAt = Date.now()
    const p = progress()
    lastMessage = cancelSignal.cancelled
      ? `已停止（完成 ${p.done}，失败 ${p.failed}）`
      : `下载结束：成功 ${p.done}，失败 ${p.failed}`
  }

  function startDownload(scope) {
    if (phase === 'running') return { started: false, total: queue.length, reason: '已有下载任务在进行中' }
    const items = buildQueue(scope)
    if (items.length === 0) return { started: false, total: 0, reason: '没有需要下载的云端文件' }
    queue = items
    cancelSignal.cancelled = false
    currentNames = []
    // 标记为 running 后再异步起跑，避免前端在 runQueue 真正执行前看到 idle 而误判。
    phase = 'running'
    startedAt = Date.now()
    finishedAt = undefined
    void runQueue()
    return { started: true, total: items.length }
  }

  function stopDownload() {
    if (phase !== 'running') return { stopped: false }
    cancelSignal.cancelled = true
    phase = 'stopping'
    return { stopped: true }
  }

  // ---- 自动下载调度 ----
  //
  // 设计要点：
  //  - 放在 Host 端而非前端：前端关掉界面就不工作了，定时器更可靠。
  //  - 只关心「还有没有云端文件」，有就启动一次下载；下载中不重复启动。
  //  - 扫描本身很便宜（只读目录元数据，不碰文件内容），但仍有 60s 的下限，
  //    避免用户把间隔配得过小导致空转。
  let autoTimer = null
  let autoLastCheck = 0
  let autoLastMessage = ''
  let kickTimer = null

  function autoTick() {
    autoTimer = null
    try {
      // 统一下载判定逻辑：发现云端文件就立刻下载。
      autoDownloadNow('timer')
    } catch (err) {
      autoLastMessage = `自动检查异常：${err instanceof Error ? err.message : String(err)}`
    } finally {
      scheduleAuto()
    }
  }

  function scheduleAuto() {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null }
    if (!config.autoStart) return
    // 空闲时用用户配置的间隔；下载进行中缩短到 15 秒，尽快接上下一批。
    const base = clamp(config.autoIntervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC) * 1000
    const delay = (phase === 'running' || phase === 'stopping')
      ? Math.min(15_000, base)
      : base
    autoTimer = setTimeout(autoTick, delay)
    if (typeof autoTimer.unref === 'function') autoTimer.unref()
  }

  /**
   * 配置变化后重排定时器。
   * 仅当「开关由关变开」或「间隔被改小」时才立即检查一次，避免单纯改间隔
   * 也触发一轮下载。注意：改间隔本身不改变「有没有云端文件」这个事实，
   * 所以重排定时器即可。
   */
  function reconfigureAuto(prevConfig) {
    const wasOn = prevConfig ? prevConfig.autoStart === true : false
    const prevInterval = prevConfig
      ? clamp(prevConfig.autoIntervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
      : undefined
    scheduleAuto()
    const turnedOn = config.autoStart && !wasOn
    const intervalChanged = config.autoStart
      && prevInterval !== undefined
      && config.autoIntervalSec !== prevInterval
    if (turnedOn || intervalChanged) scheduleKick('reconfigure')
  }

  // 启动时若已开启自动下载，立即排一次；并立刻检测一轮（不必等一个间隔）。
  scheduleAuto()
  if (config.autoStart) scheduleKick('startup')

  // 插件卸载时清掉定时器，避免泄漏。
  ctx.on('dispose', () => {
    if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null }
    if (kickTimer !== null) { clearTimeout(kickTimer); kickTimer = null }
  })

  // ---- HTTP 端点 ----
  function sendJson(res, code, body) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let raw = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1_000_000) { req.destroy(); resolve({}); return }
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}) }
        catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  /**
   * 把 URL 里的相对路径解析为绝对路径，并确保它确实位于照片目录内。
   * 防止通过 ../ 逃逸出照片库读取任意文件。
   */
  function safeResolve(rel) {
    if (typeof rel !== 'string' || rel.length === 0) return null
    // 拒绝绝对路径与协议前缀
    if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null
    if (rel.includes('..')) return null
    const base = resolve(config.photosDir)
    const full = resolve(base, rel)
    // 必须仍在 base 之下（加分隔符避免 /photos-evil 绕过）
    if (full !== base && !full.startsWith(base + sep)) return null
    if (!existsSync(full)) return null
    return full
  }

  /** 发送二进制内容；extra 会并入响应头。 */
  function sendBinary(res, code, buf, mime, extra) {
    const headers = {
      'content-type': mime,
      'content-length': String(buf.length),
      'cache-control': 'private, max-age=300',
    }
    if (extra) Object.assign(headers, extra)
    res.writeHead(code, headers)
    res.end(buf)
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer

    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
        const method = (req.method ?? 'GET').toUpperCase()

        try {
          // GET /status — 扫描结果 + 进度
          if (sub === '/status' && method === 'GET') {
            const force = url.searchParams.get('force') === '1'
            const scan = getScan(force)
            return sendJson(res, 200, {
              ok: true,
              config: {
                photosDir: config.photosDir,
                scope: config.scope,
                perFileBudgetSec: config.perFileBudgetSec,
                concurrency: config.concurrency,
                autoStart: config.autoStart,
                autoIntervalSec: config.autoIntervalSec,
              },
              scan: {
                root: scan.root, ok: scan.ok, error: scan.error,
                summary: scan.summary, scannedAt: scan.scannedAt,
                // 只回传云端文件清单，避免 payload 过大
                cloudFiles: scan.entries
                  .filter((e) => e.cloudOnly)
                  .map((e) => ({ name: e.name, size: e.size, kind: e.kind })),
              },
              progress: progress(),
              auto: {
                enabled: config.autoStart,
                intervalSec: config.autoIntervalSec,
                lastCheckAt: autoLastCheck || undefined,
                lastMessage: autoLastMessage || undefined,
              },
            })
          }

          // POST /scan — 强制重扫
          if (sub === '/scan' && method === 'POST') {
            const scan = getScan(true)
            return sendJson(res, 200, {
              ok: true,
              scan: { root: scan.root, ok: scan.ok, error: scan.error, summary: scan.summary, scannedAt: scan.scannedAt },
            })
          }

          // POST /download — 启动下载
          if (sub === '/download' && method === 'POST') {            const body = await readBody(req)
            const scope = (body.scope === 'image' || body.scope === 'video') ? body.scope : config.scope
            const r = startDownload(scope)
            return sendJson(res, 200, { ok: r.started, ...r })
          }

          // POST /stop — 停止下载
          if (sub === '/stop' && method === 'POST') {
            const r = stopDownload()
            return sendJson(res, 200, { ok: true, ...r })
          }

          // GET /config — 读配置
          if (sub === '/config' && method === 'GET') {
            return sendJson(res, 200, { ok: true, config: readConfig() })
          }

          // POST /config — 写配置
          if (sub === '/config' && method === 'POST') {
            const body = await readBody(req)
            const prev = { ...config }
            const next = { ...readConfig(), ...body }
            writeConfig(next)
            config = resolveConfig(next)
            lastScan = null
            // 开关或间隔变了，立刻重排自动调度（传入旧配置以判断是否需立即检查）。
            reconfigureAuto(prev)
            return sendJson(res, 200, { ok: true, config: next, effective: config })
          }

          // GET /items — 可预览文件清单（含绝对路径标识用相对路径）
          if (sub === '/items' && method === 'GET') {
            const scan = getScan(url.searchParams.get('force') === '1')
            const base = resolve(config.photosDir)
            const rootLen = base.length + 1
            const items = scan.entries.map((e) => ({
              name: e.name,
              // 相对路径是前端引用的唯一标识（避免暴露/传递绝对路径）
              rel: e.path.length > rootLen ? e.path.slice(rootLen).replace(/\\/g, '/') : e.name,
              size: e.size,
              kind: e.kind,
              cloudOnly: e.cloudOnly,
              mtimeMs: e.mtimeMs,
            }))
            return sendJson(res, 200, {
              ok: true,
              root: scan.root,
              ok2: scan.ok,
              scannedAt: scan.scannedAt,
              items,
              thumbSupported: true,
              ffmpeg: resolveFfmpeg(),
              thumbCache: cacheDir(),
            })
          }

          // GET /thumb — 缩略图
          if (sub === '/thumb' && method === 'GET') {
            const rel = url.searchParams.get('p')
            const size = Math.min(1600, Math.max(80, Number(url.searchParams.get('s')) || 400))
            const full = safeResolve(rel)
            if (!full) return sendJson(res, 404, { ok: false, error: '文件不存在或路径非法' })
            const r = await getThumbnail(full, size)
            if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            const buf = await readFile(r.path)
            // 附带尺寸响应头，供前端「按照片尺寸」排版，省一次往返。
            const extra = {}
            if (r.width > 0) extra['x-thumb-w'] = String(r.width)
            if (r.height > 0) extra['x-thumb-h'] = String(r.height)
            return sendBinary(res, 200, buf, r.mime, extra)
          }

          // GET /sizes — 批量探测原始尺寸（供「按照片尺寸」模式预排布）
          if (sub === '/sizes' && method === 'GET') {
            // 强制扫描：本端点通常在切到「按照片尺寸」时首次调用，
            // 此时缓存可能还没建立（拿到空列表就会返回 0 个）。
            const scan = getScan(true)
            const base = resolve(config.photosDir)
            const rootLen = base.length + 1
            const out = {}
            for (const e of scan.entries) {
              // 只探测图片；视频统一按 16:9 摆放（抽帧尺寸无参考价值且更慢）
              if (e.kind !== 'image') continue
              const rel = e.path.length > rootLen ? e.path.slice(rootLen).replace(/\\/g, '/') : e.name
              // 注意 probeSize 是 async，必须 await（漏掉会拿到 Promise，width 恒为 undefined）。
              let size = await probeSize(e.path)
              // probeSize 只认 JPEG/PNG；HEIC 等先取缩略图再读它的尺寸。
              if (!size || size.width === 0) {
                try {
                  const r = await getThumbnail(e.path, 320)
                  if (r.ok && r.width > 0) size = { width: r.width, height: r.height }
                } catch { /* 跳过 */ }
              }
              if (size && size.width > 0) out[rel] = { w: size.width, h: size.height }
            }
            return sendJson(res, 200, { ok: true, sizes: out })
          }

          // GET /original — 原图字节（预览大图 / 复制到剪贴板）
          // HEAD 也走这里：Chromium 系播放视频前会先发 HEAD 探测大小与 Accept-Ranges，
          // 只认 GET 会让 HEAD 落到 404，浏览器遂判定该资源不可随机访问 → 进度条拖不动。
          if (sub === '/original' && (method === 'GET' || method === 'HEAD')) {
            const rel = url.searchParams.get('p')
            const full = safeResolve(rel)
            if (!full) return sendJson(res, 404, { ok: false, error: '文件不存在或路径非法' })
            try {
              const st = statSync(full)
              const mime = guessMime(full)
              const total = st.size

              // HEAD：只回头，不回 body。
              if (method === 'HEAD') {
                res.writeHead(200, {
                  'content-type': mime,
                  'content-length': String(total),
                  'accept-ranges': 'bytes',
                  'cache-control': 'private, max-age=300',
                })
                return res.end()
              }

              // 视频播放必须支持 Range：否则无法拖动进度条，部分浏览器干脆不播。
              const range = req.headers?.range
              if (typeof range === 'string' && /^bytes=/.test(range)) {
                // 注意：这里只匹配「0-999」这种范围串（bytes= 前缀已由上面的检查消费）。
                const m = /^(\d*)-(\d*)$/.exec(range.slice(6).trim())
                if (m) {
                  let start = m[1] === '' ? undefined : Number(m[1])
                  let end = m[2] === '' ? undefined : Number(m[2])
                  if (start === undefined && end !== undefined) {
                    // bytes=-N：最后 N 字节
                    start = Math.max(0, total - end)
                    end = total - 1
                  } else {
                    if (start === undefined) start = 0
                    if (end === undefined || end >= total) end = total - 1
                  }
                  if (start > end || start >= total) {
                    res.writeHead(416, { 'content-range': `bytes */${total}` })
                    return res.end()
                  }
                  const chunk = end - start + 1
                  res.writeHead(206, {
                    'content-type': mime,
                    'content-length': String(chunk),
                    'content-range': `bytes ${start}-${end}/${total}`,
                    'accept-ranges': 'bytes',
                    'cache-control': 'private, max-age=300',
                  })
                  // 只读请求的那一段（视频拖动时通常只有几十 KB），避免整文件入内存。
                  // 不用 stream.pipe：宿主给到的 res 未必实现完整的 Writable 接口。
                  const { open } = await import('node:fs/promises')
                  const fh = await open(full, 'r')
                  try {
                    const buf = Buffer.alloc(chunk)
                    await fh.read(buf, 0, chunk, start)
                    res.end(buf)
                  } finally {
                    await fh.close().catch(() => {})
                  }
                  return
                }
              }

              // 无 Range 的完整请求：统一整块读出后返回。
              // 之所以不像常见做法那样 pipe 流：宿主给到的 res 未必实现完整的
              // Writable 接口（实测缺 on/once），pipe 会抛 dest.on is not a function。
              const buf = await readFile(full)
              return sendBinary(res, 200, buf, mime, { 'accept-ranges': 'bytes' })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          }

          return sendJson(res, 404, { ok: false, error: `未知端点: ${method} ${sub}` })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    })
  })
}

export { scanDirectory, ensureLocal, isCloudOnlyStat }
