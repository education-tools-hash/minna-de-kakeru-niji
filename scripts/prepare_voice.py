# 先生の録音（m4a）を、読み上げ用の音声に整える。
# 使い方: python3 scripts/prepare_voice.py 入力1.m4a 入力2.m4a 入力3.m4a
# 処理: 前後の無音を切る → 短い余白と フェードを付ける → 3つの音量（RMS）をそろえる → AAC（m4a）で書き出す。
# ffmpeg は使わず、macOS 付属の afconvert と Python 標準ライブラリだけで処理する。
import array, math, struct, subprocess, sys, tempfile, wave
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / 'public' / 'audio'
NAMES = ['dekita', 'anata-no-ban', 'niji-ga-dekita']  # できた！／あなたの ばんだよ／にじが できたよ
RATE = 48000
SILENCE_DB = -45.0      # これより小さい区間を前後の無音とみなす（ピーク比。語尾の弱い音を切らないよう控えめに）
PAD_MS = 100            # 前後に残す余白
FADE_MS = 12            # クリック音を防ぐフェード
TARGET_RMS_DB = -20.0   # 3つの音量をそろえる基準
PEAK_LIMIT_DB = -1.0    # 歪み防止の上限

def run(*cmd):
    subprocess.run(cmd, check=True, capture_output=True)

def read_wav(path):
    # afconvert は WAVE_FORMAT_EXTENSIBLE で書くため wave モジュールでは読めない。チャンクを直接読む。
    data = Path(path).read_bytes()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
    pos = 12; fmt = None; pcm = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]; size = struct.unpack('<I', data[pos + 4:pos + 8])[0]; body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ': fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data': pcm = body
        pos += 8 + size + (size & 1)
    _, channels, rate, _, _, bits = fmt
    assert channels == 1 and rate == RATE and bits == 16, fmt
    a = array.array('h'); a.frombytes(pcm[:len(pcm) // 2 * 2])
    return [s / 32768.0 for s in a]

def write_wav(path, samples):
    a = array.array('h', [int(max(-1.0, min(1.0, s)) * 32767) for s in samples])
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(a.tobytes())

def db(x): return 20 * math.log10(max(x, 1e-9))
def rms(s): return math.sqrt(sum(x * x for x in s) / max(len(s), 1))

def trim(s):
    peak = max(abs(x) for x in s)
    thr = peak * 10 ** (SILENCE_DB / 20)
    win = RATE // 100  # 10 ms ごとに判定
    loud = [i for i in range(0, len(s) - win, win) if max(abs(x) for x in s[i:i + win]) > thr]
    pad = RATE * PAD_MS // 1000
    start = max(0, loud[0] - pad); end = min(len(s), loud[-1] + win + pad)
    return s[start:end]

def fade(s):
    n = RATE * FADE_MS // 1000
    for i in range(n):
        g = i / n
        s[i] *= g; s[-1 - i] *= g
    return s

def normalize(s):
    gain = 10 ** ((TARGET_RMS_DB - db(rms(s))) / 20)
    peak = max(abs(x) for x in s) * gain
    limit = 10 ** (PEAK_LIMIT_DB / 20)
    if peak > limit: gain *= limit / peak
    return [x * gain for x in s]

def main(inputs):
    assert len(inputs) == 3, '入力は3ファイル（できた！／あなたの ばんだよ／にじが できたよ の順）'
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for src, name in zip(inputs, NAMES):
            wav_in = Path(tmp) / f'{name}-in.wav'; wav_out = Path(tmp) / f'{name}-out.wav'
            run('afconvert', '-f', 'WAVE', '-d', f'LEI16@{RATE}', '-c', '1', src, str(wav_in))
            s = read_wav(wav_in)
            before = len(s) / RATE
            s = normalize(fade(trim(s)))
            write_wav(wav_out, s)
            out = OUT_DIR / f'{name}.m4a'
            run('afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', str(wav_out), str(out))
            print(f'{name}: {before:.2f}s → {len(s)/RATE:.2f}s, RMS {db(rms(s)):.1f} dBFS, peak {db(max(abs(x) for x in s)):.1f} dBFS, {out.stat().st_size} bytes')

if __name__ == '__main__':
    main(sys.argv[1:])
