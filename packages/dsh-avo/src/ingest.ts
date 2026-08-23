// @ts-nocheck
/**
 * Local-file ingest: video -> editing-genome jsonl rows.
 * Operator supplies files. No YouTube/TikTok/yt-dlp. No remote downloads.
 *
 * Punch-in: center-crop of prev frame vs next (PUNCHIN_CROP 0.78), same idea as
 * editing-genome/tools/decompile.py. Falls back to hard_cut if frame extract fails.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

const PUNCHIN_CROP = 0.78
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'])

export function ffprobe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.status !== 0) throw new Error(r.stderr || 'ffprobe failed')
  const data = JSON.parse(r.stdout)
  const v = (data.streams || []).find((s) => s.codec_type === 'video')
  const a = (data.streams || []).find((s) => s.codec_type === 'audio')
  if (!v) throw new Error('no video stream')
  const w = Number(v.width)
  const h = Number(v.height)
  const fr = String(v.avg_frame_rate || v.r_frame_rate || '30/1')
  const [num, den] = fr.split('/')
  const fps = Number(den) ? Number(num) / Number(den) : Number(num) || 30
  const dur = Number(data.format?.duration || v.duration || 0)
  const ratio = w / h
  let aspect = `${w}:${h}`
  if (Math.abs(ratio - 9 / 16) < 0.03) aspect = '9:16'
  else if (Math.abs(ratio - 16 / 9) < 0.03) aspect = '16:9'
  else if (Math.abs(ratio - 1) < 0.03) aspect = '1:1'
  return { width: w, height: h, duration: dur, aspect, fps, has_audio: Boolean(a), path }
}

export function sceneCuts(path, thresh = 0.08) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', path,
    '-vf', `select=gt(scene\\,${thresh}),showinfo`,
    '-vsync', 'vfr', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120000 })
  const times = []
  for (const line of String(r.stderr || '').split('\n')) {
    if (!line.includes('pts_time:')) continue
    const t = parseFloat(line.split('pts_time:')[1])
    if (!Number.isNaN(t)) times.push(Math.round(t * 1000) / 1000)
  }
  return [...new Set(times)].sort((a, b) => a - b)
}

export function silenceDetect(path, n = '-35dB', d = 0.18) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', path,
    '-af', `silencedetect=n=${n}:d=${d}`,
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120000 })
  const spans = []
  let start = null
  for (const line of String(r.stderr || '').split('\n')) {
    const s = line.match(/silence_start:\s*([-\d.]+)/)
    const e = line.match(/silence_end:\s*([-\d.]+)/)
    if (s) start = Number(s[1])
    if (e && start != null) {
      spans.push([Math.round(start * 1000) / 1000, Math.round(Number(e[1]) * 1000) / 1000])
      start = null
    }
  }
  return spans
}

function extractFrame(path, t, out) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-y', '-ss', String(Math.max(0, t)), '-i', path,
    '-frames:v', '1', '-q:v', '3', out,
  ], { encoding: 'utf8', timeout: 20000 })
  return r.status === 0 && existsSync(out)
}

function lumaMeanAbs(a, b) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', a, '-i', b,
    '-filter_complex',
    '[0:v]format=gray,scale=160:284[a];[1:v]format=gray,scale=160:284[b];[a][b]blend=all_mode=difference,signalstats',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 20000 })
  for (const line of String(r.stderr || '').split('\n')) {
    if (!line.includes('YAVG:')) continue
    const part = line.split('YAVG:')[1].split(/\s/)[0]
    const n = Number(part)
    if (!Number.isNaN(n)) return n
  }
  return null
}

/** Classify scene hit as punch_in vs hard_cut via center-crop of prev vs next. */
export function classifyCut(path, t, fps, tmpDir) {
  const pre = join(tmpDir, 'pre.jpg')
  const post = join(tmpDir, 'post.jpg')
  const crop = join(tmpDir, 'crop.jpg')
  const dt = 1 / Math.max(fps || 30, 1)
  if (!extractFrame(path, t - dt, pre) || !extractFrame(path, t + dt, post)) return { kind: 'hard_cut', params: { detect: 'scene_select', note: 'frame_extract_failed' } }
  spawnSync('ffmpeg', [
    '-hide_banner', '-y', '-i', pre,
    '-vf', `crop=iw*${PUNCHIN_CROP}:ih*${PUNCHIN_CROP}:(iw-iw*${PUNCHIN_CROP})/2:(ih-ih*${PUNCHIN_CROP})/2,scale=iw:ih`,
    crop,
  ], { encoding: 'utf8', timeout: 15000 })
  const full = lumaMeanAbs(pre, post)
  const zoom = existsSync(crop) ? lumaMeanAbs(crop, post) : null
  if (full == null) return { kind: 'hard_cut', params: { detect: 'scene_select' } }
  if (zoom != null && zoom + 2 < full && zoom < 28) {
    return { kind: 'punch_in', params: { scale: Math.round((1 / PUNCHIN_CROP) * 1000) / 1000, detect: 'center_crop_match' } }
  }
  if (full < 8) return { kind: 'match_or_soft_cut', params: { detect: 'low_luma_delta' } }
  return { kind: 'hard_cut', params: { detect: 'scene_select' } }
}

