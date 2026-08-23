# @stepup/dsh-avo

Unofficial Door 1 DeepSeek Harness plugin for EditorAVO (arXiv:2603.24517). Not affiliated with NVIDIA.

Source is TypeScript in `src/`. `lib/` is `tsc` output so the host can load without running prepare.

```sh
dsh plugin --profile web add ./packages/dsh-avo
dsh --profile web --dump-config | grep -F '@stepup/dsh-avo'
```

Tools: `avo.vary`, `avo.lineage`, `avo.evaluate`, `avo.knowledge`.

## Local ingest
See INGEST.md. Example: node lib/ingest-cli.js /path/to/clip.mp4 --out /tmp/avo-genome --scene-thresh 0.08 --no-asr
