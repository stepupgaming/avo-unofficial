"""EDL / timeline JSON: load, save, duration, correctness gate."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

EDL = dict[str, Any]


def load_edl(path: str | Path) -> EDL:
    return json.loads(Path(path).read_text())


def save_edl(edl: EDL, path: str | Path) -> None:
    Path(path).write_text(json.dumps(edl, indent=2) + "\n")


def clone(edl: EDL) -> EDL:
    return copy.deepcopy(edl)


def duration_s(edl: EDL) -> float:
    videos = edl.get("tracks", {}).get("video") or []
    if not videos:
        return float(edl.get("target_duration_s") or 0)
    return max(float(c.get("t1", 0)) for c in videos)


def audio_span(edl: EDL) -> tuple[float, float]:
    aud = edl.get("tracks", {}).get("audio") or []
    if not aud:
        return (0.0, 0.0)
    return (min(float(c.get("t0", 0)) for c in aud), max(float(c.get("t1", 0)) for c in aud))


def video_span(edl: EDL) -> tuple[float, float]:
    vid = edl.get("tracks", {}).get("video") or []
    if not vid:
        return (0.0, 0.0)
    return (min(float(c.get("t0", 0)) for c in vid), max(float(c.get("t1", 0)) for c in vid))


def correctness(edl: EDL) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if edl.get("aspect") != "9:16":
        reasons.append("aspect")
    d = duration_s(edl)
    if d < 15 or d > 60:
        reasons.append("duration")
    if not edl.get("rights"):
        reasons.append("rights")
    tracks = edl.get("tracks") or {}
    if not tracks.get("video"):
        reasons.append("no_video")
    if not tracks.get("audio"):
        reasons.append("no_audio")
    vs, ve = video_span(edl)
    as_, ae = audio_span(edl)
    if abs(vs - as_) > 0.25 or abs(ve - ae) > 0.25:
        reasons.append("desync")
    return (len(reasons) == 0, reasons)


def event_count(edl: EDL) -> dict[str, int]:
    t = edl.get("tracks") or {}
    punch = sum(1 for c in (t.get("video") or []) if float(c.get("crop") or 1.0) > 1.05)
    return {
        "captions": len(t.get("captions") or []),
        "sfx": len(t.get("sfx") or []),
        "broll": len(t.get("broll") or []),
        "graphics": len(t.get("graphics") or []),
        "punch_ins": punch,
        "video_clips": len(t.get("video") or []),
    }
