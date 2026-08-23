// @ts-nocheck
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

export function priorsFor(diags, k) {
  const rows = k?.priors?.hypothesized?.P_action_given_state || []
  const out = []
  for (const row of rows) {
    const st = String(row.state || '')
    const hit =
      (diags.includes('hook_needs_visual') && st.includes('hook')) ||
      (diags.includes('claim_unpaired') && st.includes('claim'))
    if (!hit || !row.P) continue
    const ranked = Object.entries(row.P).sort((a, b) => b[1] - a[1])
    for (const [op] of ranked) out.push(op === 'hard_cut' ? 'trim' : op)
  }
  return out
}

export function inspectAndPropose({ diags, tried, force, cheap, lineage, k }) {
  if (force && !tried.includes(force)) return { op: force, why: 'supervisor_redirect' }
  const used = new Set(lastCommittedOps(lineage))
  const prefer = [...priorsFor(diags, k)]
  if (diags.includes('hook_needs_visual')) prefer.push('punch_in', 'graphic', 'caption')
  if (diags.includes('claim_unpaired')) prefer.push('caption_claim', 'broll_swap')
  if (diags.includes('flat_pacing')) prefer.push('trim', 'punch_in')
  if (diags.includes('weak_packaging') || diags.includes('no_captions')) prefer.push('caption', 'graphic')
  if (!diags.includes('quiet_audio')) prefer.push('music_duck')
  prefer.push('sfx', 'speed')
  for (const op of [...prefer, ...cheap]) {
    if (tried.includes(op) || op === 'h3_regen') continue
    if (used.has(op) && diags.length) continue
    return { op, why: 'inspect:' + diags.join(',') }
  }
  for (const op of cheap) {
    if (!tried.includes(op) && op !== 'h3_regen') return { op, why: 'cheap_fallback' }
  }
  return { op: 'trim', why: 'last_resort' }
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
