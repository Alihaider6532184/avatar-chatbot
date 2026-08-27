"""Azure Speech viseme IDs translated to TalkingHead's Oculus viseme names.

Azure's 22 IDs represent groups of English phonemes.  TalkingHead/RPM expects
Oculus-style names, so this normalisation keeps the browser a pure renderer.
"""

from typing import Final

# See Azure's standard viseme table.  Several Azure phoneme groups collapse to
# one Oculus mouth shape; e.g. Azure 1 and 2 are both an open "aa" shape.
AZURE_TO_OCULUS_VISEME: Final[dict[int, str]] = {
    0: "sil",  # silence
    1: "aa",  # ae, ax, ah
    2: "aa",  # aa
    3: "O",  # ao
    4: "E",  # ey, eh, uh
    5: "RR",  # er
    6: "I",  # y, iy, ix
    7: "U",  # w, uw
    8: "O",  # ow
    9: "aa",  # aw
    10: "O",  # oy (closest rounded/open Oculus shape)
    11: "aa",  # ay (closest open Oculus shape)
    12: "sil",  # h has no dedicated Oculus mouth closure
    13: "RR",  # r
    14: "nn",  # l
    15: "SS",  # s, z
    16: "CH",  # sh, ch, jh, zh
    17: "TH",  # th, dh
    18: "FF",  # f, v
    19: "DD",  # d, t, n
    20: "kk",  # k, g, ng
    21: "PP",  # p, b, m
}


def to_oculus_viseme(azure_viseme_id: int) -> str:
    """Return a safe neutral fallback for an unknown Azure viseme value."""

    return AZURE_TO_OCULUS_VISEME.get(azure_viseme_id, "sil")
