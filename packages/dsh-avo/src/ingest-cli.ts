#!/usr/bin/env node
// @ts-nocheck
import { ingest } from './ingest.js'

function parseArgv(argv) {
  const args = argv.slice(2)
  const opts = { out: '.', sceneThresh: 0.08, deleteSource: false, noAsr: false, creator: undefined, idPrefix: undefined, force: false }
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') opts.out = args[++i]
    else if (a === '--scene-thresh') opts.sceneThresh = Number(args[++i])
    else if (a === '--delete-source') opts.deleteSource = true
    else if (a === '--no-asr') opts.noAsr = true
    else if (a === '--creator') opts.creator = args[++i]
    else if (a === '--id-prefix') opts.idPrefix = args[++i]
    else if (a === '--force') opts.force = true
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`)
    else positional.push(a)
  }
  return { positional, opts }
}

function usage() {
  return `avo-ingest <file-or-dir> [--out dir] [--scene-thresh 0.08] [--delete-source] [--no-asr] [--creator name] [--id-prefix p] [--force]

Local files only. Requires ffmpeg/ffprobe. GROQ_API_KEY optional (Whisper ASR).
No YouTube/TikTok/yt-dlp. Operator drops files.`
}

const { positional, opts } = parseArgv(process.argv)
if (opts.help || !positional[0]) {
  console.log(usage())
  process.exit(opts.help ? 0 : 1)
}

const results = await ingest(positional[0], opts)
for (const r of results) {
  if (r.skipped) console.log(`skip ${r.id}: ${r.reason}`)
  else console.log(`ok ${r.id} duration=${r.video.duration}s cuts=${r.video.cut_count} events=${r.events.length}`)
}
const last = results.findLast?.((r) => r.summary) || [...results].reverse().find((r) => r.summary)
if (last?.summary) console.log(JSON.stringify(last.summary, null, 2))
