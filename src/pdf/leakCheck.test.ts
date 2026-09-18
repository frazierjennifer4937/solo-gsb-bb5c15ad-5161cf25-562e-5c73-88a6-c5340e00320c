import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RedactionBox } from '../types';
import { buildPageText, type TextItem } from './textSearch';
import {
  applyLeakFixes,
  classifyPage,
  CONTAIN_TOLERANCE,
  countRisks,
  EXPAND_MARGIN,
  extractFragments,
  intersectionArea,
  rebuildReport,
  rectContains,
  rectSubtractAll,
  scanLeakReport,
  type LeakReport,
} from './leakCheck';

const F = 12;
const W = 612;
const H = 792;

function ti(str: string, x: number, y = 700, over: Partial<TextItem> = {}): TextItem {
  return {
    str,
    transform: [F, 0, 0, F, x, y],
    width: [...str].length * F,
    height: F,
    hasEOL: false,
    ...over,
  };
}

function box(id: string, x1: number, y1: number, x2: number, y2: number): RedactionBox {
  return { id, x1, y1, x2, y2 };
}

/** 片段：页面上的水平文本项，基线 (x,700)，字形盒约为 y∈[700-3.36, 700+12.24+pad] */
function fragmentOf(str: string, x: number) {
  const pt = buildPageText(1, { items: [ti(str, x)] });
  return extractFragments(1, pt, W, H)[0];
}

