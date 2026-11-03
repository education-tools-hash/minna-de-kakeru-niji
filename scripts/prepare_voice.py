# 先生の録音（m4a）を、読み上げ用の音声に整える。
# 使い方: python3 scripts/prepare_voice.py 入力1.m4a 入力2.m4a 入力3.m4a（3つまとめて）
#        python3 scripts/prepare_voice.py --name hikatta 入力.m4a（1つだけ）
# 処理: 前後の無音を切る → 短い余白と フェードを付ける → 3つの音量（RMS）をそろえる → AAC（m4a）で書き出す。
# ffmpeg は使わず、macOS 付属の afconvert と Python 標準ライブラリだけで処理する。
import array, math, struct, subprocess, sys, tempfile, wave
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / 'public' / 'audio'
NAMES = ['hikatta', 'anata-no-ban', 'niji-ga-dekita']  # ひかったね／あなたの ばんだよ／にじが できたよ
RATE = 48000
SPEECH_DB = -30.0       # これより大きい区間を声の本体とみなす（ピーク比）
SILENCE_DB = -45.0      # 本体に隣接して、これより大きい間は声の続きとみなす（語尾の弱い音を切らない）
NOISE_MARGIN_DB = 8.0   # 暗騒音よりこれだけ大きい音だけを声の続きとみなす
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
    # 10 ms ごとのピークで、声の本体（ピーク比 SPEECH_DB 以上の区間を 150 ms 以内の切れ目でつなげた最長のかたまり）を見つけ、
    # その前後を、隣接して SILENCE_DB を超えている間だけ広げる。離れた小さな物音（息・衣擦れ）は含めない。
    peak = max(abs(x) for x in s)
    win = RATE // 100
    levels = [max(abs(x) for x in s[i:i + win]) / peak for i in range(0, len(s) - win, win)]
    hi = 10 ** (SPEECH_DB / 20)
    # 広げる基準は、ピーク比 SILENCE_DB と「録音の暗騒音（レベルの中央値）＋ NOISE_MARGIN_DB」の大きいほう。
    # 暗騒音が大きい録音で、声の前後の雑音まで含めてしまわないため。
    floor = sorted(levels)[len(levels) // 2]
    lo = max(10 ** (SILENCE_DB / 20), floor * 10 ** (NOISE_MARGIN_DB / 20))
    runs = []  # [start, end) in windows
    for i, v in enumerate(levels):
        if v <= hi: continue
        if runs and i - runs[-1][1] <= 15: runs[-1][1] = i + 1
        else: runs.append([i, i + 1])
    a, b = max(runs, key=lambda r: r[1] - r[0])
    while a > 0 and levels[a - 1] > lo: a -= 1
    while b < len(levels) and levels[b] > lo: b += 1
    pad = RATE * PAD_MS // 1000
    return s[max(0, a * win - pad):min(len(s), b * win + pad)]

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

def main(args):
    # 3ファイルまとめて（NAMES の順）か、--name 出力名 入力.m4a で1つだけ処理する
    if args[:1] == ['--name']:
        pairs = [(args[2], args[1])]
    else:
        assert len(args) == 3, '入力は3ファイル（ひかったね／あなたの ばんだよ／にじが できたよ の順）'
        pairs = list(zip(args, NAMES))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for src, name in pairs:
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
