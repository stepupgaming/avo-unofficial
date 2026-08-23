// @ts-nocheck
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const POS = [
  'narrative_clarity', 'semantic_alignment', 'visual_novelty', 'pacing',
  'attention_support', 'audiovisual_sync', 'youtube_prior', 'holistic_vlm_quality',
]
const PEN = ['repetition', 'overediting', 'distraction']
import { inspectAndPropose, supervisorInspect, diagnoseScore } from "./inspect.js"
import { blendMeasured, measureEdl } from "./score-media.js"
const CHEAP = ['trim', 'reorder', 'punch_in', 'speed', 'caption', 'graphic', 'broll_swap', 'sfx', 'music_duck']
const H3_REFUSED = 'h3_regen refused in v0 (expensive last; stub only)'

function clone(x) { return JSON.parse(JSON.stringify(x)) }
function clip(x, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, x)) }

export function loadJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
export function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

export function durationS(edl) {
  const videos = edl.tracks?.video || []
  if (!videos.length) return Number(edl.target_duration_s || 0)
  return Math.max(...videos.map((c) => Number(c.t1 || 0)))
}

export function correctness(edl) {
  const reasons = []
  if (edl.aspect !== '9:16') reasons.push('aspect')
  const d = durationS(edl)
  if (d < 15 || d > 60) reasons.push('duration')
  if (!edl.rights) reasons.push('rights')
  const t = edl.tracks || {}
  if (!(t.video || []).length) reasons.push('no_video')
  if (!(t.audio || []).length) reasons.push('no_audio')
  const vs = (t.video || []).map((c) => Number(c.t0 || 0))
  const ve = (t.video || []).map((c) => Number(c.t1 || 0))
  const as_ = (t.audio || []).map((c) => Number(c.t0 || 0))
  const ae = (t.audio || []).map((c) => Number(c.t1 || 0))
  if (vs.length && as_.length) {
    if (Math.abs(Math.min(...vs) - Math.min(...as_)) > 0.25) reasons.push('desync')
    if (Math.abs(Math.max(...ve) - Math.max(...ae)) > 0.25) reasons.push('desync')
  }
  return { ok: reasons.length === 0, reasons }
}

function eventCount(edl) {
  const t = edl.tracks || {}
  const punch = (t.video || []).filter((c) => Number(c.crop || 1) > 1.05).length
  return {
    captions: (t.captions || []).length,
    sfx: (t.sfx || []).length,
    broll: (t.broll || []).length,
    graphics: (t.graphics || []).length,
    punch_ins: punch,
    video_clips: (t.video || []).length,
  }
}

export function loadKnowledge(genomeDir = '/workspace/editing-genome') {
  const k = {
    source: genomeDir,
    cheap_first: CHEAP,
    expensive_last: ['h3_regen'],
    hook_visual_by_s: 1.0,
    overedit_bands: { captions: 6, sfx: 4, punch_ins: 3 },
    broll_reject_if_gt: 4.0,
  }
  const priors = join(genomeDir, 'genome', 'v0_priors.json')
  if (existsSync(priors)) {
    k.priors = loadJson(priors)
    const hook = k.priors.hypothesized?.hook
    if (hook?.must_change_visual_or_type_by_s != null) k.hook_visual_by_s = Number(hook.must_change_visual_or_type_by_s)
    const broll = k.priors.hypothesized?.broll_duration_s
    if (broll?.reject_if_gt != null) k.broll_reject_if_gt = Number(broll.reject_if_gt)
  }
  return k
}

