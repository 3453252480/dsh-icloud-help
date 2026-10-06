/**
 * iCloud Windows Help — browser half（宿主模块格式）。
 *
 * 宿主通过 window.__ModuleLoader__.load 加载，工厂函数内使用 CJS require。
 * 注册一个 `settings.section` 条目（导航名「iCloud 照片」，order 25），
 * 渲染照片库云端/本地分布与下载控制面板；数据来自 Host 端 HTTP 端点。
 */

window.__ModuleLoader__.load({
  id: 'dsh-icloud-help',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')

    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = react

    const API = '/api/icloud-help'

    /** 字节数格式化。 */
    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
    }

    /** 时间展示。 */
    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const p = (x) => String(x).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    /** 统计小卡片。 */
    function Stat(props) {
      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '12px 14px',
          background: props.accent ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          // 固定最小高度 + 纵向排布：无论有无副标题，卡片高度都一致
          display: 'flex', flexDirection: 'column', minHeight: 86,
          // 固定 4 列时可能被压窄：允许收缩，内容用省略号，不撑破格子。
          minWidth: 0, overflow: 'hidden',
        },
      },
      h('div', {
        style: {
          fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        title: props.label,
      }, props.label),
      h('div', {
        style: {
          fontSize: 20, fontWeight: 600, marginTop: 6,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, props.value),
      h('div', {
        style: {
          fontSize: 12, marginTop: 2, color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, props.sub || '\u00A0'))
    }

    /** 主面板组件。 */
    // ==== 照片预览子组件（内联，宿主模块不支持跨文件 import）====
  /** 单个缩略图格子：进入可视区后才加载。 */
  function Thumb(props) {
    const { item, size, bySize, aspect, onOpen, onMenu } = props
    const ref = useRef(null)
    const [src, setSrc] = useState(null)
    const [failed, setFailed] = useState(false)
    const [visible, setVisible] = useState(false)

    // 懒加载：只有真正进入视口才请求缩略图。
    useEffect(() => {
      const el = ref.current
      if (!el || visible) return
      if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { setVisible(true); io.disconnect(); return }
        }
      }, { rootMargin: '300px 0px' })
      io.observe(el)
      return () => io.disconnect()
    }, [visible])

    useEffect(() => {
      if (!visible) return
      // 缩略图长边按格子尺寸的 2 倍取，兼顾清晰度与体积。
      const want = Math.min(800, Math.max(160, Math.round(size * 2)))
      setSrc(`${API}/thumb?p=${encodeURIComponent(item.rel)}&s=${want}`)
    }, [visible, size, item.rel])

    const shellStyle = {
      position: 'relative', overflow: 'hidden', borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)',
      cursor: 'pointer',
      // bySize=true（按照片尺寸）：用真实宽高比（aspect 由父级算好传入）；
      // bySize=false（默认）：统一 1:1 方格。
      aspectRatio: bySize ? (aspect || '4 / 3') : '1 / 1',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }

    // 关键：contain 而非 cover。cover 会把长图/聊天截图裁掉大半
    // （「显示不完整」就是这个）。contain 保证整张可见，四周留白。
    const imgStyle = {
      width: '100%', height: '100%',
      objectFit: bySize ? 'contain' : 'cover',
      display: 'block',
    }

    return h('div', {
      ref,
      style: shellStyle,
      title: `${item.name}\n${fmtBytes(item.size)}${item.cloudOnly ? '（仅云端）' : ''}`,
      onClick: () => onOpen(item),
      onContextMenu: (ev) => { ev.preventDefault(); onMenu(ev, item) },
    },
    src && !failed
      ? h('img', {
        src,
        loading: 'lazy',
        draggable: false,
        onError: () => setFailed(true),
        style: imgStyle,
      })
      : h('div', {
        style: {
          fontSize: 11, padding: 8, textAlign: 'center', wordBreak: 'break-all',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, failed ? '无法预览' : (visible ? '加载中…' : '')),

    // 视频角标
    item.kind === 'video'
      ? h('span', {
        style: {
          position: 'absolute', left: 6, bottom: 6, padding: '1px 6px', borderRadius: 4,
          fontSize: 10, background: 'rgba(0,0,0,.62)', color: '#fff',
        },
      }, '视频')
      : null,

    // 云端角标
    item.cloudOnly
      ? h('span', {
        style: {
          position: 'absolute', right: 6, top: 6, padding: '1px 6px', borderRadius: 4,
          fontSize: 10, background: 'rgba(255,159,10,.92)', color: '#111',
        },
      }, '云端')
      : null)
  }

  /** 右键菜单。 */
  function ContextMenu(props) {
    const { state, onClose } = props
    const ref = useRef(null)

    useEffect(() => {
      if (!state) return
      const onDown = (ev) => {
        if (ref.current && ev.composedPath && ev.composedPath().includes(ref.current)) return
        onClose()
      }
      const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('keydown', onKey)
      return () => {
        window.removeEventListener('pointerdown', onDown, true)
        window.removeEventListener('keydown', onKey)
      }
    }, [state, onClose])

    if (!state) return null
    const { x, y, item } = state

    const rawItems = state.entries || []
    // 先按当前项过滤掉 hideFor 命中的条目（如视频时隐藏重复的「复制完整路径」）。
    const kept = rawItems.filter((it) => !(it.hideFor && it.hideFor(item)))
    // 再合并相邻/首尾多余的分隔线，避免隐藏后出现双线或开头就是线。
    const items = kept.filter((it, i) => {
      if (!it.sep) return true
      const prev = kept[i - 1]
      const next = kept[i + 1]
      if (i === 0 || i === kept.length - 1) return false
      return !(prev && prev.sep) && !(next && next.sep)
    })
    return h('div', {
      ref,
      style: {
        position: 'fixed', left: Math.min(x, window.innerWidth - 230), top: y,
        minWidth: 210, padding: 4, zIndex: 99999, borderRadius: 10,
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        border: '1px solid var(--dsw-alias-border-l3)',
        boxShadow: '0 10px 30px rgba(0,0,0,.28)',
        fontSize: 13,
      },
    },
    items.map((it, i) => it.sep
      ? h('div', { key: 'sep' + i, style: { height: 1, margin: '4px 2px', background: 'var(--dsw-alias-border-l2)' } })
      : h('button', {
        // label 允许是函数：按当前右键的这一项求值（如「复制图片/复制视频路径」）。
        key: typeof it.label === 'function' ? it.key : it.label,
        onClick: () => it.run(item),
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
          border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13,
          background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)' },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      }, typeof it.label === 'function' ? it.label(item) : it.label)))
  }

  /** 大图灯箱。 */
  function Lightbox(props) {
    const { item, onClose } = props
    const videoRef = useRef(null)
    const [videoError, setVideoError] = useState(null)

    useEffect(() => {
      if (!item) return
      const onKey = (e) => { if (e.key === 'Escape') onClose() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [item, onClose])

    // 切换文件时重置播放错误。
    useEffect(() => { setVideoError(null) }, [item && item.rel])

    if (!item) return null
    const isVideo = item.kind === 'video'

    // 图片：HEIC 原图浏览器未必能显示，用大尺寸缩略图。
    // 视频：走 /original 直接流播放，浏览器原生支持 mp4/mov(H.264)。
    const src = isVideo
      ? `${API}/original?p=${encodeURIComponent(item.rel)}`
      : `${API}/thumb?p=${encodeURIComponent(item.rel)}&s=1600`

    return h('div', {
      // 只在「点到遮罩本身」时关闭：用 target === currentTarget 判断，而不是靠子元素
      // 冒泡时逐层 stopPropagation。原因是原生 <video controls> 的进度条拖拽会跨越
      // 指针移出视频区域，冒泡上来的 click 会误触关闭，表现成「进度条拖不动」。
      onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      style: {
        position: 'fixed', inset: 0, zIndex: 99998, display: 'flex',
        alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12,
        background: 'rgba(0,0,0,.82)', cursor: 'zoom-out',
      },
    },
    isVideo
      ? h('video', {
        ref: videoRef,
        // 换视频时强制重建元素：否则 React 复用同一 DOM 节点，src 变了但
        // 已缓冲的元数据/时长仍是旧值，进度条会用错范围而拖不动。
        key: item.rel,
        src,
        controls: true,
        // 不用 autoPlay：自动播放中的视频在部分浏览器里拖动进度条会被打断。
        autoPlay: false,
        playsInline: true,
        // 用 metadata 之外再设 defaultPlaybackRate 无用；关键是允许 seek 前拿到时长。
        preload: 'metadata',
        onError: () => setVideoError('这个视频编码浏览器无法直接播放（可能是 HEVC/H.265）。可右键「复制完整路径」后用系统播放器打开。'),
        // 视频区域内让事件不再冒到遮罩，保护原生控件（含进度条）的交互。
        // 只拦 click/pointerdown：拖动过程中 pointermove 会在控件与遮罩间穿梭，
        // 拦它会干扰原生进度条，交给 target === currentTarget 判断即可。
        onClick: (e) => e.stopPropagation(),
        onPointerDown: (e) => e.stopPropagation(),
        style: {
          maxWidth: '92vw', maxHeight: '82vh', borderRadius: 8,
          boxShadow: '0 20px 60px rgba(0,0,0,.5)', background: '#000',
        },
      })
      : h('img', {
        src, style: { maxWidth: '92vw', maxHeight: '88vh', borderRadius: 8, boxShadow: '0 20px 60px rgba(0,0,0,.5)' },
        onClick: (e) => e.stopPropagation(),
      }),

    videoError
      ? h('div', {
        onClick: (e) => e.stopPropagation(),
        style: {
          maxWidth: '80vw', padding: '10px 14px', borderRadius: 8, fontSize: 12,
          background: 'rgba(220,53,69,.9)', color: '#fff', textAlign: 'center', lineHeight: 1.5,
        },
      }, videoError)
      : null,

    h('div', {
      onClick: (e) => e.stopPropagation(),
      style: {
        color: '#fff', fontSize: 13, textAlign: 'center',
        textShadow: '0 1px 3px rgba(0,0,0,.8)',
      },
    }, `${item.name} · ${fmtBytes(item.size)}${isVideo ? ' · 视频' : ''}`),

    h('div', {
      style: { color: 'rgba(255,255,255,.55)', fontSize: 11 },
    }, '点击空白处或按 Esc 关闭'))
  }

  /** 预览主面板。 */
  function PhotoPreview() {
    const [items, setItems] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [cols, setCols] = useState(4)
    // bySize=true → 按照片原始宽高比排布；默认 false → 统一方格。
    // 注意语义方向：勾选框「按照片尺寸显示」勾上 = bySize=true，
    // 即渲染真实比例、图片用 contain 完整显示。
    const [bySize, setBySize] = useState(false)
    const [filter, setFilter] = useState('all')   // all | image | video
    const [menu, setMenu] = useState(null)
    const [lightbox, setLightbox] = useState(null)
    const [toast, setToast] = useState(null)
    // 图片真实宽高（「按照片尺寸」模式用），按需加载、加载一次即缓存。
    const [sizes, setSizes] = useState({})
    const sizesLoaded = useRef(false)
    // 照片目录绝对路径（供「复制完整路径」拼出可直接用的路径）。
    const [apiRoot, setApiRoot] = useState('')

    const gridRef = useRef(null)
    const [gridW, setGridW] = useState(900)

    const load = useCallback(async () => {
      try {
        const r = await fetch(`${API}/items`, { cache: 'no-store' })
        const j = await r.json()
        if (!j.ok) throw new Error(j.error || '读取失败')
        setItems(j.items || [])
        setApiRoot(j.root || '')
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally { setLoading(false) }
    }, [])

    // 首次勾选「按照片尺寸显示」时才拉尺寸，避免默认方格模式下白拉一遍。
    useEffect(() => {
      if (!bySize || sizesLoaded.current) return
      sizesLoaded.current = true
      void (async () => {
        try {
          const r = await fetch(`${API}/sizes`, { cache: 'no-store' })
          const j = await r.json()
          if (j.ok) setSizes(j.sizes || {})
        } catch { /* 失败则退回默认比例 */ }
      })()
    }, [bySize])

    useEffect(() => { void load() }, [load])

    // 测量网格宽度，用于按列数算格子尺寸。
    useEffect(() => {
      const el = gridRef.current
      if (!el) return
      const measure = () => setGridW(el.clientWidth || 900)
      measure()
      if (typeof ResizeObserver === 'undefined') return
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    const shown = useMemo(
      () => items.filter((i) => filter === 'all' ? true : i.kind === filter),
      [items, filter],
    )

    const gap = 10
    const cell = Math.max(48, Math.floor((gridW - gap * (cols - 1)) / cols))

    const flash = useCallback((msg) => {
      setToast(msg)
      window.setTimeout(() => setToast(null), 2400)
    }, [])

    const copyImage = useCallback(async (item) => {
      // 点击后立刻关掉右键菜单，不让它干等着下面的取图 + 转码 + 写剪贴板。
      // 复制在后台继续跑；失败时没有菜单可挂 toast，回退到页面级轻提示。
      setMenu(null)
      try {
        const r = await fetch(`${API}/original?p=${encodeURIComponent(item.rel)}`)
        if (!r.ok) throw new Error(`读取原图失败 (${r.status})`)
        const blob = await r.blob()
        // 剪贴板 API 只接受 PNG 等有限格式；统一转成 PNG 再写。
        const png = await toPngBlob(blob, `${API}/thumb?p=${encodeURIComponent(item.rel)}&s=1600`)
        if (!navigator.clipboard || !window.ClipboardItem) {
          throw new Error('当前环境不支持写图片到剪贴板（需 HTTPS/localhost 与新版浏览器）')
        }
        await navigator.clipboard.write([new window.ClipboardItem({ [png.type || 'image/png']: png })])
      } catch (e) {
        flash('❌ ' + (e instanceof Error ? e.message : String(e)))
      }
    }, [flash])

    const copyText = useCallback(async (text) => {
      // 与复制图片一致：先关菜单，写剪贴板在后台完成。
      setMenu(null)
      try {
        await navigator.clipboard.writeText(text)
      } catch (e) {
        flash('❌ 复制失败')
      }
    }, [flash])

    const menuEntries = useMemo(() => [
      {
        key: 'copy-image',
        // 图片：把图写进剪贴板，可直接粘贴到对话。
        // 视频：浏览器剪贴板 API 写不了视频文件，改复制完整路径，方便去系统播放器打开。
        label: (it) => (it && it.kind === 'video' ? '复制视频路径' : '复制图片'),
        run: (it) => {
          if (it && it.kind === 'video') { void copyText(it.abs || it.rel) } else { void copyImage(it) }
        },
      },
      { sep: true },
      { key: 'copy-name', label: '复制文件名', run: (it) => { void copyText(it.name) } },
      {
        key: 'copy-path',
        // 视频时上面那项已经是「复制视频路径」，这里隐藏以免重复。
        label: '复制完整路径',
        hideFor: (it) => !!(it && it.kind === 'video'),
        run: (it) => { void copyText(it.abs || it.rel) },
      },
      { sep: true },
      {
        key: 'open',
        label: (it) => (it && it.kind === 'video' ? '查看视频' : '查看大图'),
        run: (it) => { setMenu(null); setLightbox(it) },
      },
    ], [copyImage, copyText])

    return h('section', {
      style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 },
    },
    // 标题行
    h('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    },
    h('div', { style: { fontSize: 13, fontWeight: 600 } },
      `照片预览（${shown.length}${filter === 'all' ? '' : ' / ' + items.length}）`),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      // 类型筛选
      ['all', 'image', 'video'].map((k) => h('button', {
        key: k,
        onClick: () => setFilter(k),
        style: {
          padding: '4px 10px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: filter === k ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          fontWeight: filter === k ? 600 : 400,
        },
      }, k === 'all' ? '全部' : k === 'image' ? '图片' : '视频')),
      // 按尺寸开关（整块可点，含文字与方块）
      h('label', {
        onClick: () => setBySize(!bySize),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
          // 与相邻按钮（padding 4px 10px）视觉高度对齐。
          padding: '4px 8px', borderRadius: 7, lineHeight: 1,
          userSelect: 'none',
        },
        title: '开启：每张按原始宽高比排布（高度不一）；关闭：统一方形格子',
      },
      // 自绘复选框：原生 input 的勾选标记在不同缩放下容易偏移，
      // 这里用 span 精确居中（flex 居中 + 对勾用 SVG 绝对定位）。
      h('span', {
        style: {
          width: 15, height: 15, borderRadius: 4, flex: '0 0 auto',
          border: bySize
            ? '1px solid var(--dsw-alias-button-primary-fill, #0066cc)'
            : '1px solid var(--dsw-alias-border-l3)',
          background: bySize ? 'var(--dsw-alias-button-primary-fill, #0066cc)' : 'transparent',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background .15s, border-color .15s',
        },
      }, bySize
        ? h('svg', {
          width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none',
          // 对勾用 display block 去掉 svg 基线间隙，保证在容器里真正居中。
          style: { display: 'block' },
        }, h('path', {
          d: 'M2 6.2 L4.8 9 L10 3.4',
          stroke: 'var(--dsw-alias-label-primary-foreground, #fff)',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
        : null),
      '按照片尺寸显示'),
      h('button', {
        onClick: () => { setLoading(true); void load() },
        style: {
          padding: '4px 10px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, '刷新'))),

    // 列数滑块
    h('div', {
      style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    },
    h('span', null, '列数'),
    h('input', {
      type: 'range', min: 1, max: 8, step: 1, value: cols,
      onChange: (e) => setCols(Number(e.target.value)),
      style: { flex: '1 1 auto', maxWidth: 300 },
    }),
    h('span', { style: { minWidth: 30, fontVariantNumeric: 'tabular-nums' } }, `${cols} 列`)),

    error
      ? h('div', {
        style: { padding: '10px 12px', borderRadius: 8, fontSize: 13, background: 'rgba(220,53,69,.10)', color: '#dc3545' },
      }, `读取失败：${error}`)
      : null,

    loading
      ? h('div', { style: { padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '加载中…')
      : null,

    // 网格
    !loading && shown.length > 0
      ? h('div', {
        ref: gridRef,
        style: {
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap,
          // 方格模式每格等高（stretch）；按尺寸模式各格高矮不一（start）。
          alignItems: bySize ? 'start' : 'stretch',
        },
      },
      shown.map((it) => {
        // 仅「按照片尺寸」模式需要算真实宽高比；方格模式由 aspectRatio:1/1 接管。
        let aspect
        if (bySize) {
          const sz = sizes[it.rel]
          if (sz && sz.w > 0 && sz.h > 0) {
            // 限制极端比例，避免超长截图把一行撑得离谱。
            const ratio = sz.w / sz.h
            const clamped = Math.min(2.5, Math.max(0.4, ratio))
            aspect = `${clamped} / 1`
          } else if (it.kind === 'video') {
            aspect = '16 / 9'
          } else {
            aspect = '4 / 3'
          }
        }
        return h(Thumb, {
          key: it.rel, item: it, size: cell, bySize, aspect,
          onOpen: setLightbox,
          onMenu: (ev, item) => {
            setMenu({
              x: ev.clientX, y: ev.clientY,
              item: { ...item, abs: `${apiRoot}/${item.rel}` },
              entries: menuEntries,
            })
          },
        })
      }))
      : null,

    !loading && shown.length === 0
      ? h('div', { style: { padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
        items.length === 0 ? '照片目录里没有可预览的文件' : '当前筛选下没有文件')
      : null,

    h(ContextMenu, { state: menu, onClose: () => setMenu(null) }),
    h(Lightbox, { item: lightbox, onClose: () => setLightbox(null) }),

    // 轻提示
    toast
      ? h('div', {
        style: {
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          padding: '8px 16px', borderRadius: 10, fontSize: 13, zIndex: 100000,
          background: 'var(--dsw-alias-bg-overlay, #333)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l3)', boxShadow: '0 6px 20px rgba(0,0,0,.3)',
        },
      }, toast)
      : null)
  }

  /**
   * 把任意图片 blob 转成 PNG（剪贴板只接受 PNG 等少数格式）。
   * 用 canvas 重绘；失败时回退到缩略图（已是 JPEG，仍需转 PNG）。
   */
  async function toPngBlob(blob, fallbackUrl) {
    try {
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')
      ctx.drawImage(bmp, 0, 0)
      const out = await new Promise((res) => c.toBlob(res, 'image/png'))
      if (out) return out
    } catch { /* 回退 */ }
    const r = await fetch(fallbackUrl)
    const b2 = await r.blob()
    const bmp2 = await createImageBitmap(b2)
    const c2 = document.createElement('canvas')
    c2.width = bmp2.width
    c2.height = bmp2.height
    c2.getContext('2d').drawImage(bmp2, 0, 0)
    return await new Promise((res) => c2.toBlob(res, 'image/png'))
  }
    function IcloudHelpSection() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [autoOn, setAutoOn] = useState(false)
      // 自动检查间隔，UI 单位是分钟（内部换算成秒存盘）。
      const [intervalMin, setIntervalMin] = useState(5)
      // 输入框里正在编辑的文本。允许中途是空串/半截数字，失焦或回车才提交。
      const [intervalText, setIntervalText] = useState('5')
      const timer = useRef(null)
      // 用户正在编辑间隔输入框时，轮询刷新不要回写输入框文本。
      const editingIntervalRef = useRef(false)

      /** 秒 → 分钟。非整数分钟保留一位小数（如 90 秒 → 1.5 分钟）。 */
      const secToMin = (sec) => {
        const n = Number(sec)
        if (!Number.isFinite(n) || n <= 0) return 5
        const m = n / 60
        return Number.isInteger(m) ? m : Math.round(m * 10) / 10
      }

      /** 分钟 → 秒，并夹到后端一致的边界（10 秒 ~ 24 小时）。 */
      const minToSec = (min) => {
        const n = Number(min)
        if (!Number.isFinite(n) || n <= 0) return 300
        return Math.min(86_400, Math.max(10, Math.round(n * 60)))
      }

      const refresh = useCallback(async (force) => {
        try {
          const r = await fetch(`${API}/status${force ? '?force=1' : ''}`, { cache: 'no-store' })
          const data = await r.json()
          setStatus(data)
          setError(null)
          if (data && data.config) {
            setAutoOn(data.config.autoStart === true)
            const sec = Number(data.config.autoIntervalSec)
            if (Number.isFinite(sec) && sec > 0) {
              const m = secToMin(sec)
              setIntervalMin(m)
              // 只在用户没在编辑时覆盖输入框，避免打字被打断。
              if (!editingIntervalRef.current) setIntervalText(String(m))
            }
          }
          return data
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          return null
        }
      }, [])

      // 用 ref 持有最新的一次刷新函数，避免轮询闭包捕获旧状态。
      const refreshRef = useRef(refresh)
      refreshRef.current = refresh

      // 统一轮询：单一循环，间隔由「是否在下载」决定。
      // 关键点：驱动间隔的 running 取自 ref 里的最新数据，而不是闭包里的 status，
      // 否则 phase 变化时不会重建 timer，会一直用旧间隔（原来「下完仍显示 5 个」
      // 的观感就来自这里：结束那一刻的刷新撞上 Host 端 3s 扫描缓存，拿到旧快照后
      // timer 再不触发新的请求）。
      // 再一个关键点：空闲态间隔是 5s，点「开始下载」后若只 await 一次 refresh，
      // 手动刷新拿到的是缓存快照，且下一轮 tick 仍要干等 5s，观感就是「点了没反应」。
      // 所以额外准备一个 kick：取消当前等待、立刻 tick，并强制跳过缓存。
      const runningRef = useRef(false)
      // 置 true 表示下一轮 tick 要带 force=1（跳过后端 3s 扫描 TTL）。
      const forceRef = useRef(false)
      // 由 useEffect 挂上的「立刻重跑一轮」入口；未挂载时为 null。
      const refreshKickRef = useRef(null)
      // 防并发闸门：tick 正在 await 时不允许再起一条，否则会并存两条定时器链。
      const tickingRef = useRef(false)
      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (cancelled || tickingRef.current) return
          tickingRef.current = true
          try {
            const force = forceRef.current
            forceRef.current = false
            const data = await refreshRef.current(force)
            if (cancelled) return
            const ph = data && data.progress ? data.progress.phase : 'idle'
            const isRunning = ph === 'running' || ph === 'stopping'
            // 刚从「下载中」落到结束：立刻补一次强制扫描，跳过后端 TTL 缓存。
            if (runningRef.current && !isRunning) {
              await refreshRef.current(true)
              if (cancelled) return
            }
            runningRef.current = isRunning
            if (cancelled) return
            timer.current = window.setTimeout(tick, isRunning ? 1200 : 5000)
          } finally {
            tickingRef.current = false
          }
        }
        // 立刻重跑一轮：清掉待触发的定时器（若有）后直接 tick，并带上 force。
        // 若此刻 tick 正在 await，则由它跑完后自行排下一轮（force 已置位），
        // 这里不重复起链。
        refreshKickRef.current = (force) => {
          if (force !== false) forceRef.current = true
          if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
          if (!tickingRef.current) void tick()
        }
        void tick()
        return () => {
          cancelled = true
          refreshKickRef.current = null
          if (timer.current !== null) window.clearTimeout(timer.current)
        }
      }, [])

      const startDownload = useCallback(async () => {
        setBusy(true)
        try {
          await fetch(`${API}/download`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: 'all' }),
          })
          runningRef.current = true
          // 点完立刻刷下边的进度区：kick 会取消等待中的定时器并带 force 重跑一轮
          // （跳过后端扫描 TTL）。若此刻正有一轮在跑，则它跑完后按 force 再跑一次。
          // 这里不再额外 await refresh()，避免与轮询重叠成两次请求、界面闪一下。
          if (refreshKickRef.current) refreshKickRef.current(true)
        } finally { setBusy(false) }
      }, [])

      const stopDownload = useCallback(async () => {
        setBusy(true)
        try {
          await fetch(`${API}/stop`, { method: 'POST' })
          // 与开始下载一致：kick 一轮，让下边状态马上切回来。
          if (refreshKickRef.current) refreshKickRef.current(true)
        } finally { setBusy(false) }
      }, [])

      const setAuto = useCallback(async (v) => {
        setAutoOn(v)
        await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoStart: v }),
        })
        await refresh(false)
      }, [refresh])

      /**
       * 提交间隔（分钟）。空值/非法值回退到当前生效值，不写库。
       * 成功后用后端回传的 effective 值回填，保证界面与真实生效值一致
       * （比如填 0.05 分钟会被后端夹到 10 秒 → 界面显示 0.2）。
       */
      const commitInterval = useCallback(async (rawText) => {
        const text = String(rawText ?? '').trim()
        const min = Number(text)
        if (text === '' || !Number.isFinite(min) || min <= 0) {
          setIntervalText(String(intervalMin))
          return
        }
        const sec = minToSec(min)
        try {
          const r = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoIntervalSec: sec }),
          })
          const data = await r.json()
          const applied = Number(data && data.effective && data.effective.autoIntervalSec)
          const finalSec = Number.isFinite(applied) && applied > 0 ? applied : sec
          const m = secToMin(finalSec)
          setIntervalMin(m)
          setIntervalText(String(m))
        } catch {
          setIntervalText(String(intervalMin))
        }
        await refresh(false)
      }, [intervalMin, refresh])

      const scan = status ? status.scan : undefined
      const prog = status ? status.progress : undefined
      const running = prog && (prog.phase === 'running' || prog.phase === 'stopping')

      const pct = useMemo(() => {
        if (!prog || prog.total === 0) return 0
        return Math.round(((prog.done + prog.failed) / prog.total) * 100)
      }, [prog])

      const children = []

      // 头部
      children.push(h('header', {
        key: 'head',
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
      },
      h('div', null,
        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, 'iCloud 照片助手'),
        h('p', { style: { margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          '查看照片库里哪些文件仅在云端，并一键下载到本地。')),
      h('button', {
        onClick: () => { void refresh(true) },
        disabled: busy,
        style: {
          flex: '0 0 auto', padding: '6px 14px', fontSize: 13, borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
          background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        },
      }, '重新扫描')))

      if (error) {
        children.push(h('div', {
          key: 'err',
          style: { padding: '10px 12px', borderRadius: 8, fontSize: 13, background: 'rgba(220,53,69,.10)', color: '#dc3545' },
        }, `读取失败：${error}`))
      }

      if (scan) {
        children.push(h('div', {
          key: 'dir',
          style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
        },
        `目录：${scan.root}`,
        h('br'),
        `扫描于 ${fmtTime(scan.scannedAt)}`))
      }

      if (scan && !scan.ok) {
        children.push(h('div', {
          key: 'scanerr',
          style: { padding: '10px 12px', borderRadius: 8, fontSize: 13, background: 'rgba(255,193,7,.12)', color: '#b8860b' },
        }, `目录不可读：${scan.error || '未知错误'}`))
      }

      // 统计卡片
      if (scan && scan.ok) {
        const s = scan.summary
        children.push(h('div', {
          key: 'stats',
          style: {
            display: 'grid',
            // 固定 4 列、强制不换行：auto-fit 在窄窗口下会把第 4 张挤到下一行，
            // 这里用 4 等分 + minWidth 0（让内容自行省略而不撑破格子）。
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 10,
          },
        },
        h(Stat, { label: '仅云端（需下载）', value: `${s.cloudOnly} 个`, sub: fmtBytes(s.cloudOnlyBytes), accent: true }),
        h(Stat, { label: '已在本地', value: `${s.total - s.cloudOnly} 个`, sub: fmtBytes(s.localBytes) }),
        h(Stat, { label: '云端图片', value: `${s.cloudOnlyImages} 个` }),
        h(Stat, { label: '云端视频', value: `${s.cloudOnlyVideos} 个` })))
      }

      // 下载控制
      if (scan && scan.ok) {
        const s = scan.summary
        const none = s.cloudOnly === 0

        const controlRow = h('div', {
          key: 'ctrl-row',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
        },
        h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '下载所有云端文件到本地'),
          h('div', { style: { fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } },
            '图片和视频全部下载。iCloud 单次回源较慢，会逐个重试。')),
        !running
          ? h('button', {
            onClick: () => { void startDownload() },
            disabled: busy || none,
            style: {
              padding: '8px 18px', fontSize: 13, borderRadius: 8, border: 'none',
              cursor: none ? 'not-allowed' : 'pointer',
              background: none ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-button-primary-fill, #0066cc)',
              color: none ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary-foreground, #fff)',
              fontWeight: 500,
            },
          }, none ? '已全部在本地' : `开始下载（${s.cloudOnly} 个）`)
          : h('button', {
            onClick: () => { void stopDownload() },
            disabled: busy,
            style: {
              padding: '8px 18px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
            },
          }, '停止'))

        // 进度面板：只在「还有云端文件」或「正在下载」时显示。
        // 全部下完后隐藏，避免与「已全部在本地」的按钮状态自相矛盾。
        const showProgress = running || (prog && prog.total > 0 && s.cloudOnly > 0)
        const progressBlock = showProgress
          ? h('div', { key: 'prog', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', {
              style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            },
            h('span', null, prog.lastMessage || '准备中'),
            h('span', null, `${prog.done + prog.failed} / ${prog.total}　(${pct}%)`)),
            h('div', {
              style: { height: 8, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
            },
            h('div', {
              style: {
                height: '100%', width: `${pct}%`, transition: 'width .3s ease',
                background: 'var(--dsw-alias-button-primary-fill, #0066cc)',
              },
            })),
            h('div', { style: { display: 'flex', gap: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', null, `成功 ${prog.done}`),
            prog.failed > 0 ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #dc3545)' } }, `失败 ${prog.failed}`) : null,
            h('span', null, `已下载 ${fmtBytes(prog.doneBytes)} / ${fmtBytes(prog.totalBytes)}`)),
            prog.current.length > 0
              ? h('div', {
                style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
              }, `正在下载：${prog.current.join('、')}`)
              : null)
          : null

        children.push(h('section', {
          key: 'ctrl',
          style: {
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
            padding: 16, display: 'flex', flexDirection: 'column', gap: 14,
          },
        }, controlRow, progressBlock))
      }

      // 自动下载开关 + 检查间隔
      const autoInfo = status ? status.auto : undefined
      const autoLine = !autoOn
        ? '开启后，插件会在后台按下面的间隔检查，发现新的云端文件就自动下载（无需打开本页面）。'
        : (autoInfo && autoInfo.lastMessage
          ? `${autoInfo.lastMessage}`
            + (autoInfo.lastCheckAt ? `（${fmtTime(autoInfo.lastCheckAt)}）` : '')
          : '已开启：后台定时检查中。')

      // 间隔输入行：数值 + 单位「分钟」。回车或失焦提交，Esc 放弃编辑。
      const intervalRow = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
          opacity: autoOn ? 1 : 0.5,
        },
      },
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '检查间隔'),
      h('input', {
        type: 'text',
        inputMode: 'decimal',
        value: intervalText,
        disabled: !autoOn,
        'aria-label': '自动检查间隔（分钟）',
        onFocus: () => { editingIntervalRef.current = true },
        onChange: (e) => setIntervalText(e.target.value),
        onBlur: (e) => {
          editingIntervalRef.current = false
          void commitInterval(e.target.value)
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          else if (e.key === 'Escape') {
            setIntervalText(String(intervalMin))
            editingIntervalRef.current = false
            e.currentTarget.blur()
          }
        },
        style: {
          width: 64, padding: '4px 8px', fontSize: 13, textAlign: 'center',
          borderRadius: 7, outline: 'none',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          cursor: autoOn ? 'text' : 'not-allowed',
        },
      }),
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '分钟'),

      // 快捷预设：常用几档，省得手输。
      ...[1, 5, 15, 30, 60].map((m) => h('button', {
        key: `preset-${m}`,
        type: 'button',
        disabled: !autoOn,
        onClick: () => {
          setIntervalText(String(m))
          editingIntervalRef.current = false
          void commitInterval(m)
        },
        style: {
          padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: autoOn ? 'pointer' : 'not-allowed',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: intervalMin === m ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: intervalMin === m
            ? 'var(--dsw-alias-label-primary)'
            : 'var(--dsw-alias-label-secondary)',
          fontWeight: intervalMin === m ? 600 : 400,
        },
      }, m >= 60 ? `${m / 60} 小时` : `${m} 分`)))

      children.push(h('section', {
        key: 'auto',
        style: {
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
          padding: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
        },
      },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '自动下载所有云端文件'),
          autoOn
            ? h('span', {
              title: '后台运行中',
              style: {
                width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
                background: 'var(--dsw-alias-state-success-primary, #22c55e)',
              },
            })
            : null),
        h('div', { style: { fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } }, autoLine),
        intervalRow),
      h('button', {
        onClick: () => { void setAuto(!autoOn) },
        'aria-pressed': autoOn,
        style: {
          flex: '0 0 auto', width: 46, height: 26, borderRadius: 13, border: 'none',
          cursor: 'pointer', position: 'relative', transition: 'background .2s',
          background: autoOn ? 'var(--dsw-alias-button-primary-fill, #0066cc)' : 'var(--dsw-alias-bg-layer-2)',
        },
      },
      h('span', {
        style: {
          position: 'absolute', top: 3, left: autoOn ? 23 : 3, width: 20, height: 20,
          borderRadius: '50%', background: '#fff', transition: 'left .2s',
          boxShadow: '0 1px 3px rgba(0,0,0,.25)',
        },
      }))))

      // 云端文件清单
      if (scan && scan.ok && scan.cloudFiles.length > 0) {
        children.push(h('section', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, `云端文件清单（${scan.cloudFiles.length}）`),
        h('div', {
          style: {
            maxHeight: 260, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10, fontSize: 12,
          },
        },
        scan.cloudFiles.map((f, i) => h('div', {
          key: f.name,
          style: {
            display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 12px',
            borderTop: i === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          },
        },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
        h('span', { style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } },
          `${f.kind === 'video' ? '视频' : '图片'} · ${fmtBytes(f.size)}`))))))
      }

      // 底部照片预览
      children.push(h('div', { key: 'preview-sep', style: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '6px 0' } }))
      children.push(h(PhotoPreview, { key: 'preview' }))
      return h('div', { style: { padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 18 } }, children)
    }

    /** 依赖的客户端服务：设置页槽位账本。 */
    const inject = ['slots']

    /**
     * 在槽位账本就绪后注册设置页分区。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'icloud-help',
        order: 25,
        label: 'iCloud 照片',
      }, IcloudHelpSection))
    }

    exports.IcloudHelpSection = IcloudHelpSection
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
