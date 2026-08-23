// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SAMPLE = '/workspace/editing-genome/samples'
const PROXY_DIR = join(tmpdir(), 'avo-proxy')
const HOOK_S = 8
const LATE_S = 3

const FIXTURE_MAP = {
  'fixture://a-roll': resolve(SAMPLE, 'synth_talkinghead_pattern.mp4'),
  'fixture://vo': resolve(SAMPLE, 'synth_talkinghead_pattern.mp4'),
  'fixture://library-broll': resolve(SAMPLE, 'nasa_greenland.mp4'),
}

export function resolveSrc(src) {
  if (!src) return null
  if (FIXTURE_MAP[src]) return FIXTURE_MAP[src]
  if (existsSync(src)) return src
  return null
}

function edlDuration(edl) {
  const videos = edl.tracks?.video || []
  if (!videos.length) return Number(edl.target_duration_s || 0)
  return Math.max(...videos.map((c) => Number(c.t1 || 0)))
}

function ffprobe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
    encoding: 'utf8',
    timeout: 20000,
  })
  if (r.status !== 0) throw new Error(r.stderr || 'ffprobe failed')
  const data = JSON.parse(r.stdout)
  const v = (data.streams || []).find((s) => s.codec_type === 'video')
  const a = (data.streams || []).find((s) => s.codec_type === 'audio')
  if (!v) throw new Error('no video stream')
  const w = Number(v.width)
  const h = Number(v.height)
  const dur = Number(data.format?.duration || v.duration || 0)
  const ratio = w / h
  let aspect = `${w}:${h}`
  if (Math.abs(ratio - 9 / 16) < 0.03) aspect = '9:16'
  else if (Math.abs(ratio - 16 / 9) < 0.03) aspect = '16:9'
  return { width: w, height: h, duration: dur, aspect, has_audio: Boolean(a), path }
}

function sceneCuts(path, thresh = 0.08) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', path,
    '-vf', `select=gt(scene\\,${thresh}),showinfo`,
    '-vsync', 'vfr', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60000 })
  const times = []
  for (const line of String(r.stderr || '').split('\n')) {
    if (!line.includes('pts_time:')) continue
    const t = parseFloat(line.split('pts_time:')[1])
    if (!Number.isNaN(t)) times.push(Math.round(t * 1000) / 1000)
  }
  return [...new Set(times)].sort((a, b) => a - b)
}

function scaleChain(crop) {
  const c = Number(crop || 1)
  const zoom = c > 1.05 ? `crop=iw/${c}:ih/${c},` : ''
  return `${zoom}scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=30,format=yuv420p,setsar=1`
}

function clipAt(clips, t) {
  const hit = clips.filter((c) => Number(c.t0 || 0) <= t && Number(c.t1 || 0) > t)
  if (!hit.length) return clips[0] || null
  hit.sort((a, b) => {
    const da = Number(a.t1 || 0) - Number(a.t0 || 0)
    const db = Number(b.t1 || 0) - Number(b.t0 || 0)
    if (da !== db) return da - db
    return Number(b.crop || 1) - Number(a.crop || 1)
  })
  return hit[0]
}

function segments(edl, w0, w1) {
  const clips = edl.tracks?.video || []
  const edges = new Set([w0, w1])
  for (const c of clips) {
    const a = Number(c.t0 || 0)
    const b = Number(c.t1 || 0)
    if (a > w0 && a < w1) edges.add(a)
    if (b > w0 && b < w1) edges.add(b)
  }
  const times = [...edges].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i]
    const b = times[i + 1]
    if (b - a < 0.04) continue
    const clip = clipAt(clips, (a + b) / 2)
    if (!clip) continue
    const srcIn = Number(clip.src_in || 0)
    const src0 = srcIn + (a - Number(clip.t0 || 0))
    const src1 = src0 + (b - a)
    out.push({ t0: a, t1: b, src0, src1, clip })
  }
  return out
}

