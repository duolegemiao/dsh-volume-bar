"""System-output level meter for the DSH volume-bar plugin.

Captures the WASAPI loopback stream of the default render device and writes one
JSON object per line to stdout:

    {"type":"hello","device":"...","rate":48000,"channels":2}
    {"type":"level","rms":0.0312,"peak":0.2044,"bands":[0.02,...]}

`bands` holds ``BANDS`` normalized magnitudes (0..1 for a full-scale tone) with
log-spaced edges between BAND_MIN_HZ and BAND_MAX_HZ, so the browser half can
drive one rail tick per band.

The process exits on stdin EOF, so the host half only has to close the pipe.
"""

from __future__ import annotations

import json
import math
import struct
import sys
import time

BANDS = 8
BAND_MIN_HZ = 40.0
BAND_MAX_HZ = 12000.0
WINDOW_SECONDS = 0.033
READ_CHUNK = 4096
IDLE_EMIT_SECONDS = 0.5

try:  # numpy is optional: the helper still reports RMS without it
    import numpy as _np
except Exception:  # noqa: BLE001
    _np = None


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def pick_device(pa, wasapi_type: int, forced_index: int | None):
    """Return the loopback device info for the default output (or a forced one)."""
    wasapi = pa.get_host_api_info_by_type(wasapi_type)
    default_out = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
    loopbacks = []
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if info.get("isLoopbackDevice"):
            loopbacks.append(info)
    if forced_index is not None:
        for info in loopbacks:
            if info["index"] == forced_index:
                return info, default_out
        raise SystemExit(f"loopback device index {forced_index} not found")
    base = default_out["name"]
    for info in loopbacks:
        if info["name"].replace(" [Loopback]", "") == base:
            return info, default_out
    if loopbacks:
        return loopbacks[0], default_out
    raise SystemExit("no WASAPI loopback device found")


def band_edges(rate: int, count: int) -> list[tuple[float, float]]:
    lo = math.log(BAND_MIN_HZ)
    hi = math.log(min(BAND_MAX_HZ, rate / 2.0 - 1.0))
    edges = []
    for i in range(count):
        a = math.exp(lo + (hi - lo) * i / count)
        b = math.exp(lo + (hi - lo) * (i + 1) / count)
        edges.append((a, b))
    return edges


def make_analyzer(rate: int, channels: int):
    """Return f(samples_bytes) -> (rms, peak, bands)."""
    edges = band_edges(rate, BANDS)

    if _np is not None:
        def analyze(data: bytes):
            arr = _np.frombuffer(data, dtype=_np.int16).astype(_np.float32) / 32768.0
            if channels > 1:
                arr = arr.reshape(-1, channels).mean(axis=1)
            if arr.size == 0:
                return 0.0, 0.0, [0.0] * BANDS
            rms = float(_np.sqrt(_np.mean(arr * arr)))
            peak = float(_np.max(_np.abs(arr)))
            n = arr.size
            window = _np.hanning(n)
            spec = _np.abs(_np.fft.rfft(arr * window)) / max(1.0, n / 4.0)
            freqs = _np.fft.rfftfreq(n, 1.0 / rate)
            bands = []
            for lo, hi in edges:
                sel = (freqs >= lo) & (freqs < hi)
                bands.append(float(_np.max(spec[sel])) if _np.any(sel) else 0.0)
            return rms, peak, bands

        return analyze

    def analyze_pure(data: bytes):
        count = len(data) // 2
        samples = struct.unpack("<%dh" % count, data[: count * 2])
        if channels > 1:
            frames = [
                (samples[i] + samples[i + 1]) / 2.0
                for i in range(0, count - 1, channels)
            ]
        else:
            frames = [float(s) for s in samples]
        if not frames:
            return 0.0, 0.0, [0.0] * BANDS
        scale = 32768.0
        rms = math.sqrt(sum((s / scale) ** 2 for s in frames) / len(frames))
        peak = max(abs(s) for s in frames) / scale
        n = len(frames)
        bands = []
        for lo, hi in edges:
            # one Goertzel pass per band, sampled at the band centre
            freq = (lo + hi) / 2.0
            w = 2.0 * math.pi * freq / rate
            coeff = 2.0 * math.cos(w)
            s1 = s2 = 0.0
            for sample in frames:
                s0 = sample / scale + coeff * s1 - s2
                s2, s1 = s1, s0
            power = s1 * s1 + s2 * s2 - coeff * s1 * s2
            bands.append(min(1.0, math.sqrt(max(0.0, power)) * 2.0 / n))
        return rms, peak, bands

    return analyze_pure


def main() -> int:
    forced = None
    if len(sys.argv) > 1:
        try:
            forced = int(sys.argv[1])
        except ValueError:
            forced = None

    import pyaudiowpatch as pyaudio

    p = pyaudio.PyAudio()
    try:
        target, default_out = pick_device(p, pyaudio.paWASAPI, forced)
    except SystemExit as exc:
        emit({"type": "error", "message": str(exc)})
        return 2

    rate = int(target["defaultSampleRate"])
    channels = min(2, int(target["maxInputChannels"])) or 1
    analyze = make_analyzer(rate, channels)
    window_bytes = max(2, int(rate * WINDOW_SECONDS) * 2 * channels)

    stream = p.open(
        format=pyaudio.paInt16,
        channels=channels,
        rate=rate,
        input=True,
        input_device_index=target["index"],
        frames_per_buffer=1024,
    )

    emit(
        {
            "type": "hello",
            "device": default_out["name"],
            "loopback": target["name"],
            "rate": rate,
            "channels": channels,
            "bands": BANDS,
            "numpy": _np is not None,
        }
    )

    buf = bytearray()
    last_emit = time.time()
    try:
        while True:
            avail = stream.get_read_available()
            if avail > 0:
                chunk = stream.read(min(avail, READ_CHUNK), exception_on_overflow=False)
                buf.extend(chunk)
                while len(buf) >= window_bytes:
                    window = bytes(buf[:window_bytes])
                    del buf[:window_bytes]
                    rms, peak, bands = analyze(window)
                    emit(
                        {
                            "type": "level",
                            "rms": round(rms, 5),
                            "peak": round(peak, 5),
                            "bands": [round(b, 4) for b in bands],
                        }
                    )
                    last_emit = time.time()
            else:
                time.sleep(0.004)
                if time.time() - last_emit > IDLE_EMIT_SECONDS:
                    emit({"type": "level", "rms": 0.0, "peak": 0.0, "bands": [0.0] * BANDS})
                    last_emit = time.time()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            stream.stop_stream()
            stream.close()
        finally:
            p.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
