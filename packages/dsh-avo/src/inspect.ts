// @ts-nocheck

export function inspectEdl(edl, score) {
  const t = edl?.tracks || {}
  const captions = t.captions || []
  const broll = t.broll || []
  const video = t.video || []
  const setupT = Number((edl?.beats || []).find((b) => b.name === 'setup')?.t_start ?? 3)
  const m = score?.measured || {}
  const facts = {
    n_captions: captions.length,
    n_broll: broll.length,
    n_video: video.length,
    n_graphics: (t.graphics || []).length,
    caption_in_hook: captions.some((c) => Number(c.t0 || 0) <= 1),
    broll_near_setup: broll.some((c) => Math.abs(Number(c.t0 || 0) - setupT) < 2),
    firstCut: m.firstCut ?? null,
    hookCuts: m.hookCuts ?? null,
    mean_volume: m.mean_volume ?? null,
    source_looped: !!m.source_looped,
    edl_duration: m.edl_duration ?? null,
  }
  const gaps = []
  if (facts.firstCut != null && facts.firstCut > 1.0) gaps.push({ gap: 'late_first_cut', op: 'punch_in' })
  if (facts.hookCuts != null && facts.hookCuts <= 1) gaps.push({ gap: 'few_hook_cuts', op: 'broll_swap' })
  if (!facts.broll_near_setup) gaps.push({ gap: 'no_broll_near_setup', op: 'broll_swap' })
  if (!facts.caption_in_hook) gaps.push({ gap: 'no_caption_in_hook', op: 'caption' })
  if (facts.n_graphics === 0 && !facts.caption_in_hook) gaps.push({ gap: 'empty_hook_packaging', op: 'graphic' })
  if (facts.edl_duration != null && facts.edl_duration > 40 && facts.n_video === 1 && facts.n_broll === 0) {
    gaps.push({ gap: 'long_single_shot', op: 'trim' })
  }
  return { facts, gaps }
}

export function diagnoseScore(score) {
  const d = []
  const v = score?.vector || {}
  const m = score?.measured || {}
  if ((m.firstCut ?? 99) > 1.0 || (v.attention_support ?? 1) < 0.7) d.push('hook_needs_visual')
  if ((v.semantic_alignment ?? 1) < 0.5) d.push('claim_unpaired')
  if ((m.hookCuts ?? 99) <= 1 || (v.pacing ?? 1) < 0.6) d.push('flat_pacing')
  if ((v.youtube_prior ?? 1) < 0.6) d.push('weak_packaging')
  if ((score?.counts?.captions ?? 0) === 0) d.push('no_captions')
  if ((m.mean_volume ?? -10) < -40) d.push('quiet_audio')
  return d
}

export function lastCommittedOps(lineage) {
  return (lineage.index.committed || []).map((c) => c.note).filter(Boolean)
}

export function proposeFromInspect({ edl, score, tried, force, cheap, lineage }) {
  if (force && !tried.includes(force)) return { op: force, why: 'supervisor_redirect' }
  const used = new Set(lastCommittedOps(lineage))
  const { facts, gaps } = inspectEdl(edl, score)
  if (facts.mean_volume != null && facts.mean_volume < -40) {
    used.add('music_duck')
  }
  for (const g of gaps) {
    if (tried.includes(g.op) || used.has(g.op) || g.op === 'h3_regen') continue
    return { op: g.op, why: 'edl:' + g.gap, facts }
  }
  for (const op of cheap || []) {
    if (!tried.includes(op) && !used.has(op) && op !== 'h3_regen') return { op, why: 'untried_cheap', facts }
  }
  return { op: 'trim', why: 'last_resort', facts }
}

export function inspectAndPropose({ diags, tried, force, cheap, lineage, k, edl, score }) {
  return proposeFromInspect({ edl, score, tried, force, cheap, lineage })
}

export function supervisorInspect(lineage, cheap) {
  const recent = lineage.index.trajectory.slice(-8)
  if (!recent.length) return null
  const ops = recent.map((r) => r.op)
  let reason = null
  let next = null
  if (ops.length >= 3 && new Set(ops.slice(-3)).size === 1) {
    reason = 'cycle'
    next = cheap.find((a) => a !== ops[ops.length - 1]) || 'trim'
  }
  const statuses = recent.map((r) => r.status)
  if (!next && statuses.filter((s) => s === 'discard').length >= 3 && !statuses.slice(-3).includes('commit')) {
    reason = 'stall_discards'
    const used = new Map()
    for (const op of ops) used.set(op, (used.get(op) || 0) + 1)
    next = cheap.find((a) => !used.get(a)) || 'trim'
  }
  if (!next) return null
  lineage.index.supervisor = lineage.index.supervisor || []
  lineage.index.supervisor.push({ t: Date.now() / 1000, reason, next })
  lineage.save()
  return next
}