function escDraw(s) {
  return String(s || '').replace(/[:\\']/g, ' ').slice(0, 48)
}

export function renderWindow(edl, w0, w1, outPath) {
  const clips = edl.tracks?.video || []
  const paths = []
  const idxOf = (src) => {
    const p = resolveSrc(src)
    if (!p) return -1
    let i = paths.indexOf(p)
    if (i < 0) { paths.push(p); i = paths.length - 1 }
    return i
  }
  if (idxOf(clips[0]?.src) < 0) throw new Error('no resolvable a-roll')
  const segs = segments(edl, w0, w1)
  if (!segs.length) throw new Error('empty window')
  for (const s of segs) idxOf(s.clip.src)
  const brolls = (edl.tracks?.broll || []).filter((b) => Number(b.t1 || 0) > w0 && Number(b.t0 || 0) < w1 && resolveSrc(b.src))
  for (const b of brolls.slice(0, 2)) idxOf(b.src)
  const vo = (edl.tracks?.audio || [])[0]
  if (vo) idxOf(vo.src)

  const inputs = ['-y', '-hide_banner']
  for (const p of paths) inputs.push('-stream_loop', '-1', '-i', p)

  const filters = []
  const labels = []
  segs.forEach((s, i) => {
    const lab = `s${i}`
    const inn = idxOf(s.clip.src)
    filters.push(`[${inn}:v]trim=${s.src0}:${s.src1},setpts=PTS-STARTPTS,${scaleChain(s.clip.crop)}[${lab}]`)
    labels.push(`[${lab}]`)
  })
  let last = labels.length === 1 ? labels[0].slice(1, -1) : 'base'
  if (labels.length > 1) filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[base]`)

  brolls.slice(0, 2).forEach((b, i) => {
    const mid = `br${i}`
    const ov = `ov${i}`
    const t0 = Math.max(0, Number(b.t0 || 0) - w0)
    const t1 = Math.min(w1 - w0, Number(b.t1 || 0) - w0)
    filters.push(`[${idxOf(b.src)}:v]${scaleChain(1)}[${mid}]`)
    filters.push(`[${last}][${mid}]overlay=0:0:enable='between(t\\,${t0}\\,${t1})'[${ov}]`)
    last = ov
  })

  for (const g of (edl.tracks?.graphics || [])) {
    const t0 = Math.max(0, Number(g.t0 || 0) - w0)
    const t1 = Math.min(w1 - w0, Number(g.t1 || 0) - w0)
    if (t1 <= 0 || t0 >= w1 - w0) continue
    const ov = `g${last}`
    filters.push(`[${last}]drawbox=x=40:y=80:w=460:h=70:color=white@0.35:t=fill:enable='between(t\\,${t0}\\,${t1})'[${ov}]`)
    last = ov
  }
  for (const c of (edl.tracks?.captions || [])) {
    const t0 = Math.max(0, Number(c.t0 || 0) - w0)
    const t1 = Math.min(w1 - w0, Number(c.t1 || 0) - w0)
    if (t1 <= 0 || t0 >= w1 - w0) continue
    const ov = `c${last}`
    const text = escDraw(c.text)
    filters.push(`[${last}]drawtext=text='${text}':x=24:y=h-120:fontsize=36:fontcolor=white:borderw=2:enable='between(t\\,${t0}\\,${t1})'[${ov}]`)
    last = ov
  }

  const map = ['-map', `[${last}]`]
  const voPath = vo ? resolveSrc(vo.src) : null
  if (voPath) {
    filters.push(`[${idxOf(vo.src)}:a]atrim=${w0}:${w1},asetpts=PTS-STARTPTS[aud]`)
    map.push('-map', '[aud]')
  }

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    ...map,
    '-t', String(Math.max(0.2, w1 - w0)),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-shortest',
    outPath,
  ]
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new Error((r.stderr || 'ffmpeg proxy failed').slice(-800))
  }
  return outPath
}

function proxyKey(edl, tag, w0, w1) {
  const payload = {
    tag, w0, w1, v2: 3,
    v: (edl.tracks?.video || []).slice(0, 4).map((c) => [c.src, c.t0, c.t1, c.crop, c.src_in]),
    b: (edl.tracks?.broll || []).slice(0, 3).map((c) => [c.src, c.t0, c.t1]),
    c: (edl.tracks?.captions || []).slice(0, 4).map((c) => [c.text, c.t0, c.t1]),
    g: (edl.tracks?.graphics || []).slice(0, 4).map((c) => [c.kind, c.t0, c.t1]),
    d: edlDuration(edl),
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

export function measurePath(path) {
  const meta = ffprobe(path)
  const cuts = sceneCuts(path, 0.08)
  const firstCut = cuts.length ? cuts[0] : meta.duration
  return { ...meta, cuts, firstCut, nCuts: cuts.length }
}

function measureWindow(edl, w0, w1, tag) {
  mkdirSync(PROXY_DIR, { recursive: true })
  const out = join(PROXY_DIR, `${proxyKey(edl, tag, w0, w1)}.mp4`)
  try {
    if (!existsSync(out)) renderWindow(edl, w0, w1, out)
    return { ...measurePath(out), window: [w0, w1], tag }
  } catch {
    renderWindow(edl, w0, w1, out)
    return { ...measurePath(out), window: [w0, w1], tag }
  }
}

export function measureEdl(edl) {
  const src = resolveSrc(edl.tracks?.video?.[0]?.src)
  if (!src) return null
  const d = edlDuration(edl)
  try {
    const srcMeta = ffprobe(src)
    const hookEnd = Math.min(HOOK_S, Math.max(1, d))
    const hook = measureWindow(edl, 0, hookEnd, 'hook')
    let late = null
    if (d > 20) {
      const payoff = Number((edl.beats || []).find((b) => b.name === 'payoff')?.t_start)
      const late0 = Number.isFinite(payoff) ? payoff : Math.max(0, d * 0.7)
      const late1 = Math.min(d, late0 + LATE_S)
      if (late1 - late0 >= 1) late = measureWindow(edl, late0, late1, 'late')
    }
    return {
      ...hook,
      edl_duration: d,
      source_duration: srcMeta.duration,
      source_looped: d > srcMeta.duration + 0.05,
      hook,
      late,
      nCuts: hook.nCuts + (late?.nCuts || 0),
      firstCut: hook.firstCut,
      not_vlm: true,
    }
  } catch (e) {
    return { error: String(e.message || e), edl_duration: d }
  }
}

export function blendMeasured(dummy, measured, edl) {
  if (!measured || measured.error) {
    return { ...dummy, measured: measured || null, f_mode: 'dummy_only', not_vlm: true }
  }
  const reasons = [...(dummy.correctness_reasons || [])]
  const d = measured.edl_duration != null ? measured.edl_duration : measured.duration
  if (measured.aspect !== '9:16') reasons.push('measured_aspect')
  if (d < 15 || d > 60) reasons.push('measured_duration')
  if (!measured.has_audio) reasons.push('measured_no_audio')
  const ok = reasons.length === 0 && dummy.correctness
  if (!ok) {
    const vector = Object.fromEntries(Object.keys(dummy.vector || {}).map((k) => [k, 0]))
    return { correctness: false, correctness_reasons: reasons, vector, scalar: 0, measured, f_mode: 'measured_gate', not_vlm: true }
  }
  const hookBy = 1.0
  const firstCut = measured.firstCut
  const attention = firstCut <= hookBy ? 1 : Math.max(0, 1 - (firstCut - hookBy) / 8)
  const hookCuts = measured.hook?.nCuts ?? measured.nCuts
  const lateCuts = measured.late?.nCuts ?? 0
  const hookDur = measured.hook?.duration || measured.duration || 1
  const cps = hookCuts / hookDur
  let visual = Math.min(1, hookCuts * 0.12 + lateCuts * 0.08)
  if (firstCut > 2.2) visual = Math.max(0, visual - 0.15)
  let pacing = dummy.vector.pacing
  if (cps > 1.2) pacing = Math.min(pacing, 0.45)
  if (hookCuts === 0 && d > 20) pacing = Math.min(pacing, 0.35)
  if (measured.late && lateCuts === 0 && hookCuts <= 1) pacing = Math.min(pacing, 0.4)
  const vector = {
    ...dummy.vector,
    attention_support: attention,
    visual_novelty: visual,
    pacing,
    audiovisual_sync: measured.has_audio ? Math.max(dummy.vector.audiovisual_sync, 0.5) : 0,
  }
  const pos = ['narrative_clarity', 'semantic_alignment', 'visual_novelty', 'pacing', 'attention_support', 'audiovisual_sync', 'youtube_prior']
  vector.holistic_vlm_quality = 0.9 * pos.reduce((s, k) => s + vector[k], 0) / pos.length
  const scalar = pos.reduce((s, k) => s + vector[k], 0) + vector.holistic_vlm_quality
    - (vector.repetition + vector.overediting + vector.distraction)
  return {
    ...dummy,
    correctness: true,
    correctness_reasons: [],
    vector,
    scalar: Math.round(scalar * 1e6) / 1e6,
    measured: {
      edl_duration: d,
      source_duration: measured.source_duration,
      source_looped: measured.source_looped,
      aspect: measured.aspect,
      firstCut,
      hookCuts,
      lateCuts,
      lateWindow: measured.late?.window || null,
      path: measured.path,
    },
    f_mode: 'proxy-windows',
    not_vlm: true,
  }
}