export function inferBeats(duration, cuts) {
  const hookEnd = Math.min(3, duration * 0.15)
  const closeLen = Math.min(1.8, Math.max(0.6, duration * 0.08))
  const closeStart = Math.max(hookEnd, duration - closeLen)
  const mid = closeStart - hookEnd
  const names = ['setup', 'development', 'escalation', 'payoff']
  const beats = [{
    beat: 'hook', t_start: 0, t_end: round3(hookEnd),
    method: 'duration_heuristic', confidence: 0.35,
    cut_count: cuts.filter((c) => c >= 0 && c < hookEnd).length,
  }]
  if (mid > 0) {
    const w = mid / 4
    names.forEach((name, i) => {
      const s = hookEnd + i * w
      const e = hookEnd + (i + 1) * w
      beats.push({
        beat: name, t_start: round3(s), t_end: round3(e),
        method: 'duration_heuristic', confidence: 0.25,
        cut_count: cuts.filter((c) => c >= s && c < e).length,
      })
    })
  }
  beats.push({
    beat: 'close', t_start: round3(closeStart), t_end: round3(duration),
    method: 'duration_heuristic', confidence: 0.3,
    cut_count: cuts.filter((c) => c >= closeStart && c <= duration).length,
  })
  return beats
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000
}

function beatGuess(beats, t) {
  for (const b of beats) {
    if (b.t_start <= t && t < b.t_end) return b.beat
    if (b.beat === 'close' && t >= b.t_start) return b.beat
  }
  return beats[0]?.beat || null
}

function speechAt(segments, t0, t1) {
  if (!segments?.length) return { speech: null, speech_pace: null }
  const hit = segments.filter((s) => Number(s.end) > t0 && Number(s.start) < t1)
  if (!hit.length) return { speech: null, speech_pace: null }
  const text = hit.map((s) => String(s.text || '').trim()).filter(Boolean).join(' ').trim()
  const words = text.split(/\s+/).filter(Boolean)
  const span = Math.max(0.001, Math.min(t1, hit[hit.length - 1].end) - Math.max(t0, hit[0].start))
  const speech_pace = words.length / span
  return { speech: text || null, speech_pace: text ? round3(speech_pace) : null }
}

function loadJsonlIds(file) {
  if (!existsSync(file)) return new Set()
  const ids = new Set()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.id) ids.add(row.id)
    } catch { /* skip */ }
  }
  return ids
}

function appendJsonl(file, rows) {
  mkdirSync(resolve(file, '..'), { recursive: true })
  for (const r of rows) appendFileSync(file, JSON.stringify(r) + '\n')
}

