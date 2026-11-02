// クライアント側の確認（Rules の単体テストでは検証できない「表示」の部分）。
// テスト番号は「Firebase 机上検証メモ v1.2」§3 に対応する。実機での見え方は E1〜E4 で別途確認する。
import { describe, expect, test } from 'vitest';
import {
  approvalMessage,
  canContribute,
  createCelebrationTracker,
  freeRole,
  jointCount,
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
