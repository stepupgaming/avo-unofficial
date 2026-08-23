# @stepup/dsh-avo

Unofficial Door 1 DeepSeek Harness plugin for EditorAVO (arXiv:2603.24517). Not affiliated with NVIDIA.

Install (persists; do not use `--patch` as the ship form):

```sh
dsh plugin --profile web add ./packages/dsh-avo
dsh --profile web --dump-config | grep -F '@stepup/dsh-avo'
```

Tools: `avo.vary`, `avo.lineage`, `avo.evaluate`, `avo.knowledge`.
