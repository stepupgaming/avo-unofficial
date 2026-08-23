// @ts-nocheck
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const SAMPLE = '/workspace/editing-genome/samples';
const PROXY_DIR = join(tmpdir(), 'avo-proxy');
const PROXY_S = 8;
const FIXTURE_MAP = {
    'fixture://a-roll': resolve(SAMPLE, 'synth_talkinghead_pattern.mp4'),
    'fixture://vo': resolve(SAMPLE, 'synth_talkinghead_pattern.mp4'),
    'fixture://library-broll': resolve(SAMPLE, 'nasa_greenland.mp4'),
};
export function resolveSrc(src) {
    if (!src)
        return null;
    if (FIXTURE_MAP[src])
        return FIXTURE_MAP[src];
    if (existsSync(src))
        return src;
    return null;
}
function edlDuration(edl) {
    const videos = edl.tracks?.video || [];
    if (!videos.length)
        return Number(edl.target_duration_s || 0);
    return Math.max(...videos.map((c) => Number(c.t1 || 0)));
}
function ffprobe(path) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
        encoding: 'utf8',
        timeout: 20000,
    });
    if (r.status !== 0)
        throw new Error(r.stderr || 'ffprobe failed');
    const data = JSON.parse(r.stdout);
    const v = (data.streams || []).find((s) => s.codec_type === 'video');
    const a = (data.streams || []).find((s) => s.codec_type === 'audio');
    if (!v)
        throw new Error('no video stream');
    const w = Number(v.width);
    const h = Number(v.height);
    const dur = Number(data.format?.duration || v.duration || 0);
    const ratio = w / h;
    let aspect = `${w}:${h}`;
    if (Math.abs(ratio - 9 / 16) < 0.03)
        aspect = '9:16';
    else if (Math.abs(ratio - 16 / 9) < 0.03)
        aspect = '16:9';
    return { width: w, height: h, duration: dur, aspect, has_audio: Boolean(a), path };
}
function sceneCuts(path, thresh = 0.08) {
    const r = spawnSync('ffmpeg', [
        '-hide_banner', '-i', path,
        '-vf', `select=gt(scene\\,${thresh}),showinfo`,
        '-vsync', 'vfr', '-f', 'null', '-',
    ], { encoding: 'utf8', timeout: 60000 });
    const times = [];
    for (const line of String(r.stderr || '').split('\n')) {
        if (!line.includes('pts_time:'))
            continue;
        const t = parseFloat(line.split('pts_time:')[1]);
        if (!Number.isNaN(t))
            times.push(Math.round(t * 1000) / 1000);
    }
    return [...new Set(times)].sort((a, b) => a - b);
}
function scale9x16(labelIn, labelOut, crop) {
    const c = Number(crop || 1);
    const zoom = c > 1.05 ? `crop=iw/${c}:ih/${c},` : '';
    return `[${labelIn}]${zoom}scale=540:960:force_original_aspect_ratio=increase,crop=540:960[${labelOut}]`;
}
export function renderProxy(edl, outPath) {
    const videos = edl.tracks?.video || [];
    const aroll = resolveSrc(videos[0]?.src);
    if (!aroll)
        throw new Error('no resolvable a-roll');
    const dur = Math.min(PROXY_S, Math.max(1, edlDuration(edl)));
    const brolls = (edl.tracks?.broll || []).filter((b) => Number(b.t0 || 0) < dur && resolveSrc(b.src));
    const args = ['-y', '-hide_banner', '-stream_loop', '-1', '-i', aroll];
    const brollPaths = [];
    for (const b of brolls.slice(0, 2)) {
        const p = resolveSrc(b.src);
        brollPaths.push({ ...b, path: p });
        args.push('-stream_loop', '-1', '-i', p);
    }
    const filters = [scale9x16('0:v', 'base', videos[0]?.crop)];
    let last = 'base';
    brollPaths.forEach((b, i) => {
        const inn = `${i + 1}:v`;
        const mid = `br${i}`;
        const out = `ov${i}`;
        filters.push(scale9x16(inn, mid, 1));
        const t0 = Number(b.t0 || 0);
        const t1 = Math.min(Number(b.t1 || t0 + 1), dur);
        filters.push(`[${last}][${mid}]overlay=0:0:enable='between(t\\,${t0}\\,${t1})'[${out}]`);
        last = out;
    });
    args.push('-t', String(dur), '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', outPath);
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !existsSync(outPath)) {
        throw new Error((r.stderr || 'ffmpeg proxy failed').slice(-800));
    }
    return outPath;
}
function proxyKey(edl) {
    const payload = {
        v: (edl.tracks?.video || []).slice(0, 3).map((c) => [c.src, c.t0, c.t1, c.crop]),
        b: (edl.tracks?.broll || []).slice(0, 3).map((c) => [c.src, c.t0, c.t1]),
        d: edlDuration(edl),
    };
    return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
export function measurePath(path) {
    const meta = ffprobe(path);
    const cuts = sceneCuts(path, 0.08);
    const firstCut = cuts.length ? cuts[0] : meta.duration;
    return { ...meta, cuts, firstCut, nCuts: cuts.length };
}
export function measureEdl(edl) {
    const src = resolveSrc(edl.tracks?.video?.[0]?.src);
    if (!src)
        return null;
    mkdirSync(PROXY_DIR, { recursive: true });
    const out = join(PROXY_DIR, `${proxyKey(edl)}.mp4`);
    try {
        if (!existsSync(out))
            renderProxy(edl, out);
        const measured = measurePath(out);
        return {
            ...measured,
            edl_duration: edlDuration(edl),
            proxy_s: PROXY_S,
        };
    }
    catch (e) {
        return { error: String(e.message || e), edl_duration: edlDuration(edl) };
    }
}
export function blendMeasured(dummy, measured, edl) {
    if (!measured || measured.error) {
        return { ...dummy, measured: measured || null, f_mode: 'dummy_only' };
    }
    const reasons = [...(dummy.correctness_reasons || [])];
    const d = measured.edl_duration != null ? measured.edl_duration : measured.duration;
    if (measured.aspect !== '9:16')
        reasons.push('measured_aspect');
    if (d < 15 || d > 60)
        reasons.push('measured_duration');
    if (!measured.has_audio)
        reasons.push('measured_no_audio');
    const ok = reasons.length === 0 && dummy.correctness;
    if (!ok) {
        const vector = Object.fromEntries(Object.keys(dummy.vector || {}).map((k) => [k, 0]));
        return { correctness: false, correctness_reasons: reasons, vector, scalar: 0, measured, f_mode: 'measured_gate' };
    }
    const hookBy = 1.0;
    let firstVisual = measured.firstCut;
    for (const c of edl?.tracks?.video || []) {
        if (Number(c.crop || 1) > 1.05)
            firstVisual = Math.min(firstVisual, Number(c.t0 || 0));
    }
    for (const c of edl?.tracks?.broll || [])
        firstVisual = Math.min(firstVisual, Number(c.t0 || 0));
    const attention = firstVisual <= hookBy ? 1 : Math.max(0, 1 - (firstVisual - hookBy) / 8);
    const cps = measured.duration > 0 ? measured.nCuts / measured.duration : 0;
    let visual = attention * 0.5 + Math.min(0.5, measured.nCuts * 0.08);
    if (firstVisual > 2.2)
        visual = Math.max(0, visual - 0.2);
    let pacing = dummy.vector.pacing;
    if (cps > 1.2)
        pacing = Math.min(pacing, 0.45);
    if (cps === 0 && d > 20)
        pacing = Math.min(pacing, 0.35);
    const vector = {
        ...dummy.vector,
        attention_support: attention,
        visual_novelty: visual,
        pacing,
        audiovisual_sync: measured.has_audio ? Math.max(dummy.vector.audiovisual_sync, 0.5) : 0,
    };
    const pos = ['narrative_clarity', 'semantic_alignment', 'visual_novelty', 'pacing', 'attention_support', 'audiovisual_sync', 'youtube_prior'];
    vector.holistic_vlm_quality = 0.9 * pos.reduce((s, k) => s + vector[k], 0) / pos.length;
    const scalar = pos.reduce((s, k) => s + vector[k], 0) + vector.holistic_vlm_quality
        - (vector.repetition + vector.overediting + vector.distraction);
    return {
        ...dummy,
        correctness: true,
        correctness_reasons: [],
        vector,
        scalar: Math.round(scalar * 1e6) / 1e6,
        measured: {
            edl_duration: d,
            proxy_duration: measured.duration,
            aspect: measured.aspect,
            firstCut: measured.firstCut,
            nCuts: measured.nCuts,
            path: measured.path,
        },
        f_mode: 'proxy+edl',
    };
}
