# avo-unofficial

Unofficial reimplementation of **NVIDIA AVO** (Agentic Variation Operators, [arXiv:2603.24517](https://arxiv.org/abs/2603.24517)) for evolutionary / agentic search.

**Not affiliated with NVIDIA.** This is an independent reading of the paper’s *operator*, bound to a new environment.

Paper: `Vary(P_t) = Agent(P_t, K, f)` — the variation operator is an agent loop (inspect → edit → evaluate → diagnose → commit), not a single LLM generate. The paper’s environment was CUDA kernels on Blackwell. **Our first target is editing:** 30–60s vertical shorts as EDL / timeline JSON.

## Layout

- `editor_avo/` — lineage store `P`, knowledge `K`, dummy evaluator `f`, cheap mutations, agent + supervisor
- `fixtures/seed_edl.json` — weak talking-head EDL so a cheap mutation can win
- Knowledge is loaded from `/workspace/editing-genome/` when present (SCHEMA, priors, paper-map)

## Run one variation step (no LLM)

```bash
python -m editor_avo vary --fixture fixtures/seed_edl.json --steps 1
```

## Run via OpenCode (free slugs only)

Authless. Only `*-free` model slugs. Do not put paid API keys in front of OpenCode.

```bash
opencode run --auto --model opencode/nemotron-3.5-lightning-free \
  "Run one EditorAVO variation step: python -m editor_avo vary --fixture fixtures/seed_edl.json --steps 1. Cheap mutations only. No H3. No YouTube."
```

If `ox-alpha-free` appears in `opencode models`, prefer that.

## Policy

- Cheap mutations first (trim, reorder, crop, speed, captions, graphics, existing B-roll, SFX/music).
- Minimax H3 / pixel regen is last and **stubbed** in v0.
- Do not optimize for more zooms / captions / SFX.
- Failed correctness zeros the score vector (paper analog).
