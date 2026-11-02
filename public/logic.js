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
