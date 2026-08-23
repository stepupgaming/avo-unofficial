// @ts-nocheck
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const SAMPLE = '/workspace/editing-genome/samples';
const PROXY_DIR = join(tmpdir(), 'avo-proxy');
const HOOK_S = 8;
const LATE_S = 3;
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
function scaleChain(crop) {
    const c = Number(crop || 1);
    const zoom = c > 1.05 ? `crop=iw/${c}:ih/${c},` : '';
    return `${zoom}scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=30,format=yuv420p,setsar=1`;
}
function clipAt(clips, t) {
    const hit = clips.filter((c) => Number(c.t0 || 0) <= t && Number(c.t1 || 0) > t);
    return hit[0] || clips[0] || null;
}
function segments(edl, w0, w1) {
    const clips = edl.tracks?.video || [];
    const edges = new Set([w0, w1]);
    for (const c of clips) {
        const a = Number(c.t0 || 0);
        const b = Number(c.t1 || 0);
        if (a > w0 && a < w1)
            edges.add(a);
        if (b > w0 && b < w1)
            edges.add(b);
    }
    const times = [...edges].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < times.length - 1; i++) {
        const a = times[i];
        const b = times[i + 1];
        if (b - a < 0.04)
            continue;
        const clip = clipAt(clips, (a + b) / 2);
        if (!clip)
            continue;
        out.push({ t0: a, t1: b, clip });
    }
    return out;
}
export function renderWindow(edl, w0, w1, outPath) {
    const clips = edl.tracks?.video || [];
    const aroll = resolveSrc(clips[0]?.src);
    if (!aroll)
        throw new Error('no resolvable a-roll');
    const segs = segments(edl, w0, w1);
    if (!segs.length)
        throw new Error('empty window');
    const brolls = (edl.tracks?.broll || []).filter((b) => Number(b.t1 || 0) > w0 && Number(b.t0 || 0) < w1 && resolveSrc(b.src));
    const inputs = ['-y', '-hide_banner', '-stream_loop', '-1', '-i', aroll];
    const brollPaths = [];
    for (const b of brolls.slice(0, 2)) {
        const path = resolveSrc(b.src);
        brollPaths.push({ ...b, path });
        inputs.push('-stream_loop', '-1', '-i', path);
    }
    const filters = [];
    const labels = [];
    segs.forEach((s, i) => {
        const lab = `s${i}`;
        filters.push(`[0:v]trim=${s.t0}:${s.t1},setpts=PTS-STARTPTS,${scaleChain(s.clip.crop)}[${lab}]`);
        labels.push(`[${lab}]`);
    });
    let last = 'base';
    if (labels.length === 1) {
        last = labels[0].slice(1, -1);
    }
    else {
        filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[base]`);
    }
    brollPaths.forEach((b, i) => {
        const mid = `br${i}`;
        const ov = `ov${i}`;
        const t0 = Math.max(0, Number(b.t0 || 0) - w0);
        const t1 = Math.min(w1 - w0, Number(b.t1 || 0) - w0);
        filters.push(`[${i + 1}:v]${scaleChain(1)}[${mid}]`);
        filters.push(`[${last}][${mid}]overlay=0:0:enable='between(t\\,${t0}\\,${t1})'[${ov}]`);
        last = ov;
    });
    const args = [
        ...inputs,
        '-filter_complex', filters.join(';'),
        '-map', `[${last}]`,
        '-map', '0:a?',
        '-t', String(Math.max(0.2, w1 - w0)),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        '-shortest',
        outPath,
    ];
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0 || !existsSync(outPath)) {
        throw new Error((r.stderr || 'ffmpeg proxy failed').slice(-800));
    }
    return outPath;
}
function proxyKey(edl, tag, w0, w1) {
    const payload = {
        tag, w0, w1,
        v: (edl.tracks?.video || []).slice(0, 4).map((c) => [c.src, c.t0, c.t1, c.crop]),
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
function measureWindow(edl, w0, w1, tag) {
    mkdirSync(PROXY_DIR, { recursive: true });
    const out = join(PROXY_DIR, `${proxyKey(edl, tag, w0, w1)}.mp4`);
    try {
        if (!existsSync(out))
            renderWindow(edl, w0, w1, out);
        return { ...measurePath(out), window: [w0, w1], tag };
    }
    catch (e) {
        try {
            renderWindow(edl, w0, w1, out);
        }
        catch (e2) {
            throw e2;
        }
        return { ...measurePath(out), window: [w0, w1], tag };
    }
}
export function measureEdl(edl) {
    const src = resolveSrc(edl.tracks?.video?.[0]?.src);
    if (!src)
        return null;
    const d = edlDuration(edl);
    try {
        const hookEnd = Math.min(HOOK_S, Math.max(1, d));
        const hook = measureWindow(edl, 0, hookEnd, 'hook');
        let late = null;
        if (d > 20) {
            const payoff = Number((edl.beats || []).find((b) => b.name === 'payoff')?.t_start);
            const late0 = Number.isFinite(payoff) ? payoff : Math.max(0, d * 0.7);
            const late1 = Math.min(d, late0 + LATE_S);
            if (late1 - late0 >= 1)
                late = measureWindow(edl, late0, late1, 'late');
        }
        return {
            ...hook,
            edl_duration: d,
            hook,
            late,
            nCuts: hook.nCuts + (late?.nCuts || 0),
            firstCut: hook.firstCut,
        };
    }
    catch (e) {
        return { error: String(e.message || e), edl_duration: d };
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
    const hookCuts = measured.hook?.nCuts ?? measured.nCuts;
    const lateCuts = measured.late?.nCuts ?? 0;
    const hookDur = measured.hook?.duration || measured.duration || 1;
    const cps = hookCuts / hookDur;
    let visual = attention * 0.45 + Math.min(0.35, hookCuts * 0.08) + Math.min(0.2, lateCuts * 0.07);
    if (firstVisual > 2.2)
        visual = Math.max(0, visual - 0.2);
    let pacing = dummy.vector.pacing;
    if (cps > 1.2)
        pacing = Math.min(pacing, 0.45);
    if (hookCuts === 0 && d > 20)
        pacing = Math.min(pacing, 0.35);
    if (measured.late && lateCuts === 0 && hookCuts <= 1)
        pacing = Math.min(pacing, 0.4);
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
            aspect: measured.aspect,
            firstCut: measured.firstCut,
            hookCuts,
            lateCuts,
            lateWindow: measured.late?.window || null,
            path: measured.path,
        },
        f_mode: 'proxy-windows',
    };
}
