// @ts-nocheck
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, loadJson, loadKnowledge, applyMutation, Lineage } from './loop.js';
import { diagnoseScore } from './inspect.js';
import { Agent } from './agent.js';
const fixture = '/workspace/avo-unofficial/fixtures/local_nasa_edl.json';
const seed = loadJson(fixture);
const k = loadKnowledge();
const base = evaluate(seed, k);
const punched = evaluate(applyMutation(seed, 'punch_in'), k);
const brolled = evaluate(applyMutation(applyMutation(seed, 'punch_in'), 'broll_swap'), k);
const lin = mkdtempSync(join(tmpdir(), 'avo-nasa-'));
const agent = new Agent({ lineage: new Lineage(lin), k, seed }).run(10);
const out = {
    fixture,
    source_looped: base.measured?.source_looped,
    source_duration: base.measured?.source_duration,
    diags: diagnoseScore(base),
    scores: {
        seed: { scalar: base.scalar, f_mode: base.f_mode, firstCut: base.measured?.firstCut, hookCuts: base.measured?.hookCuts, mean_volume: base.measured?.mean_volume },
        punch_in: { scalar: punched.scalar, firstCut: punched.measured?.firstCut, hookCuts: punched.measured?.hookCuts, f_mode: punched.f_mode },
        punch_broll: { scalar: brolled.scalar, firstCut: brolled.measured?.firstCut, hookCuts: brolled.measured?.hookCuts, f_mode: brolled.f_mode },
    },
    agent: { status: agent.status, op: agent.op, why: agent.why, scalar: agent.score?.scalar, tried: agent.tried },
};
console.log(JSON.stringify(out, null, 2));
if (base.f_mode !== 'proxy-windows' || punched.f_mode !== 'proxy-windows')
    process.exit(2);
if (base.measured?.source_looped)
    process.exit(2);
if (!(brolled.scalar > base.scalar))
    process.exit(3);
if (agent.status !== 'commit')
    process.exit(4);
