"""Cheap EDL mutations. H3 is stubbed and refused in v0."""

from __future__ import annotations

from typing import Any, Callable

from editor_avo.edl import clone

H3_REFUSED = "h3_regen refused in v0 (expensive last; stub only)"


class MutationError(RuntimeError):
    pass


def _tracks(edl: dict) -> dict:
    edl.setdefault("tracks", {})
    for k in ("video", "audio", "captions", "graphics", "sfx", "broll"):
        edl["tracks"].setdefault(k, [])
    return edl["tracks"]


def trim(edl: dict, t1: float = 32.0, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    for key in ("video", "audio"):
        for c in t[key]:
            c["t1"] = min(float(c.get("t1", t1)), t1)
            if float(c["t0"]) >= float(c["t1"]):
                c["t0"] = 0.0
    out["target_duration_s"] = t1
    beats = []
    for b in out.get("beats") or []:
        if float(b.get("t_start", 0)) < t1:
            nb = dict(b)
            nb["t_end"] = min(float(b.get("t_end", t1)), t1)
            beats.append(nb)
    out["beats"] = beats
    return out


def punch_in(edl: dict, t0: float = 0.0, scale: float = 1.22, hold: float = 1.2, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    if not t["video"]:
        raise MutationError("no video")
    src = dict(t["video"][0])
    src["id"] = f"{src.get('id', 'v')}-punch"
    src["t0"] = t0
    src["t1"] = t0 + hold
    src["crop"] = scale
    t["video"].insert(0, src)
    return out


def caption_hook(edl: dict, text: str = "HOOK", t0: float = 0.0, t1: float = 1.2, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    t["captions"].append({"id": f"cap{len(t['captions'])+1}", "text": text, "t0": t0, "t1": t1})
    return out


def caption_claim(edl: dict, text: str = "CLAIM", t0: float = 3.0, t1: float = 5.0, **_: Any) -> dict:
    return caption_hook(edl, text=text, t0=t0, t1=t1)


def add_sfx(edl: dict, t0: float = 0.0, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    t["sfx"].append({"id": f"sfx{len(t['sfx'])+1}", "src": "fixture://whoosh", "t0": t0, "t1": t0 + 0.2})
    return out


def add_broll(edl: dict, t0: float = 3.0, t1: float = 4.4, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    t["broll"].append({"id": f"br{len(t['broll'])+1}", "src": "fixture://library-broll", "t0": t0, "t1": t1})
    return out


def add_graphic(edl: dict, t0: float = 0.2, t1: float = 1.4, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    t["graphics"].append({"id": f"g{len(t['graphics'])+1}", "kind": "title", "t0": t0, "t1": t1})
    return out


def speed(edl: dict, factor: float = 1.05, **_: Any) -> dict:
    out = clone(edl)
    for c in _tracks(out)["video"]:
        c["speed"] = float(c.get("speed") or 1.0) * factor
    return out


def reorder_beats(edl: dict, **_: Any) -> dict:
    out = clone(edl)
    beats = list(out.get("beats") or [])
    if len(beats) >= 2:
        beats[0], beats[1] = beats[1], beats[0]
        out["beats"] = beats
    return out


def music_duck(edl: dict, **_: Any) -> dict:
    out = clone(edl)
    t = _tracks(out)
    if t["audio"]:
        t["audio"][0]["duck"] = True
    else:
        t["audio"].append({"id": "a-duck", "src": "fixture://vo", "t0": 0, "t1": 32, "duck": True})
    return out


def h3_regen(edl: dict, **_: Any) -> dict:
    raise MutationError(H3_REFUSED)


OPS: dict[str, Callable[..., dict]] = {
    "trim": trim,
    "punch_in": punch_in,
    "caption": caption_hook,
    "caption_claim": caption_claim,
    "sfx": add_sfx,
    "broll_swap": add_broll,
    "graphic": add_graphic,
    "speed": speed,
    "reorder": reorder_beats,
    "music_duck": music_duck,
    "h3_regen": h3_regen,
}


def apply_mutation(edl: dict, op: str, **params: Any) -> dict:
    if op not in OPS:
        raise MutationError(f"unknown op {op}")
    return OPS[op](edl, **params)
