# avo-unofficial

Unofficial reimplementation of NVIDIA AVO (Agentic Variation Operators, [arXiv:2603.24517](https://arxiv.org/abs/2603.24517)) for evolutionary / agentic search.
To run on your own files, see [OPERATOR.md](OPERATOR.md).


Not affiliated with NVIDIA. Independent reading of the paper's operator, bound to a new environment.

Paper: `Vary(P_t) = Agent(P_t, K, f)`. The variation operator is an agent loop (inspect lineage, inspect K, diagnose, edit, evaluate, commit or discard), not a single generate. The paper's environment was CUDA kernels. First target here is editing: 30-60s vertical shorts as EDL / timeline JSON.

## Product

`packages/dsh-avo` is a Door 1 DeepSeek Harness plugin. The loop is TypeScript in packages/dsh-avo/src. lib is compiled output. There is no Python.

```sh
dsh plugin --profile web add ./packages/dsh-avo
dsh --profile web --dump-config | grep -F '@stepup/dsh-avo'
```

Tools: `avo.vary`, `avo.lineage`, `avo.evaluate`, `avo.knowledge`.

Smoke the loop without the host:

```sh
node packages/dsh-avo/lib/run-agent.js
```

Fixtures: `fixtures/seed_edl.json`. Knowledge is loaded from `/workspace/editing-genome/` when present.

## Policy

- Cheap mutations first. Minimax H3 is stubbed and refused.
- Do not optimize for more zooms, captions, or SFX.
- Failed correctness zeros the score vector.
