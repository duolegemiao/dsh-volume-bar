"""Offline checks for lib/audio-levels.py — synthetic PCM only, no audio device.

Run it twice: with the helper venv (NumPy present, FFT path) and with a bare
interpreter (NumPy absent, Goertzel path).

    python _tests/audio.test.py

The reference value in every case is the signal's own RMS: a full-scale sine
reads 0.707 everywhere it has energy, a half-scale sine reads 0.354.
"""

from __future__ import annotations

import importlib.util
import math
import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HELPER = HERE.parent / "lib" / "audio-levels.py"

spec = importlib.util.spec_from_file_location("audio_levels", HELPER)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    mark = "ok  " if condition else "FAIL"
    print(f"  {mark} {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(name)


def sine(rate: int, frequency: float, amplitude: float, seconds: float, phase: float = 0.0) -> list[float]:
    count = int(rate * seconds)
    return [amplitude * math.sin(2.0 * math.pi * frequency * i / rate + phase) for i in range(count)]


def to_bytes_int16(channels: list[list[float]]) -> bytes:
    payload = bytearray()
    for i in range(len(channels[0])):
        for channel in channels:
            value = max(-1.0, min(1.0, channel[i]))
            payload += struct.pack("<h", int(round(value * 32767)))
    return bytes(payload)


def analyze(channel_data: list[list[float]], rate: int):
    channels = len(channel_data)
    raw = to_bytes_int16(channel_data)
    analyze_fn, mode = module.make_analyzer(rate, channels)
    frame = module._frame(raw, channels, module._np)
    return analyze_fn(frame), mode


def band_tolerance(value: float) -> float:
    """The fallback bank probes whole bins, so allow ~6% of reading."""
    return 0.08 if module._np is None else 0.06


def band_of(frequency: float, edges) -> int:
    for index, (lo, hi) in enumerate(edges):
        if lo <= frequency < hi:
            return index
    return -1


def bits(rate: int) -> float:
    return module.WINDOW_SAMPLES / rate


class FakeAudio:
    """Minimal PyAudio stand-in for the device-selection checks."""

    def __init__(self, loopbacks, default_index, default_output):
        self.loopbacks = set(loopbacks)
        self.default_index = default_index
        self.default_output = default_output
        self.count = max(max(self.loopbacks) if self.loopbacks else 0, default_output) + 1

    def get_device_count(self):
        return self.count

    def get_device_info_by_index(self, index):
        if index >= self.count:
            raise OSError("invalid device index")
        loopback = index in self.loopbacks
        name = f"Device {index} [Loopback]" if loopback else f"Device {index}"
        return {
            "index": index,
            "name": name,
            "isLoopbackDevice": loopback,
            "defaultSampleRate": 48000.0,
            "maxInputChannels": 2,
        }

    def get_host_api_info_by_type(self, _type):
        return {"defaultOutputDevice": self.default_output}

    def get_default_wasapi_loopback(self):
        return self.get_device_info_by_index(self.default_index)


def device_checks() -> None:
    """A pinned index that vanished must fall back instead of killing capture."""
    print("\n[9] device selection survives a stale pinned index")
    fake = FakeAudio(loopbacks=[28, 29, 30, 31, 32], default_index=30, default_output=22)
    info, _default, description = module.pick_device(fake, 0, 0, None)
    check(
        f"pinned index 0 (not a loopback) falls back to device {info['index']} ({description['mode']})",
        info["index"] == 30 and description["mode"] == "pinned-fallback",
    )
    info, _default, description = module.pick_device(fake, 0, 30, None)
    check(f"a valid pin is honoured ({description['mode']})", info["index"] == 30 and description["mode"] == "pinned-index")
    info, _default, description = module.pick_device(fake, 0, None, None)
    check(f"no pin follows the default ({description['mode']})", info["index"] == 30 and description["mode"] == "system-default")
    info, _default, description = module.pick_device(fake, 0, None, "nonexistent device")
    check(f"a missing requested name follows the default ({description['mode']})", info["index"] == 30)
    empty = FakeAudio(loopbacks=[], default_index=30, default_output=22)
    try:
        module.pick_device(empty, 0, None, None)
        check("no loopback device at all raises", False, "no error raised")
    except LookupError:
        check("no loopback device at all raises LookupError", True)


def level_only_checks(rate: int) -> int:
    """The NumPy-less fallback reports a level and repeats it in every band."""
    print("\n[fallback] level-only mode")
    for frequency in (100.0, 1000.0, 4000.0):
        (rms, peak, bands), mode = analyze([sine(rate, frequency, 0.5, bits(rate))], rate)
        check(f"mode is {mode}", mode == "level-only")
        check(
            f"{frequency:>6.0f} Hz at half scale: rms {rms:.4f}, peak {peak:.4f}, bands uniform "
            f"{bands[0]:.4f}",
            abs(rms - 0.3536) < 0.01 and abs(peak - 0.5) < 0.01 and len(set(bands)) == 1 and abs(bands[0] - rms) < 1e-9,
        )
    (rms_anti, _, bands_anti), _ = analyze(
        [sine(rate, 440.0, 0.5, bits(rate)), [-value for value in sine(rate, 440.0, 0.5, bits(rate))]], rate
    )
    check(f"anti-phase stereo level {rms_anti:.4f} is not cancelled", rms_anti > 0.3 and bands_anti[0] > 0.3)
    (rms_none, _, bands_none), _ = analyze([[0.0] * 2048], rate)
    check(f"silence stays silent ({rms_none:.4f})", rms_none == 0.0 and max(bands_none) == 0.0)

    tone = sine(rate, 1000.0, 0.5, bits(rate))
    analyze_fn, _ = module.make_analyzer(rate, 1)
    frame = module._frame(to_bytes_int16([tone]), 1, module._np)
    analyze_fn(frame)
    start = time.perf_counter()
    for _ in range(200):
        analyze_fn(frame)
    elapsed = (time.perf_counter() - start) / 200 * 1000.0
    check(f"{elapsed:.3f} ms per window (budget 2 ms; 46 windows/s)", elapsed < 2.0)

    device_checks()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print("all checks passed (fallback mode)")
    return 0


def main() -> int:
    rate = 48000
    edges = module.band_edges(rate, module.BANDS)
    spectral = module._np is not None
    print(f"analysis mode: {'numpy-fft' if spectral else 'level-only (NumPy missing)'}")
    print(f"window: {module.WINDOW_SAMPLES} samples ({bits(rate) * 1000:.1f} ms), hop {module.HOP_SAMPLES}")
    print(f"bands: {[(round(lo), round(hi)) for lo, hi in edges]}")

    if not spectral:
        return level_only_checks(rate)

    print("\n[1] a full-scale sine reads its own RMS inside its band, at any frequency")
    for frequency in (60.0, 100.0, 220.0, 440.0, 1000.0, 4000.0, 9000.0):
        (rms, peak, bands), _ = analyze([sine(rate, frequency, 1.0, bits(rate))], rate)
        index = band_of(frequency, edges)
        value = bands[index]
        others = bands[:index] + bands[index + 1 :]
        # Band 0 spans two bins at this window length, so a tone between them
        # reads up to ~2 dB low; that is the resolution limit, not a scale error.
        floor = 0.55 if index == 0 else 0.7071 - band_tolerance(value)
        check(
            f"{frequency:>6.0f} Hz -> band {index} = {value:.3f} (rms {rms:.3f}, peak {peak:.3f}, "
            f"loudest other band {max(others):.3f})",
            floor <= value <= 0.72
            and abs(rms - 0.7071) < 0.01
            and abs(peak - 1.0) < 0.01
            and max(others) < 0.25,
        )

    print("\n[2] amplitude scaling is linear in dB")
    index = band_of(440.0, edges)
    for amplitude in (0.5, 0.25, 0.1):
        (_, _, bands), _ = analyze([sine(rate, 440.0, amplitude, bits(rate))], rate)
        expected = amplitude * 0.7071
        check(
            f"440 Hz at amplitude {amplitude} -> {bands[index]:.3f} (expected {expected:.3f})",
            abs(bands[index] - expected) < 0.02,
        )

    print("\n[3] anti-phase stereo keeps its energy (F08)")
    left = sine(rate, 440.0, 0.5, bits(rate))
    (rms_in, _, bands_in), _ = analyze([left, left], rate)
    (rms_anti, _, bands_anti), _ = analyze([left, [-value for value in left]], rate)
    check(f"in-phase rms {rms_in:.4f} vs anti-phase rms {rms_anti:.4f}", abs(rms_in - rms_anti) < 0.002 and rms_anti > 0.3)
    check(
        f"in-phase band {bands_in[index]:.4f} vs anti-phase band {bands_anti[index]:.4f}",
        abs(bands_in[index] - bands_anti[index]) < 0.01 and bands_anti[index] > 0.3,
    )

    print("\n[4] one-sided audio still reads as sound, not silence")
    silent = [0.0] * len(left)
    (rms_one, _, bands_one), _ = analyze([left, silent], rate)
    check(
        f"single-channel rms {rms_one:.4f} (channel mean of 0.354/0), band {bands_one[index]:.4f}",
        abs(rms_one - 0.3536 / 2.0 ** 0.5) < 0.003 and bands_one[index] > 0.3,
    )

    print("\n[5] mono and multi-channel input")
    (rms_mono, _, bands_mono), _ = analyze([left], rate)
    check(f"mono rms {rms_mono:.4f} equals stereo rms {rms_in:.4f}", abs(rms_mono - rms_in) < 0.002)
    (rms_quad, _, bands_quad), _ = analyze([left, silent, left, silent], rate)
    check(
        f"4-channel rms {rms_quad:.4f} (channel mean), band {bands_quad[index]:.4f}",
        abs(rms_quad - rms_in / 2.0 ** 0.5) < 0.003 and bands_quad[index] > 0.3,
    )

    print("\n[6] different tones in each channel land in their own bands")
    low = sine(rate, 100.0, 0.5, bits(rate))
    high = sine(rate, 4000.0, 0.5, bits(rate))
    (_, _, bands_split), _ = analyze([low, high], rate)
    check(
        f"100 Hz band {bands_split[band_of(100.0, edges)]:.3f}, 4 kHz band {bands_split[band_of(4000.0, edges)]:.3f}",
        bands_split[band_of(100.0, edges)] > 0.3 and bands_split[band_of(4000.0, edges)] > 0.3,
    )

    print("\n[7] silence and DC")
    (rms_zero, peak_zero, bands_zero), _ = analyze([[0.0] * 2048], rate)
    check(
        f"silence rms {rms_zero:.4f}, max band {max(bands_zero):.4f}",
        rms_zero == 0.0 and peak_zero == 0.0 and max(bands_zero) < 1e-6,
    )
    (rms_dc, _, bands_dc), _ = analyze([[0.5] * (2 * module.WINDOW_SAMPLES)], rate)
    check(f"DC rms {rms_dc:.3f} stays out of the bands (max {max(bands_dc):.4f})", rms_dc > 0.45 and max(bands_dc) < 0.02)
    (rms_dc_anti, _, _), _ = analyze([[0.5] * (2 * module.WINDOW_SAMPLES), [-0.5] * (2 * module.WINDOW_SAMPLES)], rate)
    check(f"anti-phase DC rms {rms_dc_anti:.3f} is not cancelled", rms_dc_anti > 0.45)

    print("\n[8] the levels agree across analysis modes (F07)")
    for frequency in (100.0, 1000.0, 4000.0):
        tone = sine(rate, frequency, 0.5, bits(rate))
        fft_fn, mode_fft = module.make_analyzer(rate, 1, mode="numpy-fft")
        alt_fn, mode_alt = module.make_analyzer(rate, 1, mode="level-only")
        fft_result = fft_fn(module._frame(to_bytes_int16([tone]), 1, module._np))
        alt_result = alt_fn([value for value in tone])
        index = band_of(frequency, edges)
        if mode_alt == "level-only":
            check(
                f"{frequency:>6.0f} Hz: {mode_fft} band {fft_result[2][index]:.3f} vs level-only level "
                f"{alt_result[2][index]:.3f} (rms {alt_result[0]:.4f})",
                abs(alt_result[0] - 0.3536) < 0.01 and abs(alt_result[2][index] - alt_result[0]) < 1e-9,
            )
        else:
            check(
                f"{frequency:>6.0f} Hz band {index}: {mode_fft} {fft_result[2][index]:.3f} vs {mode_alt} "
                f"{alt_result[2][index]:.3f}",
                abs(fft_result[2][index] - alt_result[2][index]) < 0.06,
            )

    print("\n[10] speed: analysis cost per window")
    noisy = [0.2 * math.sin(i * 12.9898) for i in range(len(tone))]
    analyze_fn, _ = module.make_analyzer(rate, 2)
    frame = module._frame(to_bytes_int16([tone, noisy]), 2, module._np)
    analyze_fn(frame)
    start = time.perf_counter()
    rounds = 40
    for _ in range(rounds):
        analyze_fn(frame)
    elapsed = (time.perf_counter() - start) / rounds * 1000.0
    budget = 15.0 if module._np is None else 5.0
    check(f"{elapsed:.2f} ms per window (budget {budget} ms; 46 windows/s)", elapsed < budget)

    device_checks()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
