// @ts-nocheck
import { loadJson, evaluate, loadKnowledge, applyMutation } from './loop.js'

const seed = loadJson('/workspace/avo-unofficial/fixtures/seed_edl.json')
const k = loadKnowledge()
const a = evaluate(seed, k)
const punched = applyMutation(seed, 'punch_in')
const b = evaluate(punched, k)
const brolled = applyMutation(punched, 'broll_swap')
const c = evaluate(brolled, k)
const out = [a, b, c].map((s, i) => ({
  name: ['seed', 'punch_in', 'punch+broll'][i],
  f_mode: s.f_mode,
  correctness: s.correctness,
  reasons: s.correctness_reasons,
  scalar: s.scalar,
  measured: s.measured,
}))
console.log(JSON.stringify(out, null, 2))
if (out.some((x) => x.f_mode !== 'proxy-windows' || !x.correctness)) process.exit(2)