describe('几何原语', () => {
  it('intersectionArea：不相交为 0，相交为重叠面积', () => {
    expect(intersectionArea(box('a', 0, 0, 10, 10), box('b', 20, 20, 30, 30))).toBe(0);
    expect(intersectionArea(box('a', 0, 0, 10, 10), box('b', 5, 5, 15, 15))).toBe(25);
  });

  it('rectContains：完整包住（含容差边界）', () => {
    expect(rectContains({ x1: 2, y1: 2, x2: 8, y2: 8 }, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(true);
    // 外露 0.5 点恰在容差内：视为已包住
    expect(rectContains({ x1: -CONTAIN_TOLERANCE, y1: 0, x2: 8, y2: 8 }, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(true);
    expect(rectContains({ x1: -1, y1: 0, x2: 8, y2: 8 }, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(false);
  });

  it('rectSubtractAll：一侧外露返回一条；完全包住返回空', () => {
    // 片段 0..10，遮盖只盖 6..10 → 左侧 0..6 外露
    const left = rectSubtractAll({ x1: 0, y1: 0, x2: 10, y2: 10 }, [{ x1: 6, y1: 0, x2: 10, y2: 10 }]);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ x1: 0, x2: 6 });
    // 两片遮盖左右夹住，中间也被覆盖
    const covered = rectSubtractAll(
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      [
        { x1: 0, y1: 0, x2: 4, y2: 10 },
        { x1: 4, y1: 0, x2: 10, y2: 10 },
      ],
    );
    expect(covered).toHaveLength(0);
  });

  it('rectSubtractAll：上下两片遮盖不相连时，外露部分被切成多块且面积守恒', () => {
    const pieces = rectSubtractAll(
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      [
        { x1: 0, y1: 0, x2: 10, y2: 3 },
        { x1: 0, y1: 7, x2: 10, y2: 10 },
      ],
    );
    const area = pieces.reduce((s, p) => s + (p.x2 - p.x1) * (p.y2 - p.y1), 0);
    expect(area).toBeCloseTo(40, 6); // 中间 10×4
    expect(pieces).toHaveLength(1);
  });
});

describe('单页核对 classifyPage', () => {
  it('与遮盖无关的文字不报风险', () => {
    const f = fragmentOf('普通文字', 300);
    const report = classifyPage(1, W, H, [f], [box('b', 0, 0, 50, 50)]);
    expect(report.risks).toHaveLength(0);
    expect(report.fragmentCount).toBe(1);
  });

  it('片段被遮盖完整包住时不报风险', () => {
    const f = fragmentOf('保密', 100);
    const cover = { x1: 90, y1: 690, x2: 140, y2: 720 };
    const report = classifyPage(1, W, H, [f], [box('b', cover.x1, cover.y1, cover.x2, cover.y2)]);
    expect(report.risks).toHaveLength(0);
  });

  it('遮盖只压住片段左半时列为风险，外露部分在右侧，关联遮盖为相交最大者', () => {
    const f = fragmentOf('ABCD', 100); // 包围盒 x 约 99.76 .. 148.24
    const partial = box('cover', 90, 690, 125, 720);
    const report = classifyPage(1, W, H, [f], [partial]);
    expect(report.risks).toHaveLength(1);
    const risk = report.risks[0];
    expect(risk.boxId).toBe('cover');
    expect(risk.relatedBoxIds).toEqual(['cover']);
    expect(risk.text).toBe('ABCD');
    // 外露条带都在遮盖右边
    for (const e of risk.exposed) expect(e.x1).toBeGreaterThanOrEqual(125 - 0.01);
  });

  it('两个遮盖拼合后完整包住片段：不报风险', () => {
    const f = fragmentOf('ABCDEF', 100);
    const report = classifyPage(
      1,
      W,
      H,
      [f],
      [
        box('l', 90, 690, 130, 720),
        box('r', 130, 690, 180, 720),
      ],
    );
    expect(report.risks).toHaveLength(0);
  });

  it('多个遮盖相交时关联遮盖取相交面积最大者', () => {
    const f = fragmentOf('ABCDEF', 100);
    const report = classifyPage(
      1,
      W,
      H,
      [f],
      [
        box('small', 99, 699, 103, 705),
        box('big', 90, 690, 130, 720),
      ],
    );
    expect(report.risks[0].boxId).toBe('big');
    expect(report.risks[0].relatedBoxIds).toContain('small');
  });

  it('风险 id 在页与片段序号上稳定', () => {
    const pt = buildPageText(1, { items: [ti('甲', 100), ti('乙', 300)] });
    const frags = extractFragments(1, pt, W, H);
    const r1 = classifyPage(1, W, H, frags, [box('c', 90, 690, 105, 720)]);
    const r2 = classifyPage(1, W, H, frags, [box('c', 90, 690, 105, 720)]);
    expect(r1.risks.map((x) => x.id)).toEqual(r2.risks.map((x) => x.id));
    expect(r1.risks[0].id).toBe('leak-1-0');
  });
});

describe('批量扩展 applyLeakFixes', () => {
  it('把关联遮盖扩展到完整包住片段（含外扩余量并夹到页内）', () => {
    const f = fragmentOf('ABCD', 100);
    const partial = box('cover', 90, 690, 125, 720);
    const pageReport = classifyPage(1, W, H, [f], [partial]);
    const result = applyLeakFixes({ 1: [partial] }, pageReport.risks, [{ width: W, height: H }]);
    expect(result.fixedBoxes).toBe(1);
    expect(result.fixedRisks).toBe(1);
    const next = result.map[1][0];
    expect(next.id).toBe('cover'); // 原遮盖被扩展，而不是新增框
    expect(rectContains(f.rect, next, 0)).toBe(true);
    // 外扩了 EXPAND_MARGIN 余量
    expect(next.x1).toBeLessThanOrEqual(f.rect.x1 - EXPAND_MARGIN + 1e-9);
    expect(next.y1).toBeGreaterThanOrEqual(0);
    // 用扩展后的遮盖重新核对：风险消失
    const recheck = classifyPage(1, W, H, [f], result.map[1]);
    expect(recheck.risks).toHaveLength(0);
  });

  it('同一遮盖关联多项时取并集，只修改一个遮盖', () => {
    const f1 = fragmentOf('AAAA', 100);
    const f2 = fragmentOf('BBBB', 300);
    // 一个横跨两处文字、但上下都没盖全的遮盖
    const cover = box('wide', 90, 700, 360, 711);
    const report = classifyPage(1, W, H, [f1, f2], [cover]);
    expect(report.risks).toHaveLength(2);
    const result = applyLeakFixes({ 1: [cover] }, report.risks, [{ width: W, height: H }]);
    expect(result.map[1]).toHaveLength(1); // 仍是一个遮盖
    expect(result.fixedBoxes).toBe(1);
    const recheck = classifyPage(1, W, H, [f1, f2], result.map[1]);
    expect(recheck.risks).toHaveLength(0);
  });

  it('整批不同页只提交一次（返回全新 map，不就地修改入参）', () => {
    const f = fragmentOf('AAAA', 100);
    const cover = box('c', 90, 690, 105, 720);
    const base: { 1: RedactionBox[] } = { 1: [cover] };
    const risks1 = classifyPage(1, W, H, [f], [cover]).risks;
    const risks3 = classifyPage(3, W, H, [{ ...f, page: 3, index: 0 }], [
      box('c3', 90, 690, 105, 720),
    ]).risks;
    const result = applyLeakFixes(
      { ...base, 3: [box('c3', 90, 690, 105, 720)] },
      [...risks1, ...risks3],
      [
        { width: W, height: H },
        { width: W, height: H },
        { width: W, height: H },
      ],
    );
    expect(result.fixedPages).toEqual([1, 3]);
    expect(result.fixedBoxes).toBe(2);
    // 入参未被修改
    expect(base[1][0]).toEqual(cover);
  });

  it('关联遮盖已被删除时计入 missingBoxRisks 且不产生改动', () => {
    const f = fragmentOf('AAAA', 100);
    const risks = classifyPage(1, W, H, [f], [box('gone', 90, 690, 105, 720)]).risks;
    const result = applyLeakFixes({}, risks, [{ width: W, height: H }]);
    expect(result.fixedBoxes).toBe(0);
    expect(result.missingBoxRisks).toBe(1);
    expect(result.map).toEqual({});
  });
});

describe('遮盖变化后重新核对 rebuildReport', () => {
  it('扩展遮盖后风险消失，无文字页仍保留在未检查列表', () => {
    const f = fragmentOf('AAAA', 100);
    const partial = box('cover', 90, 690, 105, 720);
    const pt = buildPageText(1, { items: [ti('AAAA', 100)] });
    const cache = new Map([[1, pt]]);
    const prev: LeakReport = {
      pages: [classifyPage(1, W, H, [f], [partial])],
      unchecked: [{ page: 2, reason: 'no-text' }],
      redactions: { 1: [partial] },
      incomplete: false,
    };
    expect(countRisks(prev)).toBe(1);

    const fixed = applyLeakFixes({ 1: [partial] }, prev.pages[0].risks, [
      { width: W, height: H },
    ]).map;
    const next = rebuildReport(prev, cache, fixed);
    expect(countRisks(next)).toBe(0);
    expect(next.unchecked.map((u) => u.page)).toEqual([2]);
    expect(next.redactions).toBe(fixed);
  });
});

describe('全文扫描 scanLeakReport', () => {
  it('无文字页明确列为未检查（no-text），不得当作安全通过', async () => {
    const fakePdf = {
      numPages: 2,
      getPage: async (n: number) => ({
        getViewport: () => ({ width: W, height: H }),
        getTextContent: async () =>
          n === 1 ? { items: [ti('保密内容', 100)] } : { items: [ti('   ', 100)] },
      }),
    } as unknown as PDFDocumentProxy;

    const { report, cancelled } = await scanLeakReport(
      fakePdf,
      new Map(),
      { 1: [box('c', 95, 690, 115, 720)] },
    );
    expect(cancelled).toBe(false);
    expect(report.pages.map((p) => p.page)).toEqual([1]);
    expect(report.pages[0].risks.length).toBeGreaterThan(0); // 字没被完整包住
    expect(report.unchecked).toEqual([{ page: 2, reason: 'no-text' }]);
  });

  it('取消扫描：未到达页标记为 cancelled，已扫描结果保留', async () => {
    const fakePdf = {
      numPages: 3,
      getPage: async (n: number) => ({
        getViewport: () => ({ width: W, height: H }),
        getTextContent: async () => ({ items: [ti(`第${n}页文字`, 100)] }),
      }),
    } as unknown as PDFDocumentProxy;

    const calls: number[] = [];
    const { report, cancelled } = await scanLeakReport(fakePdf, new Map(), {}, {
      onProgress: (done) => calls.push(done),
      shouldCancel: () => calls.length >= 1,
    });
    expect(cancelled).toBe(true);
    expect(report.incomplete).toBe(true);
    expect(report.pages.map((p) => p.page)).toEqual([1]);
    expect(report.unchecked.map((u) => u.page)).toEqual([2, 3]);
    expect(report.unchecked.every((u) => u.reason === 'cancelled')).toBe(true);
  });

  it('文字提取失败的页面标记为 error，扫描继续完成其余页', async () => {
    const fakePdf = {
      numPages: 2,
      getPage: async (n: number) => ({
        getViewport: () => ({ width: W, height: H }),
        getTextContent: async () => {
          if (n === 1) throw new Error('boom');
          return { items: [ti('正常', 100)] };
        },
      }),
    } as unknown as PDFDocumentProxy;

    const { report, failed } = await scanLeakReport(fakePdf, new Map(), {});
    expect(failed).toBe(true);
    expect(report.unchecked).toContainEqual({ page: 1, reason: 'error' });
    expect(report.pages.map((p) => p.page)).toEqual([2]);
  });
});
