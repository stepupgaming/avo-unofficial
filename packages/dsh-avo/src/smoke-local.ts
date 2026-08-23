// @ts-nocheck
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, loadJson, loadKnowledge, Lineage } from './loop.js'
import { inspectEdl } from './inspect.js'
import { Agent } from './agent.js'

function runOne(fixture) {
  const seed = loadJson(fixture)
  const k = loadKnowledge()
  const base = evaluate(seed, k)
  const view = inspectEdl(seed, base)
  const lin = mkdtempSync(join(tmpdir(), 'avo-loc-'))
  const agent = new Agent({ lineage: new Lineage(lin), k, seed }).run(12)
  return {
    fixture,
    source_looped: base.measured?.source_looped,
    source_duration: base.measured?.source_duration,
    firstCut: base.measured?.firstCut,
    hookCuts: base.measured?.hookCuts,
    mean_volume: base.measured?.mean_volume,
    scalar: base.scalar,
    f_mode: base.f_mode,
    gaps: view.gaps,
    agent: { status: agent.status, op: agent.op, why: agent.why, scalar: agent.score?.scalar, tried: agent.tried },
  }
}

const out = [
  runOne('/workspace/avo-unofficial/fixtures/local_nasa_edl.json'),
  runOne('/workspace/avo-unofficial/fixtures/local_ice_edl.json'),
]
console.log(JSON.stringify(out, null, 2))
if (out.some((x) => x.f_mode !== 'proxy-windows' || x.source_looped)) process.exit(2)
if (out.some((x) => x.agent.status !== 'commit')) process.exit(3)