export function evaluate(edl, k) {
  k = k || loadKnowledge()
  const gate = correctness(edl)
  if (!gate.ok) {
    const vector = Object.fromEntries([...POS, ...PEN].map((n) => [n, 0]))
    return { correctness: false, correctness_reasons: gate.reasons, vector, scalar: 0 }
  }
  const tracks = edl.tracks || {}
  const beats = Object.fromEntries((edl.beats || []).filter((b) => b.name).map((b) => [b.name, b]))
  const needed = ['hook', 'setup', 'payoff', 'close']
  const narrative = needed.filter((n) => beats[n]).length / 4
  const captions = tracks.captions || []
  const broll = tracks.broll || []
  const sfx = tracks.sfx || []
  const graphics = tracks.graphics || []
  const videos = tracks.video || []
  const setupT = Number(beats.setup?.t_start ?? 3)
  const claimPaired = [...captions, ...broll].some((c) => Math.abs(Number(c.t0 || 0) - setupT) < 2)
  let firstChange = 99
  for (const c of videos) {
    if (Number(c.crop || 1) > 1.05 || Number(c.t0 || 0) > 0) firstChange = Math.min(firstChange, Number(c.t0 || 0))
  }
  for (const c of [...broll, ...graphics, ...captions]) firstChange = Math.min(firstChange, Number(c.t0 || 0))
  const hookBy = Number(k.hook_visual_by_s || 1)
  const attention = firstChange <= hookBy ? 1 : clip(1 - (firstChange - hookBy) / 8)
  let visualNovelty = clip(attention * 0.6 + ((broll.length || videos.some((v) => Number(v.crop || 1) > 1.05)) ? 0.4 : 0))
  if (firstChange > 2.2) visualNovelty = clip(visualNovelty - 0.25)
  const d = durationS(edl)
  let pacing = d >= 25 && d <= 45 ? 0.9 : d >= 15 && d <= 60 ? 0.55 : 0.2
  const counts = eventCount(edl)
  if (counts.video_clips + counts.broll + counts.punch_ins === 1 && d > 20) pacing = Math.min(pacing, 0.4)
  if (counts.punch_ins > 2 || counts.sfx > 3 || counts.captions > 4) pacing = Math.min(pacing, 0.5)
  let av = sfx.length ? 0.75 : 0.4
  if ((tracks.audio || []).some((x) => x.duck)) av = Math.min(1, av + 0.15)
  let yt = 0.4
  if (d >= 20 && d <= 45) yt += 0.25
  if (captions[0] && Number(captions[0].t0 ?? 99) <= 1) yt += 0.25
  yt = clip(yt)
  const positives = {
    narrative_clarity: clip(narrative),
    semantic_alignment: clip(claimPaired ? 0.85 : 0.25),
    visual_novelty: clip(visualNovelty),
    pacing: clip(pacing),
    attention_support: clip(attention),
    audiovisual_sync: clip(av),
    youtube_prior: yt,
  }
  positives.holistic_vlm_quality = clip(0.9 * Object.values(positives).reduce((a, b) => a + b, 0) / 7)
  const texts = captions.map((c) => String(c.text || ''))
  const repetition = texts.length && new Set(texts).size !== texts.length ? 0.4 : 0
  const bands = k.overedit_bands || {}
  let over = 0
  if (counts.captions > (bands.captions ?? 6)) over += 0.25
  if (counts.sfx > (bands.sfx ?? 4)) over += 0.25
  if (counts.punch_ins > (bands.punch_ins ?? 3)) over += 0.25
  over += Math.max(0, counts.captions - (bands.captions ?? 6)) * 0.12
  over += Math.max(0, counts.sfx - (bands.sfx ?? 4)) * 0.12
  over += Math.max(0, counts.punch_ins - (bands.punch_ins ?? 3)) * 0.15
  const overediting = clip(over, 0, 3)
  let distraction = broll.some((b) => Number(b.t1 || 0) - Number(b.t0 || 0) > Number(k.broll_reject_if_gt || 4)) ? 0.35 : 0
  if (counts.graphics > 4) distraction = clip(distraction + 0.2)
  const vector = { ...positives, repetition, overediting, distraction }
  const scalar = Object.values(positives).reduce((a, b) => a + b, 0) - (repetition + overediting + distraction)
  const out = { correctness: true, correctness_reasons: [], vector, scalar: Math.round(scalar * 1e6) / 1e6, counts }
  return blendMeasured(out, measureEdl(edl), edl)
}