function recountSummary(outDir) {
  const actions = {}
  let videos = 0
  let events = 0
  let beats = 0
  const evFile = join(outDir, 'events.jsonl')
  const vFile = join(outDir, 'videos.jsonl')
  const bFile = join(outDir, 'beats.jsonl')
  if (existsSync(vFile)) videos = readFileSync(vFile, 'utf8').split('\n').filter((l) => l.trim()).length
  if (existsSync(bFile)) beats = readFileSync(bFile, 'utf8').split('\n').filter((l) => l.trim()).length
  if (existsSync(evFile)) {
    for (const line of readFileSync(evFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      events++
      try {
        const a = JSON.parse(line).editor_action?.action
        if (a) actions[a] = (actions[a] || 0) + 1
      } catch { /* skip */ }
    }
  }
  const summary = { videos, events, beats, actions }
  writeFileSync(join(outDir, 'run_summary.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}

function extractWav(path, wavPath) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-y', '-i', path,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    wavPath,
  ], { encoding: 'utf8', timeout: 180000 })
  if (r.status !== 0 || !existsSync(wavPath)) throw new Error((r.stderr || 'wav extract failed').slice(-400))
  const size = statSync(wavPath).size
  if (size <= 24 * 1024 * 1024) return wavPath
  // 16k mono s16 ~32KB/s; clip to keep under 25MB
  const maxS = Math.floor((24 * 1024 * 1024) / 32000)
  const clipped = wavPath.replace(/\.wav$/, '.clip.wav')
  const r2 = spawnSync('ffmpeg', [
    '-hide_banner', '-y', '-i', wavPath, '-t', String(maxS), '-c', 'copy', clipped,
  ], { encoding: 'utf8', timeout: 60000 })
  try { unlinkSync(wavPath) } catch { /* ignore */ }
  if (r2.status !== 0 || !existsSync(clipped)) throw new Error('wav clip failed')
  return clipped
}

async function groqAsr(wavPath) {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  const buf = readFileSync(wavPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`groq asr ${res.status}: ${(await res.text()).slice(0, 400)}`)
  return res.json()
}

async function loadOrRunAsr(path, videoId, outDir, noAsr) {
  if (noAsr || !process.env.GROQ_API_KEY) return null
  const cacheDir = join(outDir, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const cache = join(cacheDir, `${videoId}.asr.json`)
  if (existsSync(cache)) {
    try { return JSON.parse(readFileSync(cache, 'utf8')) } catch { /* re-run */ }
  }
  const wavPath = join(tmpdir(), `avo-asr-${videoId}-${Date.now()}.wav`)
  let used = wavPath
  try {
    used = extractWav(path, wavPath)
    const data = await groqAsr(used)
    if (data) writeFileSync(cache, JSON.stringify(data))
    return data
  } finally {
    try { if (existsSync(used)) unlinkSync(used) } catch { /* ignore */ }
    try { if (used !== wavPath && existsSync(wavPath)) unlinkSync(wavPath) } catch { /* ignore */ }
  }
}

function listVideos(input) {
  const p = resolve(input)
  if (!existsSync(p)) throw new Error(`not found: ${input}`)
  const st = statSync(p)
  if (st.isFile()) return [p]
  return readdirSync(p)
    .filter((n) => VIDEO_EXT.has(extname(n).toLowerCase()))
    .map((n) => join(p, n))
    .sort()
}

function videoIdFor(file, idPrefix) {
  const stem = basename(file, extname(file))
  return idPrefix ? `${idPrefix}${stem}` : stem
}

export async function ingestFile(file, opts = {}) {
  const outDir = resolve(opts.out || '.')
  mkdirSync(outDir, { recursive: true })
  const id = videoIdFor(file, opts.idPrefix)
  const videosPath = join(outDir, 'videos.jsonl')
  const existing = loadJsonlIds(videosPath)
  if (existing.has(id) && !opts.force) {
    return { id, skipped: true, reason: 'already_in_videos.jsonl' }
  }

  const meta = ffprobe(file)
  const thresh = opts.sceneThresh ?? 0.08
  const cuts = sceneCuts(file, thresh)
  const silences = meta.has_audio ? silenceDetect(file) : []
  const asr = await loadOrRunAsr(file, id, outDir, opts.noAsr)
  const segments = asr?.segments || []

  const tmpDir = join(tmpdir(), `avo-ingest-${id}-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const events = []
  try {
    const boundaries = [0, ...cuts, meta.duration]
    const bnds = []
    for (const t of boundaries) {
      if (!bnds.length || t - bnds[bnds.length - 1] > 0.04) bnds.push(t)
    }
    if (bnds[bnds.length - 1] < meta.duration - 0.01) bnds.push(meta.duration)

    let prevAction = null
    for (let i = 0; i < bnds.length - 1; i++) {
      const t0 = bnds[i]
      const t1 = bnds[i + 1]
      const segDur = Math.max(0.001, t1 - t0)
      let action
      let params
      if (i === 0) {
        action = 'hold'
        params = { reason: 'opening_hold' }
      } else {
        const cls = classifyCut(file, t0, meta.fps, tmpDir)
        action = cls.kind
        params = cls.params
      }
      const sp = speechAt(segments, t0, t1)
      events.push({
        video_id: id,
        t: round3(t0),
        t_end: round3(t1),
        content_state: {
          speech: sp.speech,
          semantic_event: null,
          speaker: null,
          emotional_delivery: null,
          visual_age: round3(t1 - t0),
          previous_visual: prevAction,
          information_novelty: null,
          speech_pace: sp.speech_pace,
          beat_guess: null,
        },
        editor_action: {
          action,
          params,
          duration: round3(segDur),
          pairing: [],
          semantic_relation: null,
        },
        source: 'avo-ingest',
        confidence: action === 'punch_in' ? 0.55 : 0.7,
      })
      prevAction = action
    }
  } finally {
    try {
      for (const n of readdirSync(tmpDir)) unlinkSync(join(tmpDir, n))
    } catch { /* ignore */ }
  }

  for (const [s0, s1] of silences) {
    events.push({
      video_id: id,
      t: s0,
      t_end: s1,
      content_state: {
        speech: null,
        semantic_event: 'possible_pause',
        speaker: null,
        emotional_delivery: null,
        visual_age: null,
        previous_visual: null,
        information_novelty: null,
        speech_pace: null,
        beat_guess: null,
      },
      editor_action: {
        action: 'silence',
        params: { hypothesis: 'ffmpeg_silencedetect', ffmpeg_silencedetect: { n: '-35dB', d: 0.18 } },
        duration: round3(s1 - s0),
        pairing: [],
        semantic_relation: null,
      },
      source: 'avo-ingest',
      confidence: 0.35,
    })
  }

  const beatRows = inferBeats(meta.duration, cuts).map((b) => ({ video_id: id, ...b }))
  events.sort((a, b) => a.t - b.t || String(a.editor_action.action).localeCompare(b.editor_action.action))
  for (const e of events) e.content_state.beat_guess = beatGuess(beatRows, e.t)

  const videoRow = {
    id,
    url: null,
    local_path: resolve(file),
    platform: 'local',
    duration: round3(meta.duration),
    aspect: meta.aspect,
    width: meta.width,
    height: meta.height,
    fps: round3(meta.fps),
    format: meta.duration <= 90 ? 'short' : 'long',
    content_mode: null,
    purpose: null,
    edit_character: null,
    creator: opts.creator || null,
    tags: ['decompiled', 'avo-ingest'],
    rights: 'operator_supplied_local',
    quality_gate: 'pass',
    rejected_reason: null,
    cut_count: cuts.length,
    silence_count: silences.length,
    asr: asr ? 'groq_whisper-large-v3-turbo' : null,
  }

  appendJsonl(videosPath, [videoRow])
  appendJsonl(join(outDir, 'events.jsonl'), events)
  appendJsonl(join(outDir, 'beats.jsonl'), beatRows)
  const summary = recountSummary(outDir)

  if (opts.deleteSource) unlinkSync(file)

  return { id, skipped: false, video: videoRow, events, beats: beatRows, summary }
}

export async function ingest(input, opts = {}) {
  const files = listVideos(input)
  const results = []
  for (const f of files) results.push(await ingestFile(f, opts))
  return results
}

export { PUNCHIN_CROP }
