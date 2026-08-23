// @ts-nocheck
import { loadJson, loadKnowledge, Lineage } from './loop.js'
import { Agent } from './agent.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function runVary({ fixture, lineageDir, steps = 1, genomeDir }) {
  const seed = loadJson(fixture)
  const lineage = new Lineage(lineageDir)
  const k = loadKnowledge(genomeDir)
  const results = []
  for (let i = 0; i < steps; i++) {
    results.push(new Agent({ lineage, k, seed }).run(10))
  }
  return results
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('run-agent.js')) {
  const lin = mkdtempSync(join(tmpdir(), 'avo-ag-'))
  const r = runVary({ fixture: '/workspace/avo-unofficial/fixtures/seed_edl.json', lineageDir: lin, steps: 3, genomeDir: process.env.AVO_GENOME || '/workspace/editing-genome' })
  console.log(JSON.stringify(r.map((x) => ({
    status: x.status, op: x.op, why: x.why, tried: x.tried,
    tools: (x.transcript || []).map((t) => t.tool),
    scalar: x.score && x.score.scalar,
  })), null, 2))
}
