# Local ingest (avo-ingest)

Requires ffmpeg/ffprobe. GROQ_API_KEY optional.

node lib/ingest-cli.js /path/to/clip.mp4 --out /tmp/avo-genome --scene-thresh 0.08 --creator mydesk --id-prefix local_ --no-asr

Operator supplies local files only. No remote fetchers.
Writes videos.jsonl events.jsonl beats.jsonl run_summary.json. ASR cache: out/cache/<id>.asr.json.
Punch-in: PUNCHIN_CROP 0.78 center-crop prev vs next like editing-genome/tools/decompile.py; otherwise hard_cut.

More flags: --force --delete-source (unlink input after successful write).
