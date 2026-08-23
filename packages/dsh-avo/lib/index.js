import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from 'schemastery'
import { evaluate, loadJson, loadKnowledge, Lineage, runVary } from './loop.js'

export const name = 'avo'
export const inject = ['tools']

const ROOT = '/workspace/avo-unofficial'
const GENOME = '/workspace/editing-genome'

export const Config = Schema.object({
  root: Schema.string().default(ROOT),
  genome: Schema.string().default(GENOME),
  lineage: Schema.string().default(resolve(ROOT, 'lineage')),
})

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
    description: 'One EditorAVO Agent(P,K,f) step on an EDL JSON. In-process. Cheap mutations only.',
    parameters: {
      fixture: { type: 'string', description: 'Path to EDL JSON' },
      steps: { type: 'number', description: 'Outer vary steps', default: 1 },
      lineageDir: { type: 'string', description: 'Lineage directory' },
    },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return runVary({
        fixture: args.fixture || resolve(root, 'fixtures/seed_edl.json'),
        lineageDir: args.lineageDir || lineage,
        steps: args.steps ?? 1,
        genomeDir: genome,
      })
    },
  })), 'avo:avo.vary')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.lineage',
    description: 'List committed EditorAVO versions and scores (P).',
    parameters: { lineageDir: { type: 'string', description: 'Lineage directory' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const lin = new Lineage(args.lineageDir || lineage)
      return lin.index
    },
  })), 'avo:avo.lineage')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.evaluate',
    description: 'Score vector f(x) for an EDL JSON path. Failed correctness zeros the vector.',
    parameters: { edl: { type: 'string', required: true, description: 'EDL JSON path' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return evaluate(loadJson(args.edl), loadKnowledge(genome))
    },
  })), 'avo:avo.evaluate')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'avo.knowledge',
    description: 'Retrieve K from the editing genome when present.',
    parameters: { genomeDir: { type: 'string', description: 'Genome directory' } },
    output: jsonOut,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      return loadKnowledge(args.genomeDir || genome)
    },
  })), 'avo:avo.knowledge')

  ctx.logger?.info?.('avo: loaded (@stepup/dsh-avo Door 1, in-process JS loop)')
}
