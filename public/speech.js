// 状態の言葉の読み上げ。音声は補助で、消音でも光と文字だけで活動が成立する。
//
// 声は Nishio の録音（public/audio、scripts/prepare_voice.py で前後の無音と音量を整えたもの）だけを使う。
// 合成音声の予備は 11月3日に廃止した。録音は先読みしておき、読み込めない・再生できない場合は声なし（光と文字だけ）で成立させる。
//
// iPad Safari での確認（11月3日、Nishio）：一度ユーザーの操作（タップ）の中で再生を呼ぶと、以後は操作なしの状態変化でも鳴らせる。
// Space キーだけでは解除できなかった（キー入力が届いていなかった可能性もあり、未確定）。
// そのため、解除はユーザー操作のハンドラから unlock() で行い、解除前の変化は読まない。
import { PHRASES } from './logic.js';

export const CLIPS = {
  [PHRASES.mine]: 'audio/hikatta.m4a',
  [PHRASES.theirs]: 'audio/anata-no-ban.m4a',
  [PHRASES.complete]: 'audio/niji-ga-dekita.m4a',
};

export function createSpeaker() {
  const clips = new Map();
  if (typeof Audio !== 'undefined') {
    for (const [text, src] of Object.entries(CLIPS)) {
      const audio = new Audio(src);
      audio.preload = 'auto';
      const clip = { audio, broken: false, wanted: false };
      // 読み込みに失敗した録音は使わない（声なしで成立）
      audio.addEventListener('error', () => { clip.broken = true; });
      audio.addEventListener('ended', () => { clip.wanted = false; });
      audio.load(); // 先読み
      clips.set(text, clip);
    }
  }
  let unlocked = false;
  let enabled = true;

  function stopClips() {
    for (const clip of clips.values()) {
      clip.wanted = false;
      clip.audio.pause();
      clip.audio.currentTime = 0;
    }
  }

  return {
    available: clips.size > 0,
    // ユーザー操作（pointerup・click・keydown）のハンドラから呼ぶ。最初の1回だけ、
    // 録音を鳴らしてすぐ止めて再生を解除する（先頭は無音の余白なので聞こえない）。
    unlock() {
      if (unlocked) return;
      unlocked = true;
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
    },
    get unlocked() {
      return unlocked;
    },
    // 先生側のオン／オフ。オフにしたら読みかけも止める
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) this.stop();
    },
    // 言葉を1つ読む。直前の言葉が読みかけなら、新しい言葉に差し替える。
    // 解除前・録音が壊れている・再生できない場合は何もしない（光と文字だけで伝わる）。
    say(text) {
      if (!enabled || !unlocked || !text) return;
      stopClips();
      const clip = clips.get(text);
      if (!clip || clip.broken) return;
      clip.wanted = true;
      clip.audio.currentTime = 0;
      clip.audio.play().catch(() => {});
    },
    stop() {
      stopClips();
    },
  };
}
