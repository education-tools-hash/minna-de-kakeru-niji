// 状態の言葉の読み上げ。音声は補助で、消音でも光と文字だけで活動が成立する。
//
// 声は Nishio の録音（public/audio、scripts/prepare_voice.py で前後の無音と音量を整えたもの）だけを使う。
// 合成音声の予備は 11月3日に廃止した。録音は先読みしておき、読み込めない・再生できない場合は声なし（光と文字だけ）で成立させる。
//
// iPad Safari での確認（11月3日、Nishio）：一度ユーザーの操作（タップ）の中で再生を呼ぶと、以後は操作なしの状態変化でも鳴らせる。
// Space キーだけでは解除できなかった（キー入力が届いていなかった可能性もあり、未確定）。
// そのため、解除はユーザー操作のハンドラから unlock() で行い、解除前の変化は読まない。
//
// 11月5日の修正：解除は録音そのものではなく、無音の短い音（データ URI）を「再生用の要素」で鳴らして行う。
// 以前は3本の録音を同時に鳴らしてすぐ止めていたため、最初の本再生（ひかったね）がそれと重なり、
// iPad 実機で聞き取りづらかった。録音は別の要素で先読みだけ行い、本再生は再生用の要素の src を差し替えて行う
// （iOS では、操作の中で一度再生した要素は、src を変えても操作なしで再生できる）。
import { PHRASES } from './logic.js';

export const CLIPS = {
  [PHRASES.mine]: 'audio/hikatta.m4a',
  [PHRASES.theirs]: 'audio/anata-no-ban.m4a',
  [PHRASES.complete]: 'audio/niji-ga-dekita.m4a',
};

export function createSpeaker() {
  const hasAudio = typeof Audio !== 'undefined';
  // 先読み用（再生はしない）。読み込みに失敗した録音は使わない（声なしで成立）
  const clips = new Map();
  if (hasAudio) {
    for (const [text, src] of Object.entries(CLIPS)) {
      const loader = new Audio(src);
      loader.preload = 'auto';
      const clip = { src, broken: false };
      loader.addEventListener('error', () => { clip.broken = true; });
      loader.load();
      clips.set(text, clip);
    }
  }
  // 再生用（1つだけ）。解除も本再生もこの要素で行う
  const player = hasAudio ? new Audio() : null;
  if (player) player.preload = 'auto';
  let unlocked = false;
  let enabled = true;

  // 解除専用の無音（約 60 ms、8 kHz・8 bit の WAV）。録音ファイルには触れない
  const SILENCE = (() => {
    const samples = 480;
    const header = [
      0x52, 0x49, 0x46, 0x46, ...le32(36 + samples), 0x57, 0x41, 0x56, 0x45, // RIFF/WAVE
      0x66, 0x6d, 0x74, 0x20, ...le32(16), 1, 0, 1, 0, ...le32(8000), ...le32(8000), 1, 0, 8, 0, // fmt
      0x64, 0x61, 0x74, 0x61, ...le32(samples), // data
    ];
    const bytes = new Uint8Array(header.length + samples);
    bytes.set(header);
    bytes.fill(0x80, header.length); // 8 bit PCM の無音は 0x80
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return `data:audio/wav;base64,${btoa(bin)}`;
    function le32(n) { return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]; }
  })();

  function stopPlayer() {
    if (!player) return;
    player.pause();
    try { player.currentTime = 0; } catch { /* src 未設定のときは無視 */ }
  }

  return {
    available: Boolean(player),
    // ユーザー操作（pointerup・click・keydown）のハンドラから呼ぶ。最初の1回だけ、
    // 再生用の要素で無音を鳴らして再生を解除する。録音は鳴らさないので、直後の本再生と重ならない
    unlock() {
      if (!player || unlocked) return;
      unlocked = true;
      player.src = SILENCE;
      player.play().catch(() => {});
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
      if (!player || !enabled || !unlocked || !text) return;
      const clip = clips.get(text);
      stopPlayer();
      if (!clip || clip.broken) return;
      // 同じ録音なら先頭に戻すだけ。違う録音なら src を差し替える（先読み済みなのでキャッシュから読める）
      if (!player.src.endsWith(clip.src)) player.src = clip.src;
      player.play().catch(() => {});
    },
    stop() {
      stopPlayer();
    },
  };
}
