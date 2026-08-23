import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from 'schemastery'

export const name = 'avo'
export const inject = ['tools']

const ROOT = '/workspace/avo-unofficial'
const GENOME = '/workspace/editing-genome'

export const Config = Schema.object({
  root: Schema.string().default(ROOT),
  genome: Schema.string().default(GENOME),
  lineage: Schema.string().default(resolve(ROOT, 'lineage')),
})

function runPy(args, cwd, signal) {
  return new Promise((res, rej) => {
    const child = spawn('python3', ['-m', 'editor_avo', ...args], {
      cwd,
      env: { ...process.env, PYTHONPATH: cwd },
    })
    let out = ''
    let err = ''
    const onAbort = () => child.kill('SIGTERM')
    signal?.addEventListener?.('abort', onAbort)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', rej)
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort)
      if (code === 0) res(out)
      else rej(new Error(err || out || `exit ${code}`))
    })
  })
}

function parseJson(text) {
  const t = text.trim()
  try { return JSON.parse(t) } catch { return { raw: t } }
}

export function apply(ctx, config = {}) {
  const root = config.root || ROOT
  const genome = config.genome || GENOME
  const lineage = config.lineage || resolve(root, 'lineage')
  const jsonOut = {
    schema: { type: 'object', additionalProperties: true, properties: {} },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.vary',
    description: 'One EditorAVO Agent(P,K,f) variation step on an EDL/timeline JSON. Cheap mutations only.',
    parameters: {
      fixture: { type: 'string', description: 'Path to EDL JSON' },
      steps: { type: 'number', description: 'Outer vary steps', default: 1 },
      lineageDir: { type: 'string', description: 'Lineage directory' },
    },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const fixture = args.fixture || resolve(root, 'fixtures/seed_edl.json')
      const lin = args.lineageDir || lineage
      const steps = String(args.steps ?? 1)
      const out = await runPy(['vary', '--fixture', fixture, '--lineage', lin, '--steps', steps], root, exec?.signal)
      return parseJson(out)
    },
  })), 'avo:avo.vary')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.lineage',
    description: 'List committed EditorAVO versions and scores (P).',
    parameters: { lineageDir: { type: 'string', description: 'Lineage directory' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const lin = args.lineageDir || lineage
      const idx = resolve(lin, 'index.json')
      if (!existsSync(idx)) return { committed: [], trajectory: [] }
      return JSON.parse(readFileSync(idx, 'utf8'))
    },
  })), 'avo:avo.lineage')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.evaluate',
    description: 'Score vector f(x) for an EDL JSON path. Failed correctness zeros the vector.',
    parameters: { edl: { type: 'string', required: true, description: 'EDL JSON path' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const out = await runPy(['score', args.edl], root, exec?.signal)
      return parseJson(out)
    },
  })), 'avo:avo.evaluate')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.knowledge',
    description: 'Retrieve K from the editing genome when present.',
    parameters: { genomeDir: { type: 'string', description: 'Genome directory' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const g = args.genomeDir || genome
      const out = await runPy(['knowledge', '--genome', g], root, exec?.signal)
      return parseJson(out)
    },
  })), 'avo:avo.knowledge')

  ctx.logger?.info?.('avo: loaded (@stepup/dsh-avo Door 1)')
}
