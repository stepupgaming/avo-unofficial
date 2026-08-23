# Operator: your own clips

You bring the files. This repo does not fetch YouTube or TikTok.

## Inbox

Put clips in `operator/inbox/`.

## Ingest

From the repo root:

```sh
./scripts/ingest.sh
```

That reads `operator/inbox` and writes jsonl into `operator/out` (or `$AVO_GENOME` if set). Optional flags pass through to `avo-ingest` (`--no-asr`, `--force`, `--creator`).

## Knowledge

Set `AVO_GENOME` to that out directory. `loadKnowledge` / `avo.vary` read `videos.jsonl`, `events.jsonl`, and `beats.jsonl` from there. No extra NASA fixtures.
