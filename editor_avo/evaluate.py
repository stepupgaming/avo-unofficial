"""Dummy f(x): heuristic score vector. Failed correctness zeros all scores."""

from __future__ import annotations

from typing import Any

from editor_avo.edl import correctness, duration_s, event_count
from editor_avo.knowledge import load_knowledge

POS = [
    "narrative_clarity",
    "semantic_alignment",
    "visual_novelty",
    "pacing",
    "attention_support",
    "audiovisual_sync",
    "youtube_prior",
    "holistic_vlm_quality",
]
PEN = ["repetition", "overediting", "distraction"]


def _clip(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def evaluate(edl: dict[str, Any], k: dict[str, Any] | None = None) -> dict[str, Any]:
    k = k or load_knowledge()
    ok, reasons = correctness(edl)
    if not ok:
        vec = {n: 0.0 for n in POS + PEN}
        return {
            "correctness": False,
            "correctness_reasons": reasons,
            "vector": vec,
            "scalar": 0.0,
        }

    tracks = edl.get("tracks") or {}
    beats = {b["name"]: b for b in (edl.get("beats") or []) if "name" in b}
    needed = ("hook", "setup", "payoff", "close")
    narrative = sum(1 for n in needed if n in beats) / 4.0

    captions = tracks.get("captions") or []
    broll = tracks.get("broll") or []
    sfx = tracks.get("sfx") or []
    graphics = tracks.get("graphics") or []
    videos = tracks.get("video") or []

    claim_paired = any(
        abs(float(c.get("t0", 0)) - float((beats.get("setup") or {}).get("t_start") or 3)) < 2.0
        for c in captions + broll
    )
    semantic = 0.85 if claim_paired else 0.25

    first_change = 99.0
    for c in videos:
        if float(c.get("crop") or 1) > 1.05 or float(c.get("t0") or 0) > 0:
            first_change = min(first_change, float(c.get("t0") or 0))
    for c in broll + graphics + captions:
        first_change = min(first_change, float(c.get("t0") or 0))
    hook_by = float(k.get("hook_visual_by_s") or 1.0)
    attention = 1.0 if first_change <= hook_by else _clip(1.0 - (first_change - hook_by) / 8.0)
    visual_age_long = duration_s(edl) if first_change > 2.2 else 0.0
    visual_novelty = _clip(attention * 0.6 + (0.4 if (broll or any(float(v.get("crop") or 1) > 1.05 for v in videos)) else 0.0))
    if visual_age_long:
        visual_novelty = _clip(visual_novelty - 0.25)

    d = duration_s(edl)
    if 25 <= d <= 45:
        pacing = 0.9
    elif 15 <= d <= 60:
        pacing = 0.55
    else:
        pacing = 0.2
    counts = event_count(edl)
    if counts["video_clips"] + counts["broll"] + counts["punch_ins"] == 1 and d > 20:
        pacing = min(pacing, 0.4)
    # Extra ornament does not improve pacing (do not optimize for more zooms/SFX).
    if counts["punch_ins"] > 2 or counts["sfx"] > 3 or counts["captions"] > 4:
        pacing = min(pacing, 0.5)

    av_sync = 0.4
    if sfx:
        av_sync = 0.75
    if any(x.get("duck") for x in (tracks.get("audio") or [])):
        av_sync = min(1.0, av_sync + 0.15)

    yt = 0.4
    if 20 <= d <= 45:
        yt += 0.25
    if captions and float(captions[0].get("t0", 99)) <= 1.0:
        yt += 0.25
    yt = _clip(yt)

    positives = {
        "narrative_clarity": _clip(narrative),
        "semantic_alignment": _clip(semantic),
        "visual_novelty": _clip(visual_novelty),
        "pacing": _clip(pacing),
        "attention_support": _clip(attention),
        "audiovisual_sync": _clip(av_sync),
        "youtube_prior": yt,
    }
    positives["holistic_vlm_quality"] = _clip(0.9 * sum(positives.values()) / 7.0)

    cap_texts = [str(c.get("text") or "") for c in captions]
    repetition = 0.4 if len(cap_texts) != len(set(cap_texts)) and cap_texts else 0.0
    bands = k.get("overedit_bands") or {}
    over = 0.0
    if counts["captions"] > bands.get("captions", 6):
        over += 0.25
    if counts["sfx"] > bands.get("sfx", 4):
        over += 0.25
    if counts["punch_ins"] > bands.get("punch_ins", 3):
        over += 0.25
    # Scale overedit by how far past the band we went so spam cannot win on novelty.
    excess = 0.0
    excess += max(0, counts["captions"] - bands.get("captions", 6)) * 0.12
    excess += max(0, counts["sfx"] - bands.get("sfx", 4)) * 0.12
    excess += max(0, counts["punch_ins"] - bands.get("punch_ins", 3)) * 0.15
    overediting = _clip(over + excess, 0.0, 3.0)

    long_broll = any(
        (float(b.get("t1", 0)) - float(b.get("t0", 0))) > float(k.get("broll_reject_if_gt") or 4)
        for b in broll
    )
    distraction = 0.35 if long_broll else 0.0
    if counts["graphics"] > 4:
        distraction = _clip(distraction + 0.2)

    vec = {**positives, "repetition": repetition, "overediting": overediting, "distraction": distraction}
    scalar = sum(positives.values()) - (repetition + overediting + distraction)
    return {
        "correctness": True,
        "correctness_reasons": [],
        "vector": vec,
        "scalar": round(scalar, 6),
        "counts": counts,
    }
