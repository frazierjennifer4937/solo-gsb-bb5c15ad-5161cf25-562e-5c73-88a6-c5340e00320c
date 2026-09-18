import { describe, expect, it } from 'vitest';
import {
  applyRepeatPlan,
  buildRepeatPlan,
  mapRectToPage,
  parsePageRanges,
  type RepeatSource,
} from './repeatRegion';
import type { RedactionMap } from '../types';

const SIZES = [
  { width: 612, height: 792 }, // 1: Letter 纵向
  { width: 792, height: 612 }, // 2: Letter 横向
  { width: 200, height: 400 }, // 3: 小页
];

let idCounter = 0;
const nextId = () => `id-${++idCounter}`;

describe('parsePageRanges', () => {
  it('解析单页、逗号列表与区间，升序去重', () => {
    expect(parsePageRanges('1-3,5', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRanges(' 3 , 1-2 , 2 ', 10)).toEqual([1, 2, 3]);
  });

  it('支持倒序区间与多种连字符', () => {
    expect(parsePageRanges('3-1', 5)).toEqual([1, 2, 3]);
    expect(parsePageRanges('1–2', 5)).toEqual([1, 2]);
    expect(parsePageRanges('2—3', 5)).toEqual([2, 3]);
    expect(parsePageRanges('1~2', 5)).toEqual([1, 2]);
  });

  it('越界页码与范围段被夹取 / 忽略', () => {
    expect(parsePageRanges('8', 3)).toBeNull();
    expect(parsePageRanges('0', 3)).toBeNull();
    expect(parsePageRanges('2-9', 3)).toEqual([2, 3]);
    expect(parsePageRanges('8-10,1', 3)).toEqual([1]);
  });

  it('空白、非法片段返回 null', () => {
    expect(parsePageRanges('', 3)).toBeNull();
    expect(parsePageRanges('   ', 3)).toBeNull();
    expect(parsePageRanges('1,a', 3)).toBeNull();
    expect(parsePageRanges('1.5', 3)).toBeNull();
    expect(parsePageRanges('1--2', 3)).toBeNull();
  });
});

describe('mapRectToPage', () => {
  const header: RepeatSource['rect'] = { x1: 36, y1: 742, x2: 576, y2: 772 };

  it('同尺寸页面按 1:1 映射', () => {
    expect(mapRectToPage(header, SIZES[0], SIZES[0])).toEqual(header);
  });

  it('按宽高比例映射到不同尺寸页面', () => {
    const r = mapRectToPage(header, SIZES[0], SIZES[2])!;
    expect(r.x1).toBeCloseTo((36 / 612) * 200, 10);
    expect(r.x2).toBeCloseTo((576 / 612) * 200, 10);
    expect(r.y1).toBeCloseTo((742 / 792) * 400, 10);
    expect(r.y2).toBeCloseTo((772 / 792) * 400, 10);
    // 保持归一化
    expect(r.x1).toBeLessThan(r.x2);
    expect(r.y1).toBeLessThan(r.y2);
  });

  it('横向页：页眉条按比例映射（距页顶的 20 点边距同步缩放）', () => {
    const r = mapRectToPage(header, SIZES[0], SIZES[1])!;
    expect(r.y2).toBeCloseTo((772 / 792) * 612, 10);
    expect(r.y1).toBeCloseTo((742 / 792) * 612, 0);
    expect(r.x1).toBeCloseTo((36 / 612) * 792, 10);
  });

  it('源区域贴边映射到目标页时同样贴边', () => {
    // 贴着源页顶部的页眉条（y2 = 页高）映射后仍贴着目标页顶部
    const flushTop = { x1: 36, y1: 762, x2: 576, y2: 792 };
    const rLandscape = mapRectToPage(flushTop, SIZES[0], SIZES[1])!;
    expect(rLandscape.y2).toBe(612);
    const rSmall = mapRectToPage(flushTop, SIZES[0], SIZES[2])!;
    expect(rSmall.y2).toBe(400);
  });

  it('越界部分夹取到目标页边界内', () => {
    const outside = { x1: -50, y1: -10, x2: 300, y2: 500 };
    const r = mapRectToPage(outside, SIZES[0], SIZES[0])!;
    expect(r).toEqual({ x1: 0, y1: 0, x2: 300, y2: 500 });
  });

  it('源页底部贴边区域映射到小页后仍贴底边，整体有效', () => {
    // y2 贴着源页底边（792），映射后夹到 / 恰好落在小页底边 400
    const footer = { x1: 36, y1: 732, x2: 576, y2: 792 };
    const r = mapRectToPage(footer, SIZES[0], SIZES[2])!;
    expect(r.y2).toBe(400);
    expect(r.y1).toBeCloseTo((732 / 792) * 400, 10);
    expect(r.x2).toBeCloseTo((576 / 612) * 200, 10);
    expect(r.x2 - r.x1).toBeGreaterThan(0);
    expect(r.y2 - r.y1).toBeGreaterThan(0);
  });

  it('源区域超出目标页比例位置时越界边被夹取', () => {
    // 源页右侧 300 点宽的区域，按比例映射到宽仅 200 的小页时右边界越过页宽
    const wide = { x1: 400, y1: 100, x2: 612, y2: 200 };
    const r = mapRectToPage(wide, SIZES[0], SIZES[2])!;
    expect(r.x1).toBeCloseTo((400 / 612) * 200, 10);
    expect(r.x2).toBe(200); // 612/612*200 = 200，贴边
    expect(r.x2 - r.x1).toBeGreaterThan(0);
  });

  it('完全落在页面外、夹取后退化为空时返回 null', () => {
    // 一条贴着源页右边界外侧的竖条，夹到小页右边线，宽度退化为 0
    const beyond = { x1: 612, y1: 100, x2: 660, y2: 200 };
    expect(mapRectToPage(beyond, SIZES[0], SIZES[2])).toBeNull();
  });
});

describe('buildRepeatPlan', () => {
  const source: RepeatSource = {
    page: 1,
    rect: { x1: 36, y1: 742, x2: 576, y2: 772 },
  };

  it('逐页给出映射矩形并标记重复', () => {
    const redactions: RedactionMap = {
      // 第 2 页已存在与映射结果 0.01 点容差内相同的框
      2: [{ id: 'x', ...expectedOnPage2() }],
    };
    const plan = buildRepeatPlan(source, [1, 2, 3], SIZES, redactions);
    expect(plan.previews).toHaveLength(3);
    expect(plan.previews[0].duplicate).toBe(false);
    expect(plan.previews[1].duplicate).toBe(true);
    expect(plan.previews[2].duplicate).toBe(false);
    const got = plan.previews[1].rect!;
    const want = expectedOnPage2();
    expect(got.x1).toBeCloseTo(want.x1, 10);
    expect(got.y1).toBeCloseTo(want.y1, 10);
    expect(got.x2).toBeCloseTo(want.x2, 10);
    expect(got.y2).toBeCloseTo(want.y2, 10);
  });

  function expectedOnPage2() {
    return {
      x1: (36 / 612) * 792,
      y1: (742 / 792) * 612,
      x2: (576 / 612) * 792,
      y2: (772 / 792) * 612,
    };
  }
});

describe('applyRepeatPlan', () => {
  const source: RepeatSource = {
    page: 1,
    rect: { x1: 36, y1: 742, x2: 576, y2: 772 },
  };

  it('一次批量加入，跳过重复页与退化页', () => {
    const existing = mapRectToPage(source.rect, SIZES[0], SIZES[1])!;
    const redactions: RedactionMap = {
      2: [{ id: 'keep', ...existing }],
      9: [{ id: 'untouched', x1: 1, y1: 1, x2: 2, y2: 2 }],
    };
    // 源区域对第 3 页映射有效；构造一个对第 3 页退化（null）的区域
    const beyond: RepeatSource = {
      page: 1,
      rect: { x1: 612, y1: 100, x2: 660, y2: 200 },
    };

    const planA = buildRepeatPlan(source, [1, 2, 3], SIZES, redactions);
    const resultA = applyRepeatPlan(redactions, planA, nextId);
    expect(resultA.appliedPages).toEqual([1, 3]);
    expect(resultA.skippedPages).toEqual([2]);
    // 不影响无关页，且不就地修改入参
    expect(redactions[9]).toHaveLength(1);
    expect(resultA.map[9]).toEqual(redactions[9]);
    expect(resultA.map[2]).toHaveLength(1);
    expect(resultA.map[2][0].id).toBe('keep');
    expect(resultA.map[1]).toHaveLength(1);
    expect(resultA.map[3]).toHaveLength(1);

    const planB = buildRepeatPlan(beyond, [3], SIZES, redactions);
    const resultB = applyRepeatPlan(redactions, planB, nextId);
    expect(resultB.appliedPages).toEqual([]);
    expect(resultB.skippedPages).toEqual([3]);
    expect(resultB.map[3]).toBeUndefined();
  });

  it('0.01 点容差内的框视为相同并跳过', () => {
    const base = mapRectToPage(source.rect, SIZES[0], SIZES[1])!;
    const redactions: RedactionMap = {
      2: [
        {
          id: 'near',
          x1: base.x1 + 0.009,
          y1: base.y1 - 0.005,
          x2: base.x2 + 0.01,
          y2: base.y2,
        },
      ],
    };
    const plan = buildRepeatPlan(source, [2], SIZES, redactions);
    expect(plan.previews[0].duplicate).toBe(true);
    const result = applyRepeatPlan(redactions, plan, nextId);
    expect(result.appliedPages).toEqual([]);
    expect(result.skippedPages).toEqual([2]);
  });

  it('超过 0.01 点容差则不跳过', () => {
    const base = mapRectToPage(source.rect, SIZES[0], SIZES[1])!;
    const redactions: RedactionMap = {
      2: [{ id: 'far', ...base, x2: base.x2 + 0.02 }],
    };
    const plan = buildRepeatPlan(source, [2], SIZES, redactions);
    expect(plan.previews[0].duplicate).toBe(false);
    const result = applyRepeatPlan(redactions, plan, nextId);
    expect(result.appliedPages).toEqual([2]);
    expect(result.map[2]).toHaveLength(2);
  });
});
