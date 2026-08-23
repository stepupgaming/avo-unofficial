import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVary } from './loop.js'
const lin = mkdtempSync(join(tmpdir(), 'avo-'))
const r = runVary({ fixture: '/workspace/avo-unofficial/fixtures/seed_edl.json', lineageDir: lin, steps: 3 })
console.log(JSON.stringify(r.map((x) => ({ status: x.status, op: x.op, tried: x.tried, scalar: x.score && x.score.scalar })), null, 2))