function tracks(edl) {
  edl.tracks = edl.tracks || {}
  for (const k of ['video', 'audio', 'captions', 'graphics', 'sfx', 'broll']) edl.tracks[k] = edl.tracks[k] || []
  return edl.tracks
}

export function applyMutation(edl, op) {
  if (op === 'h3_regen') throw new Error(H3_REFUSED)
  const out = clone(edl)
  const t = tracks(out)
  if (op === 'trim') {
    const t1 = 32
    for (const key of ['video', 'audio']) {
      for (const c of t[key]) {
        c.t1 = Math.min(Number(c.t1 || t1), t1)
        if (Number(c.t0) >= Number(c.t1)) c.t0 = 0
      }
    }
    out.target_duration_s = t1
    out.beats = (out.beats || []).filter((b) => Number(b.t_start || 0) < t1).map((b) => ({ ...b, t_end: Math.min(Number(b.t_end || t1), t1) }))
    return out
  }
  if (op === 'punch_in') {
    if (!t.video.length) throw new Error('no video')
    const src = { ...t.video[0], id: `${t.video[0].id || 'v'}-punch`, t0: 0, t1: 1.2, crop: 1.22 }
    t.video.unshift(src)
    return out
  }
  if (op === 'caption' || op === 'caption_claim') {
    const t0 = op === 'caption_claim' ? 3 : 0
    t.captions.push({ id: `cap${t.captions.length + 1}`, text: op === 'caption_claim' ? 'CLAIM' : 'HOOK', t0, t1: t0 + 1.2 })
    return out
  }
  if (op === 'sfx') {
    t.sfx.push({ id: `sfx${t.sfx.length + 1}`, src: 'fixture://whoosh', t0: 0, t1: 0.2 })
    return out
  }
  if (op === 'broll_swap') {
    t.broll.push({ id: `br${t.broll.length + 1}`, src: 'fixture://library-broll', t0: 3, t1: 4.4 })
    return out
  }
  if (op === 'graphic') {
    t.graphics.push({ id: `g${t.graphics.length + 1}`, kind: 'title', t0: 0.2, t1: 1.4 })
    return out
  }
  if (op === 'speed') {
    for (const c of t.video) c.speed = Number(c.speed || 1) * 1.05
    return out
  }
  if (op === 'reorder') {
    const beats = [...(out.beats || [])]
    if (beats.length >= 2) { const tmp = beats[0]; beats[0] = beats[1]; beats[1] = tmp; out.beats = beats }
    return out
  }
  if (op === 'music_duck') {
    if (t.audio[0]) t.audio[0].duck = true
    else t.audio.push({ id: 'a-duck', src: 'fixture://vo', t0: 0, t1: 32, duck: true })
    return out
  }
  throw new Error(`unknown op ${op}`)
}

export class Lineage {
  constructor(root) {
    this.root = root
    this.commitsDir = join(root, 'commits')
    mkdirSync(this.commitsDir, { recursive: true })
    this.indexPath = join(root, 'index.json')
    this.index = existsSync(this.indexPath) ? loadJson(this.indexPath) : { committed: [], trajectory: [] }
  }
  save() { saveJson(this.indexPath, this.index) }
  best() {
    if (!this.index.committed.length) return null
    return this.index.committed.reduce((a, b) => (a.scalar >= b.scalar ? a : b))
  }
  commit(edl, score, note) {
    const id = `x${this.index.committed.length + 1}`
    const path = join(this.commitsDir, `${id}.json`)
    saveJson(path, edl)
    const rec = { id, t: Date.now() / 1000, scalar: score.scalar, vector: score.vector, correctness: score.correctness, note, edl_id: edl.id, path }
    this.index.committed.push(rec)
    this.save()
    return rec
  }
  record(op, score, status, detail) {
    this.index.trajectory.push({ t: Date.now() / 1000, op, status, scalar: score?.scalar ?? null, detail })
    this.save()
  }
}

