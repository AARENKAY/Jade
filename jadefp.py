"""Shared fingerprint maths for the Jade indexer (vindex.py) and matcher (vget.py).

Both programs import this file so the hashes they compare can never drift apart.
Keep it in the same folder as vindex.py and vget.py.
"""
import math
import numpy as np

N = 32
# Bump when the hash or the sampling changes. Videos indexed with an older
# version are ignored by the matcher and re-indexed by the bulk indexer.
FP_VERSION = 2
# ffmpeg filter shared by indexer and matcher so both sample identically.
VIDEO_FILTER = 'fps=1,scale=32:32:flags=area,format=gray'
_x = np.arange(N, dtype=np.float64)
_k = np.arange(N, dtype=np.float64)[:, None]
_D = np.cos((np.pi / N) * (_x + 0.5) * _k)
_D[0, :] *= 1.0 / math.sqrt(2.0)
_D *= math.sqrt(2.0 / N)

# Frames whose 32x32 grayscale tile has a standard deviation below this are
# near-flat (black, white, fades). Their hashes are meaningless and match
# everything, so they are neither stored nor searched.
MIN_STD = 3.0


def is_flat(tile):
    return float(np.std(tile)) < MIN_STD


def phash_tile(tile):
    """64-bit DCT perceptual hash of a 32x32 uint8 tile, or None if too flat."""
    a = np.asarray(tile, dtype=np.uint8).reshape(N, N)
    if is_flat(a):
        return None
    dct = _D @ a.astype(np.float64) @ _D.T
    # 63 low-frequency AC coefficients of the 8x8 block (DC is skipped: it is
    # always above the median and would waste a bit) plus one more AC term.
    coefs = np.append(dct[:8, :8].reshape(-1)[1:], dct[0, 8])
    bits = coefs > np.median(coefs)
    return int.from_bytes(np.packbits(bits).tobytes(), 'big')



def to_signed(value):
    """SQLite integers are signed 64-bit."""
    return value - (1 << 64) if value >= (1 << 63) else value


_POP8 = np.array([bin(i).count('1') for i in range(256)], dtype=np.uint8)
_HAVE_BITWISE_COUNT = hasattr(np, 'bitwise_count')


def popcount64(a):
    """Per-element popcount of a uint64 array."""
    if _HAVE_BITWISE_COUNT:
        return np.bitwise_count(a)
    a = np.ascontiguousarray(a)
    return _POP8[a.view(np.uint8)].reshape(-1, 8).sum(axis=1, dtype=np.uint8)
