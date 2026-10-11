"""System-output level meter for the DSH volume-bar plugin.

Captures the WASAPI loopback stream of a render device and writes one JSON
object per line to stdout:

    {"type":"hello","device":{...},"rate":48000,"channels":2,"bands":8,...}
    {"type":"level","generation":"...","seq":12,"rms":0.03,"peak":0.2,"bands":[...]}

Value semantics — identical in every analysis mode:

* ``rms``   — full-band RMS over all channels; 1.0 is a full-scale sine.
* ``peak``  — largest absolute sample of any channel; 1.0 is full scale.
* ``bands`` — in-band RMS per log-spaced band, so a full-scale sine sitting
  anywhere inside a band reads ~1.0 there. Channel power is merged *after* the
  spectrum is computed, so anti-phase stereo keeps its energy instead of
  cancelling to silence.

``analysisMode`` tells the browser half what it is looking at: ``numpy-fft``
carries real per-band energy, while the NumPy-less fallback reports
``level-only`` and repeats the total level in every band slot (no frequency
split). The host installs NumPy with the helper, so the fallback is a safety
net for a damaged environment rather than a normal mode.

Stopping: the helper exits when stdin reaches EOF or carries a ``stop`` line, so
the host only has to close the pipe (it may send ``stop`` first for a graceful
exit). A watchdog exits the process if the pipe dies without an EOF.

An optional command-line argument pins a loopback device by index; without it
the helper follows the system default output. ``DSH_VOLUME_BAR_DEVICE`` and
``DSH_VOLUME_BAR_DEVICE_INDEX`` do the same for hand-run diagnostics.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import struct
import sys
import threading
import time

BANDS = 8
BAND_MIN_HZ = 40.0
BAND_MAX_HZ = 12000.0
WINDOW_SAMPLES = 2048
HOP_SAMPLES = 1024
READ_CHUNK = 4096
IDLE_EMIT_SECONDS = 0.5
MAX_BUFFER_SECONDS = 4.0
STALL_REOPEN_SECONDS = 3.0
STREAM_OPEN_ATTEMPTS = 3
MODULE_VERSION = "0.7.0"

try:  # NumPy is optional: without it a decimated Goertzel bank runs instead.
    import numpy as _np
except Exception:  # noqa: BLE001
    _np = None

if os.name == "nt":  # pragma: no cover - platform specific
    import msvcrt

    def _binary_mode() -> None:
        for stream in (sys.stdout, sys.stdin):
            with contextlib.suppress(Exception):
                msvcrt.setmode(stream.fileno(), os.O_BINARY)
else:  # pragma: no cover - platform specific
    def _binary_mode() -> None:
        return None


class Stop(Exception):
    """Raised inside the capture loop when the host asked the helper to stop."""


def emit(payload: dict) -> None:
    try:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        # The host is gone and stdout is closed: nothing left to report to.
        raise Stop from None


def warn(message: str) -> None:
    with contextlib.suppress(Exception):
        sys.stderr.write(str(message).rstrip() + "\n")
        sys.stderr.flush()


def band_edges(rate: float, count: int) -> list[tuple[float, float]]:
    """Log-spaced band edges, clamped to what the sample rate can resolve."""
    lo = math.log(BAND_MIN_HZ)
    hi = math.log(max(BAND_MIN_HZ * 1.01, min(BAND_MAX_HZ, rate / 2.0 * 0.98)))
    edges = []
    for i in range(count):
        a = math.exp(lo + (hi - lo) * i / count)
        b = math.exp(lo + (hi - lo) * (i + 1) / count)
        edges.append((a, b))
    return edges


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------


def _window_energy(weights) -> float:
    """sum(w^2) — the shared calibration constant of every analysis mode.

    ``D[k] = 2|X[k]|^2 / (N * sum(w^2))`` is a one-sided power density in
    mean-square units. Summing it over the bins that hold a full-scale sine
    returns that tone's mean square (0.5) whatever bin it lands on — the Hann
    main lobe spreads over two or three bins exactly as much as its peak loses —
    and for broadband input it returns the in-band mean square times ``ENBW``
    (1.5 for Hann, the documented visualisation bias that the shared AGC
    reference absorbs). Bin 0 and Nyquist need no special case: each carries its
    own energy once.
    """
    if _np is not None:
        return float(_np.sum(_np.square(weights)))
    return float(sum(w * w for w in weights))


def _make_numpy_analyzer(rate: float, channels: int):
    """Hann-windowed FFT with per-channel power merged afterwards."""
    import numpy as np

    edges = band_edges(rate, BANDS)
    window = np.hanning(WINDOW_SAMPLES).astype(np.float32)
    density_scale = 2.0 / (WINDOW_SAMPLES * _window_energy(window))
    freqs = np.fft.rfftfreq(WINDOW_SAMPLES, 1.0 / rate)
    selections = [((freqs >= lo) & (freqs < hi)) for lo, hi in edges]

    def analyze_window(samples: "np.ndarray"):
        frames = samples.shape[0]
        if frames < 32:
            return 0.0, 0.0, [0.0] * BANDS
        # One-sided power density: summed over a set of bins it is the mean
        # square those bins carry, for tones and noise alike.
        power = np.zeros(WINDOW_SAMPLES // 2 + 1, dtype=np.float64)
        for channel in range(samples.shape[1]):
            column = samples[:, channel]
            if frames < WINDOW_SAMPLES:
                padded = np.zeros(WINDOW_SAMPLES, dtype=np.float32)
                padded[:frames] = column
                column = padded
            elif frames > WINDOW_SAMPLES:
                column = column[:WINDOW_SAMPLES]
            spectrum = np.fft.rfft(column * window)
            power += np.square(np.abs(spectrum))
        power *= density_scale
        bands = []
        for selection in selections:
            if np.any(selection):
                bands.append(math.sqrt(max(0.0, float(np.sum(power[selection])))))
            else:
                bands.append(0.0)
        rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
        peak = float(np.max(np.abs(samples)))
        return rms, peak, bands

    return analyze_window


def _make_level_only_analyzer(rate: float, channels: int):
    """Fallback when NumPy is unavailable: total level, no frequency split.

    Pure Python cannot afford a comparable FFT/Goertzel bank at this frame rate,
    and an inconsistent band scale would be worse than no bands at all — the
    review (F07) asks for one honest, documented behaviour instead. Every band
    therefore carries the same total-level value, so the rail still reacts to the
    music while the status line reports ``analysisMode: "level-only"``.
    """
    def analyze_window(samples):
        if samples and isinstance(samples[0], list):
            columns = [[frame[channel] for frame in samples] for channel in range(len(samples[0]))]
        else:
            columns = [list(samples)]
        frames = len(columns[0])
        peak = 0.0
        total = 0.0
        for column in columns:
            for value in column:
                magnitude = -value if value < 0.0 else value
                if magnitude > peak:
                    peak = magnitude
                total += value * value
        rms = math.sqrt(total / (frames * len(columns))) if frames else 0.0
        level = min(1.0, rms)
        return rms, peak, [level] * BANDS

    return analyze_window


def make_analyzer(rate: float, channels: int, mode: str = "auto"):
    """Return ``(analyze, analysisMode)``; ``mode`` also accepts "level-only"."""
    if _np is not None and mode != "level-only":
        return _make_numpy_analyzer(rate, channels), "numpy-fft"
    return _make_level_only_analyzer(rate, channels), "level-only"


# ---------------------------------------------------------------------------
# device selection
# ---------------------------------------------------------------------------


def _describe(info: dict, mode: str, default_name: str) -> dict:
    name = info["name"].replace(" [Loopback]", "")
    return {
        "mode": mode,
        "name": name,
        "loopback": info["name"],
        "index": info["index"],
        "defaultName": default_name,
        "isDefault": name == default_name,
    }


def list_devices(pa) -> list[dict]:
    devices = []
    for index in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(index)
        if not info.get("isLoopbackDevice"):
            continue
        devices.append(
            {
                "index": int(info["index"]),
                "name": info["name"].replace(" [Loopback]", ""),
                "loopback": info["name"],
                "rate": int(info["defaultSampleRate"]),
                "channels": int(info["maxInputChannels"]),
            }
        )
    return devices


def pick_device(pa, wasapi_type: int, forced_index, requested: str | None):
    """Return (loopback info, default output info, description dict)."""
    wasapi = pa.get_host_api_info_by_type(wasapi_type)
    default_out = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
    default_name = default_out["name"]

    if forced_index is not None:
        with contextlib.suppress(Exception):
            info = pa.get_device_info_by_index(int(forced_index))
            if info.get("isLoopbackDevice"):
                return info, default_out, _describe(info, "pinned-index", default_name)
        raise LookupError(f"loopback device index {forced_index} is not available")

    if requested:
        wanted = requested.strip().lower()
        for index in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(index)
            if not info.get("isLoopbackDevice"):
                continue
            if wanted == info["name"].replace(" [Loopback]", "").lower() or wanted in info["name"].lower():
                return info, default_out, _describe(info, "pinned-name", default_name)
        warn(f"requested device {requested!r} is unavailable; following the system default")

    try:
        info = pa.get_default_wasapi_loopback()
        return info, default_out, _describe(info, "system-default", default_name)
    except Exception as error:  # noqa: BLE001 - the library raises several types
        warn(f"default loopback lookup failed ({error}); matching by name instead")

    for index in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(index)
        if info.get("isLoopbackDevice") and info["name"].replace(" [Loopback]", "") == default_name:
            return info, default_out, _describe(info, "system-default", default_name)
    raise LookupError("no WASAPI loopback device matched the default output")


# ---------------------------------------------------------------------------
# capture
# ---------------------------------------------------------------------------


def _frame(raw: bytes, channels: int, np_module):
    """Interleaved int16 bytes -> (frames, channels) float samples in -1..1."""
    if np_module is not None:
        array = np_module.frombuffer(raw, dtype=np_module.int16).astype(np_module.float32) / 32768.0
        if channels > 1:
            return array.reshape(-1, channels)
        return array.reshape(-1, 1)
    count = len(raw) // 2
    values = struct.unpack("<%dh" % count, raw[: count * 2])
    if channels > 1:
        return [
            [values[i + channel] / 32768.0 for channel in range(channels)]
            for i in range(0, count - channels + 1, channels)
        ]
    return [[value / 32768.0] for value in values]


def _capture(p, target, channels: int, rate: int, analyze, generation: str, stop_event: threading.Event):
    """Run one stream until it breaks, the host stops us, or the device dies."""
    try:
        stream = p.open(
            format=p.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=target["index"],
            frames_per_buffer=1024,
        )
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"cannot open the loopback stream: {error}") from error

    window_bytes = WINDOW_SAMPLES * 2 * channels
    hop_bytes = HOP_SAMPLES * 2 * channels
    max_buffer = int(rate * MAX_BUFFER_SECONDS) * 2 * channels
    buffer = bytearray()
    last_emit = time.monotonic()
    last_data = time.monotonic()
    seq = 0
    try:
        while not stop_event.is_set():
            try:
                available = stream.get_read_available()
            except Exception:  # noqa: BLE001
                available = 0
            if available > 0:
                try:
                    chunk = stream.read(min(available, READ_CHUNK), exception_on_overflow=False)
                except Exception as error:  # noqa: BLE001
                    raise RuntimeError(f"loopback read failed: {error}") from error
                if chunk:
                    buffer.extend(chunk)
                    last_data = time.monotonic()
                    if len(buffer) > max_buffer:
                        # Never let a backlog turn into stale audio: only the
                        # newest window is analysed.
                        del buffer[: len(buffer) - window_bytes]
                while len(buffer) >= window_bytes:
                    frame = _frame(bytes(buffer[:window_bytes]), channels, _np)
                    del buffer[:hop_bytes]
                    seq += 1
                    rms, peak, bands = analyze(frame)
                    emit(
                        {
                            "type": "level",
                            "generation": generation,
                            "seq": seq,
                            "rms": round(rms, 5),
                            "peak": round(peak, 5),
                            "bands": [round(b, 4) for b in bands],
                        }
                    )
                    last_emit = time.monotonic()
            else:
                stop_event.wait(0.004)
                now = time.monotonic()
                if now - last_emit > IDLE_EMIT_SECONDS:
                    seq += 1
                    emit(
                        {
                            "type": "level",
                            "generation": generation,
                            "seq": seq,
                            "rms": 0.0,
                            "peak": 0.0,
                            "bands": [0.0] * BANDS,
                        }
                    )
                    last_emit = now
                if now - last_data > STALL_REOPEN_SECONDS:
                    raise RuntimeError("no audio data arrived; reopening the stream")
    except Stop:
        raise
    finally:
        with contextlib.suppress(Exception):
            stream.stop_stream()
        with contextlib.suppress(Exception):
            stream.close()


def _stdin_reader(stop_event: threading.Event) -> None:
    """Read control lines; EOF means the host is gone, so stop as well."""
    try:
        for line in sys.stdin:
            if line.strip().lower() in ("stop", "quit", "exit"):
                break
    except Exception:  # noqa: BLE001
        pass
    stop_event.set()


def main() -> int:
    _binary_mode()
    stop_event = threading.Event()
    threading.Thread(target=_stdin_reader, args=(stop_event,), daemon=True).start()

    forced_index = None
    if len(sys.argv) > 1:
        with contextlib.suppress(ValueError):
            forced_index = int(sys.argv[1])
    if forced_index is None:
        with contextlib.suppress(ValueError):
            forced_index = int(os.environ.get("DSH_VOLUME_BAR_DEVICE_INDEX", "").strip())
    requested = os.environ.get("DSH_VOLUME_BAR_DEVICE", "").strip() or None

    try:
        import pyaudiowpatch as pyaudio
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "helper_import_failed", "message": f"pyaudiowpatch is unavailable: {error}"})
        return 3

    try:
        p = pyaudio.PyAudio()
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "code": "portaudio_unavailable", "message": f"PortAudio failed to start: {error}"})
        return 3

    try:
        try:
            target, default_out, description = pick_device(p, pyaudio.paWASAPI, forced_index, requested)
        except Exception as error:  # noqa: BLE001
            emit({"type": "error", "code": "device_unavailable", "message": f"no usable loopback device: {error}"})
            return 2

        rate = int(target["defaultSampleRate"])
        channels = max(1, min(8, int(target["maxInputChannels"])))
        analyze, mode = make_analyzer(rate, channels)
        edges = band_edges(rate, BANDS)
        generation = f"{int(time.time() * 1000):x}-{os.getpid():x}"
        attempts = 0

        def hello() -> None:
            emit(
                {
                    "type": "hello",
                    "version": MODULE_VERSION,
                    "generation": generation,
                    "device": description,
                    "devices": list_devices(p),
                    "rate": rate,
                    "channels": channels,
                    "bands": BANDS,
                    "bandEdgesHz": [[round(lo, 1), round(hi, 1)] for lo, hi in edges],
                    "analysisMode": mode,
                    "windowSamples": WINDOW_SAMPLES,
                    "hopSamples": HOP_SAMPLES,
                }
            )

        hello()
        while not stop_event.is_set():
            try:
                _capture(p, target, channels, rate, analyze, generation, stop_event)
                break
            except Stop:
                break
            except RuntimeError as error:
                attempts += 1
                warn(f"{error} (attempt {attempts})")
                if attempts >= STREAM_OPEN_ATTEMPTS:
                    emit({"type": "error", "code": "capture_failed", "message": str(error)})
                    return 4
                # The output device may have changed under us: re-resolve it.
                stop_event.wait(min(2.0, 0.25 * attempts))
                with contextlib.suppress(Exception):
                    target, default_out, description = pick_device(p, pyaudio.paWASAPI, forced_index, requested)
                    rate = int(target["defaultSampleRate"])
                    channels = max(1, min(8, int(target["maxInputChannels"])))
                    analyze, mode = make_analyzer(rate, channels)
                    edges = band_edges(rate, BANDS)
                    hello()
                continue
        return 0
    finally:
        with contextlib.suppress(Exception):
            p.terminate()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        sys.exit(main())