function diagnostics(score) {
  return diagnoseScore(score)
}

function propose(diags, tried, force, cheap) {
  if (force && !tried.includes(force)) return force
  const prefer = []
  if (diags.includes('hook_needs_visual')) prefer.push('punch_in', 'graphic', 'caption')
  if (diags.includes('claim_unpaired')) prefer.push('caption_claim', 'broll_swap')
  if (diags.includes('flat_pacing')) prefer.push('trim', 'punch_in')
  if (diags.includes('weak_packaging') || diags.includes('no_captions')) prefer.push('caption', 'graphic')
  prefer.push('music_duck', 'sfx', 'speed')
  for (const op of [...prefer, ...cheap]) {
    if (!tried.includes(op) && op !== 'h3_regen') return op
  }
  return 'trim'
}

function supervisorRedirect(trajectory, cheap) {
  const recent = trajectory.slice(-8)
  if (!recent.length) return null
  const ops = recent.map((r) => r.op)
  if (ops.length >= 3 && new Set(ops.slice(-3)).size === 1) {
    const current = ops[ops.length - 1]
    return cheap.find((a) => a !== current) || 'trim'
  }
  const statuses = recent.map((r) => r.status)
  if (statuses.filter((s) => s === 'discard').length >= 3 && !statuses.slice(-3).includes('commit')) {
    const used = new Map()
    for (const op of ops) used.set(op, (used.get(op) || 0) + 1)
    return cheap.find((a) => !used.get(a)) || 'trim'
  }
  return null
}

export function varyOnce(seed, lineage, k, inner = 5) {
  k = k || loadKnowledge()
  const cheap = k.cheap_first || CHEAP
  let parent = lineage.best()?.path ? loadJson(lineage.best().path) : clone(seed)
  let parentScore = evaluate(parent, k)
  if (!lineage.index.committed.length) lineage.commit(parent, parentScore, 'seed')
  const tried = []
  let force = null
  let last = { status: 'noop' }
  let redirects = 0
  for (let i = 0; i < inner; i++) {
    const best = lineage.best()
    const bestScalar = best ? best.scalar : parentScore.scalar
    const diags = diagnostics(parentScore)
    const redirect = supervisorInspect(lineage, cheap)
    if (redirect) { force = redirect; redirects += 1 }
    const pick = inspectAndPropose({ diags, tried, force, cheap, lineage, k, edl: parent, score: parentScore }); const op = pick.op
    tried.push(op)
    let cand
    try { cand = applyMutation(parent, op) } catch (e) {
      lineage.record(op, null, 'error', String(e.message || e))
      last = { status: 'error', op, detail: String(e.message || e) }
      continue
    }
    const score = evaluate(cand, k)
    if (!score.correctness) {
      lineage.record(op, score, 'discard', 'correctness')
      last = { status: 'discard', op, score, reason: 'correctness' }
      continue
    }
    if (score.scalar + 1e-9 < bestScalar) {
      lineage.record(op, score, 'discard', `scalar ${score.scalar} < ${bestScalar}`)
      last = { status: 'discard', op, score, reason: 'no_improve' }
      continue
    }
    const rec = lineage.commit(cand, score, op)
    lineage.record(op, score, 'commit', rec.id)
    last = { status: 'commit', op, score, id: rec.id }
    break
  }
  last.supervisor_redirects = redirects
  last.tried = tried
  return last
}

export function runVary({ fixture, lineageDir, steps = 1, genomeDir }) {
  const seed = loadJson(fixture)
  const lineage = new Lineage(lineageDir)
  const k = loadKnowledge(genomeDir)
  const results = []
  for (let i = 0; i < steps; i++) results.push(varyOnce(seed, lineage, k, 5))
  return results
}

export { H3_REFUSED, CHEAP }
