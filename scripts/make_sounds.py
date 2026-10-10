"""The terrarium's sound effects, synthesized from noise and tones into small
WAV files in sounds/. Nothing is recorded: every sound is built here, so it
can be tuned and made again.

Run with any Python that has numpy (Blender's own has it):

    python scripts/make_sounds.py
"""

import os
import wave

import numpy as np

SR = 22050
rng = np.random.default_rng(11)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sounds")


# ----------------------------------------------------------------- building blocks

def span(seconds):
    return np.arange(int(SR * seconds)) / SR


def noise(seconds):
    return rng.standard_normal(int(SR * seconds))


def env(seconds, attack, decay, hold=0.0):
    """Rises over `attack`, holds, then falls away exponentially with time constant `decay`."""
    t = span(seconds)
    rise = np.clip(t / max(attack, 1e-4), 0, 1)
    fall = np.exp(-np.maximum(t - attack - hold, 0) / decay)
    return rise * fall


def tone(freqs, shape="sine"):
    """A tone whose frequency follows `freqs` (one value per sample)."""
    phase = 2 * np.pi * np.cumsum(freqs) / SR
    if shape == "saw":
        return 2 * ((phase / (2 * np.pi)) % 1) - 1
    if shape == "square":
        return np.sign(np.sin(phase))
    return np.sin(phase)


def glide(f0, f1, seconds, curve=1.0):
    u = np.linspace(0, 1, int(SR * seconds)) ** curve
    return f0 * (f1 / f0) ** u


def lowpass(x, fc):
    a = np.exp(-2 * np.pi * np.asarray(fc, float) / SR) * np.ones(len(x))
    y = np.empty_like(x)
    prev = 0.0
    for i in range(len(x)):
        prev = (1 - a[i]) * x[i] + a[i] * prev
        y[i] = prev
    return y


def highpass(x, fc):
    return x - lowpass(x, fc)


def bandpass(x, fc, q):
    """A resonant band-pass (biquad) whose centre may move sample by sample."""
    fc = np.asarray(fc, float) * np.ones(len(x))
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        w = 2 * np.pi * min(fc[i], SR * 0.45) / SR
        alpha = np.sin(w) / (2 * q)
        b0, b2 = alpha, -alpha
        a0, a1, a2 = 1 + alpha, -2 * np.cos(w), 1 - alpha
        out = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0
        x2, x1 = x1, x[i]
        y2, y1 = y1, out
        y[i] = out
    return y


def bubbles(seconds, count, low, high, size=0.02):
    """Little wet blips: short rising tones scattered through the clip."""
    out = np.zeros(int(SR * seconds))
    for _ in range(count):
        start = int(rng.uniform(0, seconds * 0.85) * SR)
        d = rng.uniform(size * 0.6, size * 1.6)
        f = glide(rng.uniform(low, high), rng.uniform(low, high) * 1.8, d)
        blip = tone(f) * env(d, 0.002, d / 3)
        end = min(len(out), start + len(blip))
        out[start:end] += blip[: end - start] * rng.uniform(0.3, 1.0)
    return out


def fit(*parts):
    n = max(len(p) for p in parts)
    return sum(np.pad(p, (0, n - len(p))) for p in parts)


