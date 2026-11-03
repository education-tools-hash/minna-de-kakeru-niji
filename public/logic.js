// 画面に依存しない min 方式の判定ロジック。ブラウザとテストの両方から使う。

export const ROLES = ['a', 'b'];

export const otherRole = (role) => (role === 'a' ? 'b' : 'a');

// 共同成立回数（0 なら虹は未完成、1 で完成、以降の増加が共同変化）
export const jointCount = (counters) => Math.min(counters.a ?? 0, counters.b ?? 0);

// クライアント側の事前判定（主防御）。先行中は書き込まず、個別反応だけを返す。
// Rules の .validate と同じ条件で、拒否される書き込みによる画面のちらつきを防ぐ。
export const canContribute = (counters, role) =>
  (counters[role] ?? 0) <= (counters[otherRole(role)] ?? 0);

// 自分・相手それぞれが、現在のラウンドに参加済みで相手を待っているか
export function viewState(counters, role) {
  const joint = jointCount(counters);
  return {
    joint,
    rainbowComplete: joint >= 1,
    mineWaiting: (counters[role] ?? 0) > joint,
    theirsWaiting: (counters[otherRole(role)] ?? 0) > joint,
  };
}

// 演出の再演防止。画面読み込み時の min を「既に祝った回数」として受け取り、
// それ以降に増えた分だけ演出回数を返す。
export function createCelebrationTracker(initialJoint) {
  let celebrated = initialJoint;
  return {
    update(joint) {
      const fresh = Math.max(0, joint - celebrated);
      celebrated = Math.max(celebrated, joint);
      return fresh;
    },
  };
}

// 教員の承認：空いている役割を返す。満員なら null。
export const freeRole = (roles = {}) => ROLES.find((role) => !roles[role]) ?? null;

export const approvalMessage = (roles) =>
  freeRole(roles) ? null : '満員のため承認できません（A・B とも参加中です）';

// 参加の入力をまとめる。1回のジェスチャー・1回の押下を、1回の参加として数える。
// タッチやマウスは pointerup の直後に click も発生させるため、直前に pointerup があった click は数えない。
// click だけを送る入力（VoiceOver のダブルタップ、一部の注視クリック・スイッチ操作）は click で数える。
export const CLICK_DEDUPE_MS = 700;

export function createInputGate(windowMs = CLICK_DEDUPE_MS) {
  let lastPointerUp = -Infinity;
  return {
    pointerUp(t) {
      lastPointerUp = t;
      return true;
    },
    click(t) {
      return t - lastPointerUp >= windowMs;
    },
    // Space／Enter。押しっぱなしの自動リピートは数えない
    key(repeat) {
      return !repeat;
    },
  };
}

// 子ども画面の状態の言葉（11月3日に Nishio が確定）。短い言葉だけにし、読み上げにも使う。
// start（最初の状態）は文字だけで、読み上げない。
export const PHRASES = {
  mine: 'できたね',
  theirs: 'あなたの ばんだよ',
  complete: 'にじが できたよ',
  start: 'ひかりを だそう',
};
const SPOKEN = new Set([PHRASES.mine, PHRASES.theirs, PHRASES.complete]);

export function statusPhrase(state) {
  if (state.mineWaiting) return PHRASES.mine;
  if (state.theirsWaiting) return PHRASES.theirs;
  if (state.rainbowComplete) return PHRASES.complete;
  return PHRASES.start;
}

// 読み上げは「状態が変わったときに1回だけ」。読み込み時点の言葉は既に伝えたものとして扱い、読まない。
export function createAnnouncer(initialPhrase) {
  let last = initialPhrase;
  return {
    next(phrase) {
      if (phrase === last) return null;
      last = phrase;
      return SPOKEN.has(phrase) ? phrase : null;
    },
  };
}

// 虹の見せ方（案A、11月3日に Nishio が決定）：A の参加で暖色の弧、B の参加で寒色の弧を、その都度新しく描く。
// 完成した虹は薄い層として残し、新しい虹と重なって二重・三重に見える。層は MAX_LAYERS 枚までで、古いものから消える。
// counters だけから決まるので、再読み込み時も同じ状態を（描く動きなしで）表示できる。
export const MAX_LAYERS = 3;

export function rainbowView(counters) {
  const a = counters.a ?? 0;
  const b = counters.b ?? 0;
  const joint = Math.min(a, b);
  const inProgress = a > joint || b > joint; // 次の虹を描いている途中
  const completed = inProgress ? joint : Math.max(0, joint - 1); // 層になる完成済みの虹の数（表示中の虹は除く）
  const full = !inProgress && joint >= 1; // 表示中の虹が完成している
  return {
    layers: Math.min(completed, MAX_LAYERS),
    warm: a > joint || full,
    cool: b > joint || full,
    full,
  };
}
