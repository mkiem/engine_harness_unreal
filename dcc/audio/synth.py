"""Reproducible procedural sound recipes, standard library only, so a recipe runs on any machine with Python 3.

    python dcc/audio/synth.py radio-static out.wav --seconds 4 --loop --rms-db -20 --peak-db -3

The algorithm matches the harness's simulated audio worker: band-limited noise, sparse crackle and a faint mains hum,
normalised to an RMS target and soft-limited to a peak ceiling. A loop crossfades its tail into its head.
"""
from __future__ import annotations

import argparse
import math
import struct
import wave


def radio_static(seconds: float, rate: int, loop: bool = True, rms_db: float = -20.0, peak_db: float = -3.0,
                 seed: int = 0x5EED, hum_hz: float = 60.0) -> list[float]:
    state = seed

    def rand() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0x100000000 * 2 - 1

    length = round(seconds * rate)
    fade = min(round(0.25 * rate), length // 4) if loop else 0
    raw: list[float] = []
    low = previous = blocked = 0.0
    for i in range(length + fade):
        low += 0.25 * (rand() - low)
        blocked = low - previous + 0.995 * blocked
        previous = low
        crackle = rand() * 0.9 if rand() > 0.9985 else 0.0
        raw.append(blocked + crackle + 0.03 * math.sin(2 * math.pi * hum_hz * i / rate))
    out = raw[:length]
    for i in range(fade):
        t = i / fade
        out[i] = raw[i] * t + raw[length + i] * (1 - t)
    rms = math.sqrt(sum(v * v for v in out) / len(out)) or 1.0
    gain = 10 ** (rms_db / 20) / rms
    ceiling = 10 ** (peak_db / 20)
    return [ceiling * math.tanh(v * gain / ceiling) for v in out]


def write_wav16(path: str, samples: list[float], rate: int) -> None:
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, round(v * 32767)))) for v in samples))


def measure(path: str) -> dict:
    """The same measurements the harness's audio contract takes, for a worker's self-check."""
    with wave.open(path, "rb") as clip:
        frames = clip.readframes(clip.getnframes())
        width, channels, rate = clip.getsampwidth(), clip.getnchannels(), clip.getframerate()
    if width != 2:
        raise ValueError("measure() reads 16-bit PCM only")
    values = [v / 32768 for (v,) in struct.iter_unpack("<h", frames)]
    peak = max((abs(v) for v in values), default=0.0)
    rms = math.sqrt(sum(v * v for v in values) / len(values)) if values else 0.0
    db = lambda x: 20 * math.log10(x) if x > 0 else float("-inf")  # noqa: E731
    return {"sampleRate": rate, "channels": channels, "bitDepth": 16, "seconds": len(values) / channels / rate,
            "peakDb": db(peak), "rmsDb": db(rms), "loopSeam": abs(values[-channels] - values[0]) if values else 0.0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recipe", choices=["radio-static"])
    parser.add_argument("out")
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--rate", type=int, default=48000)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--rms-db", type=float, default=-20.0)
    parser.add_argument("--peak-db", type=float, default=-3.0)
    parser.add_argument("--seed", type=int, default=0x5EED)
    args = parser.parse_args()
    write_wav16(args.out, radio_static(args.seconds, args.rate, args.loop, args.rms_db, args.peak_db, args.seed), args.rate)
    print(measure(args.out))


if __name__ == "__main__":
    main()
