// クライアント側の確認（Rules の単体テストでは検証できない「表示」の部分）。
// テスト番号は「Firebase 机上検証メモ v1.2」§3 に対応する。実機での見え方は E1〜E4 で別途確認する。
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  approvalMessage,
  canContribute,
  createCelebrationTracker,
  createAnnouncer,
  createInputGate,
  freeRole,
  jointCount,
  PHRASES,
  statusPhrase,
  viewState,
} from '../public/logic.js';

describe('C. 切断・再接続と演出の再演防止', () => {
  test('C1 虹完成済み（A=1,B=1）で再接続すると、完成状態を静止表示し演出は再演しない', () => {
    const counters = { a: 1, b: 1 };
    const tracker = createCelebrationTracker(jointCount(counters));
    expect(viewState(counters, 'b').rainbowComplete).toBe(true);
    expect(tracker.update(jointCount(counters))).toBe(0);
  });

  test('C2 A 待機中（A=2,B=1）で A が再接続すると、待機状態が復元される', () => {
    const state = viewState({ a: 2, b: 1 }, 'a');
    expect(state.mineWaiting).toBe(true);
    expect(state.theirsWaiting).toBe(false);
    expect(state.joint).toBe(1);
  });

  test('C3 再読み込みでも完成状態を静止表示し、その後の共同変化だけを演出する', () => {
    const tracker = createCelebrationTracker(jointCount({ a: 1, b: 1 }));
    expect(tracker.update(1)).toBe(0);
    expect(tracker.update(2)).toBe(1);
    expect(tracker.update(2)).toBe(0);
  });
});

describe('A6・B4 のクライアント側', () => {
  test('A6 満員のとき、教員画面に「満員のため承認できない」と表示する', () => {
    expect(freeRole({ a: 'x', b: 'y' })).toBeNull();
    expect(approvalMessage({ a: 'x', b: 'y' })).toMatch('満員');
    expect(freeRole({ b: 'y' })).toBe('a');
    expect(approvalMessage({ b: 'y' })).toBeNull();
  });

  test('B4 先行中（A=2,B=1）はクライアント側で書き込み自体を行わない', () => {
    expect(canContribute({ a: 2, b: 1 }, 'a')).toBe(false);
    expect(canContribute({ a: 1, b: 1 }, 'a')).toBe(true);
    expect(canContribute({ a: 2, b: 1 }, 'b')).toBe(true);
  });

  test('min 方式の例（設計メモ §6）', () => {
    expect(viewState({ a: 0, b: 0 }, 'a')).toMatchObject({ joint: 0, rainbowComplete: false, mineWaiting: false });
    expect(viewState({ a: 1, b: 0 }, 'a')).toMatchObject({ joint: 0, mineWaiting: true });
    expect(viewState({ a: 2, b: 2 }, 'b')).toMatchObject({ joint: 2, mineWaiting: false, theirsWaiting: false });
  });
});

// アクセシビリティ対応表（2026年11月2日確定）の 2・3・8 に対応する
describe('入力の受け付け（対応表 2・3）', () => {
  test('タッチ：pointerup と直後の click は、合わせて1回の参加', () => {
    const gate = createInputGate();
    expect(gate.pointerUp(1000)).toBe(true);
    expect(gate.click(1010)).toBe(false);
  });

  test('click だけを送る入力（VoiceOver・注視クリック・スキャン）も1回の参加になる', () => {
    const gate = createInputGate();
    expect(gate.click(1000)).toBe(true);
    expect(gate.click(3000)).toBe(true);
  });

  test('すばやい連続タップは、タップごとに1回ずつ（click では重ねて数えない）', () => {
    const gate = createInputGate();
    expect([gate.pointerUp(0), gate.click(10), gate.pointerUp(200), gate.click(210)]).toEqual([true, false, true, false]);
  });

  test('Space／Enter の押しっぱなし（自動リピート）は数えない', () => {
    const gate = createInputGate();
    expect(gate.key(false)).toBe(true);
    expect(gate.key(true)).toBe(false);
  });
});

