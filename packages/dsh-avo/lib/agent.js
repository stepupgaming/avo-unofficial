// @ts-nocheck
import { applyMutation, evaluate, loadJson, loadKnowledge, Lineage, CHEAP } from './loop.js';
import { diagnoseScore } from './inspect.js';
function weakestKeys(vector, n = 2) {
    return Object.entries(vector || {})
        .filter(([k]) => !['repetition', 'overediting', 'distraction'].includes(k))
        .sort((a, b) => a[1] - b[1])
        .slice(0, n)
        .map(([k]) => k);
}
function pickOp(memory) {
    const tried = new Set(memory.tried);
    const committed = new Set((memory.lineageSummary.committedNotes || []).filter((x) => x !== 'seed'));
    const cheap = memory.cheap;
    const weak = memory.weakKeys || [];
    const map = {
        attention_support: ['punch_in', 'graphic', 'caption'],
        semantic_alignment: ['caption_claim', 'broll_swap'],
        pacing: ['trim', 'punch_in'],
        youtube_prior: ['caption', 'graphic'],
        audiovisual_sync: ['music_duck', 'sfx'],
        visual_novelty: ['punch_in', 'broll_swap', 'graphic'],
        narrative_clarity: ['caption', 'trim'],
    };
    const diags = memory.diags || [];
    if (diags.includes('hook_needs_visual') && !tried.has('punch_in') && !committed.has('punch_in')) {
        return { op: 'punch_in', reason: 'measured:firstCut' };
    }
    if (diags.includes('flat_pacing') && !tried.has('broll_swap') && !committed.has('broll_swap')) {
        return { op: 'broll_swap', reason: 'measured:hookCuts' };
    }
    const kHints = (memory.kHints || []).filter((op) => !tried.has(op) && !committed.has(op) && op !== 'h3_regen' && !(op === 'music_duck' && diags.includes('quiet_audio')));
    if (kHints.length)
        return { op: kHints[0], reason: 'k_prior' };
    for (const key of weak) {
        for (const op of map[key] || []) {
            if (!tried.has(op) && !committed.has(op) && op !== 'h3_regen')
                return { op, reason: 'weak:' + key };
        }
    }
    for (const op of cheap) {
        if (!tried.has(op) && !committed.has(op) && op !== 'h3_regen')
            return { op, reason: 'untried_cheap' };
    }
    return { op: 'trim', reason: 'fallback' };
}
export class Agent {
    constructor({ lineage, k, seed }) {
        this.lineage = lineage;
        this.k = k;
        this.cheap = k.cheap_first || CHEAP;
        this.seed = seed;
        this.memory = {
            inspectedLineage: false,
            inspectedK: false,
            diagnosed: false,
            tried: [],
            transcript: [],
            cheap: this.cheap,
        };
    }
    log(tool, detail) {
        this.memory.transcript.push({ tool, detail, t: Date.now() });
    }
    inspectLineage() {
        const committed = this.lineage.index.committed || [];
        const notes = committed.map((c) => c.note);
        const last = committed[committed.length - 1];
        this.memory.lineageSummary = {
            n: committed.length,
            committedNotes: notes,
            bestScalar: this.lineage.best()?.scalar ?? null,
            lastNote: last?.note || null,
            lastScalar: last?.scalar ?? null,
        };
        this.memory.inspectedLineage = true;
        this.log('inspect_lineage', this.memory.lineageSummary);
        return this.memory.lineageSummary;
    }
    inspectK() {
        const rows = this.k?.priors?.hypothesized?.P_action_given_state || [];
        const hints = [];
        for (const row of rows) {
            if (!row.P)
                continue;
            const ranked = Object.entries(row.P).sort((a, b) => b[1] - a[1]);
            for (const [op] of ranked)
                hints.push(op === 'hard_cut' ? 'trim' : op);
        }
        this.memory.kHints = hints;
        this.memory.inspectedK = true;
        this.log('inspect_k', { hints: hints.slice(0, 8), hook_by: this.k.hook_visual_by_s });
        return this.memory.kHints;
    }
    diagnose(score) {
        const weak = weakestKeys(score.vector);
        this.memory.weakKeys = weak;
        this.memory.diags = diagnoseScore(score);
        this.memory.diagnosed = true;
        this.memory.lastScore = score;
        this.log('diagnose', { weak, scalar: score.scalar, correctness: score.correctness });
        return weak;
    }
    decide() {
        if (!this.memory.inspectedLineage)
            return { tool: 'inspect_lineage' };
        if (!this.memory.inspectedK)
            return { tool: 'inspect_k' };
        if (!this.memory.diagnosed)
            return { tool: 'diagnose' };
        if (!this.memory.candidate)
            return { tool: 'mutate' };
        if (!this.memory.candidateScore)
            return { tool: 'evaluate' };
        if (this.memory.candidateScore.correctness && this.memory.candidateScore.scalar + 1e-9 >= (this.memory.bestScalar ?? -Infinity)) {
            return { tool: 'commit' };
        }
        return { tool: 'discard' };
    }
    run(inner = 8) {
        let parent = this.lineage.best()?.path ? loadJson(this.lineage.best().path) : JSON.parse(JSON.stringify(this.seed));
        let parentScore = evaluate(parent, this.k);
        if (!this.lineage.index.committed.length)
            this.lineage.commit(parent, parentScore, 'seed');
        this.memory.bestScalar = this.lineage.best()?.scalar ?? parentScore.scalar;
        this.memory.parent = parent;
        this.memory.parentScore = parentScore;
        let last = { status: 'noop' };
        for (let i = 0; i < inner; i++) {
            const step = this.decide();
            if (step.tool === 'inspect_lineage') {
                this.inspectLineage();
                continue;
            }
            if (step.tool === 'inspect_k') {
                this.inspectK();
                continue;
            }
            if (step.tool === 'diagnose') {
                this.diagnose(this.memory.parentScore);
                continue;
            }
            if (step.tool === 'mutate') {
                const pick = pickOp(this.memory);
                this.memory.tried.push(pick.op);
                try {
                    this.memory.candidate = applyMutation(this.memory.parent, pick.op);
                    this.memory.pick = pick;
                    this.memory.candidateScore = null;
                    this.log('mutate', pick);
                }
                catch (e) {
                    this.lineage.record(pick.op, null, 'error', String(e.message || e));
                    last = { status: 'error', op: pick.op, detail: String(e.message || e) };
                    this.memory.candidate = null;
                }
                continue;
            }
            if (step.tool === 'evaluate') {
                const score = evaluate(this.memory.candidate, this.k);
                this.memory.candidateScore = score;
                this.log('evaluate', { scalar: score.scalar, correctness: score.correctness });
                continue;
            }
            if (step.tool === 'commit') {
                const rec = this.lineage.commit(this.memory.candidate, this.memory.candidateScore, this.memory.pick.op);
                this.lineage.record(this.memory.pick.op, this.memory.candidateScore, 'commit', rec.id);
                last = {
                    status: 'commit',
                    op: this.memory.pick.op,
                    score: this.memory.candidateScore,
                    id: rec.id,
                    why: this.memory.pick.reason,
                    transcript: this.memory.transcript,
                    tried: this.memory.tried,
                };
                return last;
            }
            if (step.tool === 'discard') {
                const score = this.memory.candidateScore;
                this.lineage.record(this.memory.pick.op, score, 'discard', 'no_improve_or_correctness');
                last = { status: 'discard', op: this.memory.pick.op, score, why: this.memory.pick.reason };
                this.memory.candidate = null;
                this.memory.candidateScore = null;
                this.memory.diagnosed = false;
                this.diagnose(score);
                continue;
            }
        }
        last.transcript = this.memory.transcript;
        last.tried = this.memory.tried;
        return last;
    }
}
export function runVary({ fixture, lineageDir, steps = 1, genomeDir }) {
    const seed = loadJson(fixture);
    const lineage = new Lineage(lineageDir);
    const k = loadKnowledge(genomeDir);
    const results = [];
    for (let i = 0; i < steps; i++)
        results.push(new Agent({ lineage, k, seed }).run(10));
    return results;
}
