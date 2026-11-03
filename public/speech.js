// 状態の言葉の読み上げ。音声は補助で、消音でも光と文字だけで活動が成立する。
//
// 声は Nishio の録音（public/audio、scripts/prepare_voice.py で前後の無音と音量を整えたもの）を使う。
// 録音が読み込めない・再生できない場合は、合成音声（Web Speech API）で同じ言葉を読む（予備）。
//
// iPad Safari での確認（11月3日、Nishio）：
// - 一度ユーザーの操作（タップ）の中で speak() を呼ぶと、以後は操作なしの状態変化でも読み上げられた。
// - 操作がないうちは、開始・終了のイベントは出ても「声 0 件」で、実際に鳴ったかは不明。
// - Space キーだけでは解除できなかった（キー入力が届いていなかった可能性もあり、未確定）。
// 音声ファイルの再生も同様に操作の中での解除が必要なので、unlock() で録音と合成音声の両方を解除し、解除前の変化は読まない。
// 合成音声は、声の一覧が空のうちは読まず voiceschanged を待つ（空振り防止）。待っても来なければ既定の声で読む。
import { PHRASES } from './logic.js';

export const CLIPS = {
  [PHRASES.mine]: 'audio/dekita.m4a',
  [PHRASES.theirs]: 'audio/anata-no-ban.m4a',
  [PHRASES.complete]: 'audio/niji-ga-dekita.m4a',
};

const VOICES_WAIT_MS = 1500;

export function createSpeaker() {
  const synth = globalThis.speechSynthesis;
  const clips = new Map();
  if (typeof Audio !== 'undefined') {
    for (const [text, src] of Object.entries(CLIPS)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      const clip = { audio, broken: false, wanted: false };
      audio.addEventListener('error', () => { clip.broken = true; });
      audio.addEventListener('ended', () => { clip.wanted = false; });
      clips.set(text, clip);
    }
  }
  let unlocked = false;
  let enabled = true;
  let pending = null;
  let voices = [];
  let waitTimer = null;

  function stopClips() {
    for (const clip of clips.values()) {
      clip.wanted = false;
      clip.audio.pause();
      clip.audio.currentTime = 0;
    }
  }

  // ---- 予備：合成音声 ----
  function loadVoices() {
    voices = synth?.getVoices() ?? [];
    return voices.length > 0;
  }

  function utterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 0.8; // ゆっくり
    const ja = voices.find((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ja'));
    if (ja) u.voice = ja;
    return u;
  }

  function synthSpeak(text, force = false) {
    if (!synth) return;
    if (!loadVoices() && !force) {
      pending = text;
      if (!waitTimer) waitTimer = setTimeout(() => { waitTimer = null; flush(true); }, VOICES_WAIT_MS);
      return;
    }
    synth.cancel();
    synth.speak(utterance(text));
  }

  synth?.addEventListener('voiceschanged', () => flush());

  // ---- 本体：録音を再生し、だめなら合成音声 ----
  function speakNow(text, force) {
    stopClips();
    synth?.cancel();
    const clip = clips.get(text);
    if (!clip || clip.broken) return synthSpeak(text, force);
    clip.wanted = true;
    clip.audio.currentTime = 0;
    clip.audio.play().catch((e) => {
      // 自分の pause()（次の言葉への差し替え・停止）による中断は失敗ではないので、予備には回さない
      if (e?.name === 'AbortError') return;
      synthSpeak(text, force);
    });
  }

  function flush(force = false) {
    if (!pending || !unlocked || !enabled) return;
    const text = pending;
    pending = null;
    speakNow(text, force);
  }

  return {
    available: Boolean(synth) || clips.size > 0,
    // ユーザー操作（pointerup・click・keydown）のハンドラから呼ぶ。最初の1回だけ、
    // 録音を鳴らしてすぐ止め（先頭は無音の余白なので聞こえない）、合成音声も無音の発話で解除する。
    // 解除前に来ていた言葉は、その操作で状態が変わる前の古いものなので捨てる。
    unlock() {
      if (unlocked) return;
      unlocked = true;
      pending = null;
      for (const clip of clips.values()) {
        clip.audio
          .play()
          .then(() => {
            // 解除のための再生だけを止める。その間に本当の読み上げが始まっていれば止めない
            if (clip.wanted) return;
            clip.audio.pause();
            clip.audio.currentTime = 0;
          })
          .catch(() => {});
      }
      if (synth) {
        loadVoices();
        const u = utterance('');
        u.volume = 0;
        synth.speak(u);
      }
    },
    get unlocked() {
      return unlocked;
    },
    // 先生側のオン／オフ。オフにしたら読みかけも止める
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) this.stop();
    },
    // 言葉を1つ読む。直前の言葉が読みかけなら、新しい言葉に差し替える
    say(text) {
      if (!enabled || !text) return;
      pending = text;
      flush();
    },
    stop() {
      pending = null;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      stopClips();
      synth?.cancel();
    },
  };
}
