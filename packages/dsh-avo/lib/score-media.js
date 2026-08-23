import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const SAMPLE = '/workspace/editing-genome/samples'

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

export function measurePath(path) {
  const meta = ffprobe(path)
  const cuts = sceneCuts(path, 0.08)
  const firstCut = cuts.length ? cuts[0] : meta.duration
  return { ...meta, cuts, firstCut, nCuts: cuts.length }
}

export function measureEdl(edl) {
  const src = resolveSrc(edl.tracks?.video?.[0]?.src)
  if (!src) return null
  try {
    return measurePath(src)
  } catch (e) {
    return { error: String(e.message || e) }
  }
}

export function blendMeasured(dummy, measured, edl) {
  if (!measured || measured.error) {
    return { ...dummy, measured: measured || null, f_mode: 'dummy_only' }
  }
  const reasons = [...(dummy.correctness_reasons || [])]
  if (measured.aspect !== '9:16') reasons.push('measured_aspect')
  if (measured.duration < 15 || measured.duration > 90) reasons.push('measured_duration')
  if (!measured.has_audio) reasons.push('measured_no_audio')
  const ok = reasons.length === 0 && dummy.correctness
  if (!ok) {
    const vector = Object.fromEntries(Object.keys(dummy.vector || {}).map((k) => [k, 0]))
    return { correctness: false, correctness_reasons: reasons, vector, scalar: 0, measured, f_mode: 'measured_gate' }
  }
  const hookBy = 1.0
  const attention = measured.firstCut <= hookBy ? 1 : Math.max(0, 1 - (measured.firstCut - hookBy) / 8)
  const cps = measured.duration > 0 ? measured.nCuts / measured.duration : 0
  let visual = attention * 0.5 + Math.min(0.5, measured.nCuts * 0.08)
  if (measured.firstCut > 2.2) visual = Math.max(0, visual - 0.2)
  let pacing = dummy.vector.pacing
  if (cps > 1.2) pacing = Math.min(pacing, 0.45)
  if (cps === 0 && measured.duration > 20) pacing = Math.min(pacing, 0.35)
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
    measured: { duration: measured.duration, aspect: measured.aspect, firstCut: measured.firstCut, nCuts: measured.nCuts, path: measured.path },
    f_mode: 'measured+edl',
  }
}