describe('光の動き（対応表 5・6・8）', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  test('繰り返す動きはすべて周期2秒以上（速い点滅をしない）', () => {
    const loops = [...css.matchAll(/animation:\s*[\w-]+\s+([\d.]+)s[^;]*infinite/g)];
    expect(loops.length).toBeGreaterThanOrEqual(2);
    for (const [, seconds] of loops) expect(Number(seconds)).toBeGreaterThanOrEqual(2);
  });

  test('自分の光は明るさの呼吸、相手の光は揺れ（動きの種類が違う）', () => {
    expect(css).toMatch(/\.light\.held\s*{[^}]*animation:\s*breathe/);
    expect(css).toMatch(/\.light\.inviting\s*{[^}]*animation:\s*sway/);
    expect(css).toMatch(/@keyframes breathe\s*{[^}]*opacity/);
    expect(css).toMatch(/@keyframes sway\s*{[^}]*translateX/);
  });

  test('「視差効果を減らす」では動きを止め、明るいまま静止する', () => {
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.light\.held,\s*\.light\.inviting\s*{[^}]*animation:\s*none[^}]*opacity:\s*0\.9/);
  });
});

describe('状態の言葉と読み上げ（11月3日の変更）', () => {
  test('状態ごとの言葉：自分が待っている→できた！、相手の光が来ている→あなたの ばんだよ、虹の完成→にじが できたよ', () => {
    expect(statusPhrase(viewState({ a: 1, b: 0 }, 'a'))).toBe('できた！');
    expect(statusPhrase(viewState({ a: 1, b: 0 }, 'b'))).toBe('あなたの ばんだよ');
    expect(statusPhrase(viewState({ a: 1, b: 1 }, 'a'))).toBe('にじが できたよ');
    expect(statusPhrase(viewState({ a: 0, b: 0 }, 'a'))).toBe('ひかりを だそう');
    // 自分が待っている言葉を、相手の光より優先する（両方待つ状態は min 方式では起きないが、順序を固定する）
    expect(statusPhrase({ mineWaiting: true, theirsWaiting: true, rainbowComplete: true })).toBe('できた！');
  });

  test('読み上げは状態が変わったときに1回だけで、同じ状態の再描画では読まない', () => {
    const announcer = createAnnouncer(PHRASES.start);
    expect(announcer.next(PHRASES.start)).toBeNull();
    expect(announcer.next(PHRASES.mine)).toBe('できた！');
    expect(announcer.next(PHRASES.mine)).toBeNull();
    expect(announcer.next(PHRASES.complete)).toBe('にじが できたよ');
    expect(announcer.next(PHRASES.theirs)).toBe('あなたの ばんだよ');
  });

  test('読み込み時点の状態は読まず（静止表示）、その後の変化だけ読む', () => {
    const announcer = createAnnouncer(PHRASES.complete);
    expect(announcer.next(PHRASES.complete)).toBeNull();
    expect(announcer.next(PHRASES.mine)).toBe('できた！');
  });

  test('最初の状態「ひかりを だそう」は文字だけで読み上げない', () => {
    const announcer = createAnnouncer(PHRASES.mine);
    expect(announcer.next(PHRASES.start)).toBeNull();
  });
});

describe('読み上げの声（Nishio の録音）', () => {
  test('読み上げる3つの言葉それぞれに録音ファイルがあり、最初の状態には無い', async () => {
    const { CLIPS } = await import('../public/speech.js');
    for (const phrase of [PHRASES.mine, PHRASES.theirs, PHRASES.complete]) {
      expect(CLIPS[phrase]).toMatch(/^audio\/.+\.m4a$/);
      expect(readFileSync(`public/${CLIPS[phrase]}`).length).toBeGreaterThan(1000);
    }
    expect(CLIPS[PHRASES.start]).toBeUndefined();
  });
});
