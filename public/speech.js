// 状態の言葉の読み上げ（Web Speech API）。音声は補助で、消音でも光と文字だけで活動が成立する。
//
// iPad Safari での確認（11月3日、Nishio）：
// - 一度ユーザーの操作（タップ）の中で speak() を呼ぶと、以後は操作なしの状態変化でも読み上げられた。
// - 操作がないうちは、開始・終了のイベントは出ても「声 0 件」で、実際に鳴ったかは不明。
// - Space キーだけでは解除できなかった（キー入力が届いていなかった可能性もあり、未確定）。
// そのため、解除はユーザー操作のハンドラから unlock() で行い、解除前の変化は読まない。
// 声の一覧が空のうちは読まず、voiceschanged を待ってから読む（空振り防止）。待っても来なければ既定の声で読む。

const VOICES_WAIT_MS = 1500;

export function createSpeaker() {
  const synth = globalThis.speechSynthesis;
  let unlocked = false;
  let enabled = true;
  let pending = null;
  let voices = [];
  let waitTimer = null;

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

  function speakNow(text) {
    synth.cancel();
    synth.speak(utterance(text));
  }

  // 条件がそろっていれば保留中の言葉を読む
  function flush(force = false) {
    if (!pending || !unlocked || !enabled) return;
    if (!loadVoices() && !force) {
      if (!waitTimer) waitTimer = setTimeout(() => { waitTimer = null; flush(true); }, VOICES_WAIT_MS);
      return;
    }
    const text = pending;
    pending = null;
    speakNow(text);
  }

  synth?.addEventListener('voiceschanged', () => flush());

  return {
    available: Boolean(synth),
    // ユーザー操作（pointerup・click・keydown）のハンドラから呼ぶ。最初の1回だけ、無音の発話で読み上げを解除する。
    // 解除前に来ていた言葉は、その操作で状態が変わる前の古いものなので捨てる。
    unlock() {
      if (!synth || unlocked) return;
      unlocked = true;
      pending = null;
      loadVoices();
      const u = utterance('');
      u.volume = 0;
      synth.speak(u);
    },
    get unlocked() {
      return unlocked;
    },
    // 先生側のオン／オフ。オフにしたら読みかけも止める
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) {
        pending = null;
        synth?.cancel();
      }
    },
    // 言葉を1つ読む。直前の言葉が読みかけなら、新しい言葉に差し替える
    say(text) {
      if (!synth || !enabled || !text) return;
      pending = text;
      flush();
    },
    stop() {
      pending = null;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
      synth?.cancel();
    },
  };
}