def write(name, x, peak=0.9):
    x = np.asarray(x, float)
    x = x - np.mean(x)
    fade = min(len(x), int(SR * 0.01))
    x[-fade:] *= np.linspace(1, 0, fade)
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    data = (x * 32767).astype("<i2").tobytes()
    with wave.open(os.path.join(OUT, f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"{name}.wav  {len(x) / SR:.2f}s")


# ----------------------------------------------------------------- the sounds

def thud():
    """A heavy foot coming down: a falling low note, a soft knock, a little grit."""
    d = 0.5
    body = tone(glide(95, 38, d, 0.5)) * env(d, 0.003, 0.11)
    knock = lowpass(noise(d), 700) * env(d, 0.001, 0.018) * 3
    grit = highpass(noise(d), 2500) * env(d, 0.002, 0.03) * 0.15
    return body + knock + grit


def squelch():
    """A tentacle pushing out: a wet, closing resonance with bubbles in it."""
    d = 0.5
    wet = bandpass(noise(d), glide(1500, 320, d, 0.6), 7) * env(d, 0.012, 0.16)
    wobble = 1 + 0.5 * np.sin(2 * np.pi * 23 * span(d))
    return wet * wobble * 3 + bubbles(d, 9, 220, 700, 0.025) * env(d, 0.01, 0.2) * 0.5


def splat():
    """The tentacle landing: a wet slap."""
    d = 0.35
    slap = lowpass(noise(d), 2600) * env(d, 0.001, 0.025) * 2
    body = bandpass(noise(d), glide(900, 380, d), 5) * env(d, 0.002, 0.07) * 3
    return slap + body + bubbles(d, 5, 300, 900, 0.018) * env(d, 0.005, 0.12) * 0.4


def slurp():
    """Letting go: a rising suck, gurgling."""
    d = 0.6
    suck = bandpass(noise(d), glide(280, 1700, d, 1.4), 8) * env(d, 0.05, 0.22, 0.15)
    gurgle = 1 + 0.6 * np.sin(2 * np.pi * 17 * span(d) + 2 * np.sin(2 * np.pi * 3 * span(d)))
    return suck * gurgle * 3 + bubbles(d, 7, 200, 500, 0.03) * env(d, 0.05, 0.25) * 0.4


def pop():
    """An eye opening: a bright bloop."""
    d = 0.22
    f = glide(260, 1150, d, 0.25)
    return tone(f) * env(d, 0.002, 0.05) + tone(f * 2) * env(d, 0.002, 0.03) * 0.25


def zap():
    """Lightning up to the web: crackling bursts over an electric buzz."""
    d = 0.6
    gate = (rng.random(int(SR * d)) < 0.06).astype(float)
    gate = lowpass(gate, 400) * 6
    crackle = highpass(noise(d), 1800) * gate
    buzz = highpass(tone(np.full(int(SR * d), 118), "saw"), 300) * 0.35
    return (crackle + buzz) * env(d, 0.004, 0.2)


def crack():
    """An error striking: a split-second crack and a rolling tail."""
    d = 1.4
    snap = noise(d) * env(d, 0.0005, 0.012) * 2
    ring = bandpass(noise(d), 2100, 4) * env(d, 0.001, 0.05) * 2
    roll = lowpass(noise(d), 180) * env(d, 0.03, 0.45) * 4
    return snap + ring + roll


def thunder():
    """Storm thunder far off: a long, uneven rumble."""
    d = 3.2
    rumble = lowpass(lowpass(noise(d), 160), 220)
    swell = lowpass(np.abs(noise(d)), 4) * 3 + 0.4
    return rumble * swell * env(d, 0.12, 0.9, 0.2)


def growl():
    """Waking: a low gurgling growl."""
    d = 1.1
    t = span(d)
    f = 62 + 9 * np.sin(2 * np.pi * 5.5 * t) + 18 * env(d, 0.2, 0.5)
    voice = bandpass(tone(f, "saw"), glide(380, 520, d), 3) * 2
    breath = bandpass(noise(d), 650, 2) * 0.5
    return (voice + breath) * env(d, 0.12, 0.35, 0.3) + bubbles(d, 8, 120, 300, 0.04) * env(d, 0.2, 0.4) * 0.6


def sigh():
    """Curling up to sleep: a slow breath out."""
    d = 1.6
    breath = bandpass(noise(d), glide(820, 360, d), 2.5)
    hum = tone(glide(110, 82, d)) * 0.25
    return (breath + hum) * env(d, 0.35, 0.45, 0.25)


def sizzle():
    """Sparks off a forge: crackle and hiss."""
    d = 0.8
    pops = (rng.random(int(SR * d)) < 0.012).astype(float)
    crackle = highpass(lowpass(pops, 5000) * 8, 1500)
    hiss = highpass(noise(d), 4000) * 0.25
    return (crackle + hiss) * env(d, 0.01, 0.3)


def firework():
    """A rocket: a falling whistle, the bang, and a crackling fall."""
    whistle_d = 0.7
    whistle = tone(glide(2100, 1100, whistle_d) * (1 + 0.01 * np.sin(2 * np.pi * 30 * span(whistle_d)))) * env(whistle_d, 0.05, 0.6) * 0.3
    bang = crack()[: int(SR * 1.0)]
    sparkle = sizzle()
    return fit(whistle, np.pad(bang, (int(SR * whistle_d), 0)), np.pad(sparkle, (int(SR * (whistle_d + 0.15)), 0)) * 0.6)


def whoosh():
    """A shooting star: air torn across the sky."""
    d = 1.3
    return bandpass(noise(d), glide(400, 2600, d, 0.6), 3) * env(d, 0.35, 0.3, 0.2) * 2


def chirp():
    """A bird by day: two quick rising notes."""
    d = 0.42
    out = np.zeros(int(SR * d))
    for start, f0 in ((0.0, 3100), (0.17, 3500)):
        n = 0.12
        note = tone(glide(f0, f0 * 1.45, n, 0.7)) * env(n, 0.005, 0.04)
        i = int(start * SR)
        out[i:i + len(note)] += note
    return out


def sip():
    """A read: a soft suck and a swallow."""
    d = 0.42
    suck = bandpass(noise(d), glide(320, 1100, d, 0.8), 6) * env(d, 0.03, 0.08, 0.06) * 2.5
    gulp = tone(glide(210, 120, 0.12)) * env(0.12, 0.004, 0.04)
    return fit(suck, np.pad(gulp, (int(SR * 0.24), 0)) * 0.8)


def glug():
    """Writing a new file: thick gloops pouring out."""
    d = 0.6
    out = np.zeros(int(SR * d))
    for k, f0 in enumerate((150, 120, 170)):
        n = 0.11
        blob = tone(glide(f0, f0 * 2.3, n, 0.6)) * env(n, 0.006, 0.04)
        i = int(k * 0.15 * SR)
        out[i:i + len(blob)] += blob
    return out + lowpass(noise(d), 500) * env(d, 0.02, 0.2) * 0.6


def tap():
    """An edit: quick wet picks, three in a row."""
    d = 0.3
    out = np.zeros(int(SR * d))
    for k in range(3):
        n = 0.05
        click = bandpass(noise(n), 2300 - k * 300, 6) * env(n, 0.0008, 0.007) * 3 + tone(np.full(int(SR * n), 820 + k * 90)) * env(n, 0.001, 0.012) * 0.4
        i = int(k * 0.075 * SR)
        out[i:i + len(click)] += click
    return out


def sonar():
    """A search: a wet ping and its echoes."""
    d = 1.0
    ping = tone(glide(1350, 1180, 0.4)) * env(0.4, 0.004, 0.11)
    bloop = tone(glide(240, 520, 0.12)) * env(0.12, 0.003, 0.04) * 0.5
    first = fit(ping, bloop)
    return fit(first, np.pad(first, (int(SR * 0.2), 0)) * 0.35, np.pad(first, (int(SR * 0.4), 0)) * 0.12, np.zeros(int(SR * d)))


def chime():
    """A skill or an MCP call: a soft, shimmering bell."""
    d = 1.3
    t = span(d)
    bell = sum(np.sin(2 * np.pi * f * t) * g * np.exp(-t / k) for f, g, k in ((880, 1, 0.5), (1334, 0.5, 0.35), (2218, 0.3, 0.2), (3121, 0.15, 0.12)))
    return bell * env(d, 0.003, 9) * (1 + 0.15 * np.sin(2 * np.pi * 6 * t))


def call():
    """The turtle hears a new prompt: a deep, slow call, rising and falling, breath under it."""
    d = 2.6
    t = span(d)
    f = np.interp(t, [0, 0.7, 1.6, d], [64, 92, 84, 58]) * (1 + 0.012 * np.sin(2 * np.pi * 4.2 * t))
    voice = bandpass(tone(f, "saw"), np.interp(t, [0, 0.8, d], [260, 460, 300]), 2.5) * 1.6 + tone(f) * 0.5
    breath = bandpass(noise(d), 380, 1.5) * 0.25
    return (voice + breath) * env(d, 0.45, 0.6, 0.9)


def stroke():
    """A flipper's down-beat: a soft, low sweep."""
    d = 0.9
    sweep = bandpass(noise(d), glide(240, 620, d, 0.5), 2.2) * 1.4
    body = tone(glide(90, 60, d)) * 0.35
    return (sweep + body) * env(d, 0.22, 0.22, 0.08)


SOUNDS = dict(thud=thud, squelch=squelch, splat=splat, slurp=slurp, pop=pop, zap=zap, crack=crack,
              thunder=thunder, growl=growl, sigh=sigh, sizzle=sizzle, firework=firework, whoosh=whoosh, chirp=chirp,
              sip=sip, glug=glug, tap=tap, sonar=sonar, chime=chime, call=call, stroke=stroke)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, make in SOUNDS.items():
        write(name, make())
