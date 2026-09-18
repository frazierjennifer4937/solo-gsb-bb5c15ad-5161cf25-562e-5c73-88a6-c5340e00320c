import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RedactionBox, RedactionMap } from '../types';
import {
  checkPageGeometry,
  exposedParts,
  extendBoxesForRisks,
  rebuildReport,
  rectContains,
  scanEdgeLeaks,
  summarize,
  type FragmentCandidate,
} from './edgeLeak';
import { type TextContent, type TextItem, buildPageText } from './textSearch';

const box = (id: string, x1: number, y1: number, x2: number, y2: number): RedactionBox => ({
  id,
  x1,
  y1,
  x2,
  y2,
});

const frag = (text: string, x1: number, y1: number, x2: number, y2: number): FragmentCandidate => ({
  text,
  rect: { x1, y1, x2, y2 },
});

describe('相交 / 包含判定', () => {
  it('片段完全落在遮盖内：不算风险', () => {
    const r = checkPageGeometry(1, [frag('机密', 110, 690, 150, 710)], [box('b1', 100, 680, 200, 720)]);
    expect(r.status).toBe('ok');
    expect(r.risks).toHaveLength(0);
  });

  it('片段与遮盖不相交：正常可见文字，不算风险', () => {
    const r = checkPageGeometry(1, [frag('普通', 300, 690, 340, 710)], [box('b1', 100, 680, 200, 720)]);
    expect(r.status).toBe('ok');
  });

  it('片段与遮盖相交但未被完整包含：报告风险，记录关联遮盖与外露区', () => {
    // 遮盖只压住片段左半
    const r = checkPageGeometry(1, [frag('机密文件', 100, 690, 200, 710)], [box('b1', 100, 690, 150, 710)]);
    expect(r.status).toBe('risk');
    expect(r.risks).toHaveLength(1);
    const risk = r.risks[0];
    expect(risk.overlaps.map((o) => o.boxId)).toEqual(['b1']);
    expect(risk.exposed).toHaveLength(1);
    expect(risk.exposed[0].x1).toBeCloseTo(150, 6);
    expect(risk.exposed[0].x2).toBeCloseTo(200, 6);
  });

  it('两个遮盖并集完整包住片段时不算风险（单个均不完整）', () => {
    const fragments = [frag('机密文件', 100, 690, 200, 710)];
    const boxes = [box('b1', 100, 690, 150, 710), box('b2', 150, 690, 200, 710)];
    expect(checkPageGeometry(1, fragments, boxes).status).toBe('ok');
  });

  it('上下两个遮盖夹住片段、中间留缝：外露为中间横条', () => {
    const r = checkPageGeometry(
      1,
      [frag('X', 100, 680, 200, 720)],
      [box('b1', 100, 700, 200, 720), box('b2', 100, 680, 200, 695)],
    );
    expect(r.status).toBe('risk');
    const exposed = r.risks[0].exposed;
    expect(exposed).toHaveLength(1);
    expect(exposed[0].y1).toBeCloseTo(695, 6);
    expect(exposed[0].y2).toBeCloseTo(700, 6);
  });

  it('遮盖只覆盖片段中部：外露为左右两块', () => {
    const r = checkPageGeometry(
      1,
      [frag('ABCDE', 100, 690, 200, 710)],
      [box('b1', 140, 690, 160, 710)],
    );
    const exposed = r.risks[0].exposed;
    expect(exposed).toHaveLength(2);
    expect(exposed.map((e) => [e.x1, e.x2])).toEqual([
      [100, 140],
      [160, 200],
    ]);
  });

  it('没有任何片段的页面状态为 unchecked，不能当作通过', () => {
    const r = checkPageGeometry(3, [], [box('b1', 0, 0, 10, 10)]);
    expect(r.status).toBe('unchecked');
    const summary = summarize([r]);
    expect(summary.uncheckedPages).toEqual([3]);
    expect(summary.riskPages).toEqual([]);
    expect(summary.totalRisks).toBe(0);
  });
});

describe('exposedParts 原语', () => {
  it('无遮盖覆盖时外露为主体自身', () => {
    expect(exposedParts({ x1: 0, y1: 0, x2: 10, y2: 10 }, [])).toEqual([
      { x1: 0, y1: 0, x2: 10, y2: 10 },
    ]);
  });

  it('完整包含时外露为空', () => {
    expect(
      exposedParts({ x1: 2, y1: 2, x2: 8, y2: 8 }, [{ x1: 0, y1: 0, x2: 10, y2: 10 }]),
    ).toEqual([]);
  });

  it('rectContains 边界 0.01 容差内视为包含', () => {
    expect(rectContains({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0.005, y1: 0, x2: 10, y2: 10 })).toBe(true);
    expect(rectContains({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10.02, y2: 10 })).toBe(false);
  });
});

describe('批量扩展遮盖', () => {
  it('同一遮盖关联多项风险时取并集，一次扩展包住全部片段', () => {
    const base: Record<number, RedactionBox[]> = {
      1: [box('b1', 100, 690, 150, 710)],
    };
    const page = checkPageGeometry(
      1,
      [frag('AAAA', 100, 690, 200, 710), frag('BBBB', 120, 650, 140, 700)],
      base[1],
    );
    expect(page.risks).toHaveLength(2);

    const result = extendBoxesForRisks(base, page.risks);
    expect(result.changedBoxIds).toEqual(['b1']);
    const grown = result.map[1][0];
    expect(grown.id).toBe('b1'); // 原遮盖被扩展，而不是新增框
    expect([grown.x1, grown.y1, grown.x2, grown.y2]).toEqual([100, 650, 200, 710]);
    expect(result.fixedRiskCount).toBe(2);
    expect(result.skippedRiskCount).toBe(0);

    // 扩展后重新计算：两个片段都被完整包住，风险消失
    const after = checkPageGeometry(1, [frag('AAAA', 100, 690, 200, 710), frag('BBBB', 120, 650, 140, 700)], [grown]);
    expect(after.status).toBe('ok');
  });

  it('两个风险分别关联不同遮盖时，两个遮盖各自扩展', () => {
    const base: Record<number, RedactionBox[]> = {
      1: [box('b1', 100, 690, 150, 710), box('b2', 300, 690, 350, 710)],
    };
    const page = checkPageGeometry(
      1,
      [frag('AAAA', 100, 690, 200, 710), frag('BBBB', 300, 690, 400, 710)],
      base[1],
    );
    const result = extendBoxesForRisks(base, page.risks);
    expect(result.changedBoxIds.sort()).toEqual(['b1', 'b2']);
    expect(result.map[1][0].x2).toBe(200);
    expect(result.map[1][1].x2).toBe(400);
  });

  it('关联遮盖已被删除时跳过该风险且不改动其他页', () => {
    const base: Record<number, RedactionBox[]> = { 1: [box('b1', 100, 690, 150, 710)] };
    const page = checkPageGeometry(1, [frag('AAAA', 100, 690, 200, 710)], base[1]);
    const stale = page.risks[0];
    const result = extendBoxesForRisks({}, [stale]);
    expect(result.changedBoxIds).toEqual([]);
    expect(result.skippedRiskCount).toBe(1);
    expect(result.fixedRiskCount).toBe(0);
  });

  it('扩展量在 0.01 容差内时不产生修改', () => {
    const base: Record<number, RedactionBox[]> = { 1: [box('b1', 100, 690, 200.005, 710)] };
    const page = checkPageGeometry(1, [frag('A', 100, 690, 200, 710)], base[1]);
    // 片段已在容差内被包住，几何上不会产出风险
    expect(page.risks).toHaveLength(0);
  });
});

describe('文档扫描（仿 pdf.js 页面）', () => {
  const PAGE_W = 612;
  const PAGE_H = 792;
  const F = 12;
  const ti = (str: string, x = 100, y = 700): TextItem => ({
    str,
    transform: [F, 0, 0, F, x, y],
    width: [...str].length * F,
    height: F,
    hasEOL: false,
  });

  function fakePdf(pages: TextContent[]) {
    return {
      numPages: pages.length,
      getPage: async (n: number) => ({
        getViewport: () => ({ width: PAGE_W, height: PAGE_H }),
        getTextContent: async () => pages[n - 1],
      }),
    } as unknown as PDFDocumentProxy;
  }

  it('有风险页 / 无文字未检查页 / 干净页分别归类，未检查页不计入通过', async () => {
    // 第 1 页：文字片段被遮盖压住左半 => 风险
    // 第 2 页：无文字 => 未检查
    // 第 3 页：有文字无遮盖 => ok
    const pdf = fakePdf([
      { items: [ti('机密文件')] },
      { items: [ti('   ')] },
      { items: [ti('普通文字')] },
    ]);
    const redactions: Record<number, RedactionBox[]> = {
      1: [box('b1', 99, 695, 120, 713)],
    };
    const cache = new Map();
    const { report, cancelled, scannedPages } = await scanEdgeLeaks(pdf, redactions, cache);
    expect(cancelled).toBe(false);
    expect(scannedPages).toBe(3);
    expect(report.pages.map((p) => p.status)).toEqual(['risk', 'unchecked', 'ok']);
    expect(report.uncheckedPages).toEqual([2]);
    expect(report.riskPages).toEqual([1]);
    expect(report.totalRisks).toBe(1);
    // 风险片段文本被带入摘要
    expect(report.pages[0].risks[0].text).toBe('机密文件');
  });

  it('shouldCancel 生效时只返回已扫描页并标记取消', async () => {
    const pdf = fakePdf([{ items: [ti('一')] }, { items: [ti('二')] }]);
    const cache = new Map();
    const { report, cancelled, scannedPages } = await scanEdgeLeaks(pdf, {}, cache, {
      shouldCancel: () => true,
    });
    expect(cancelled).toBe(true);
    expect(scannedPages).toBe(0);
    expect(report.pages).toHaveLength(0);
  });

  it('rebuildReport：遮盖扩展后用缓存文本重算，风险页变为 ok', () => {
    const cache = new Map([[1, buildPageText(1, { items: [ti('机密文件')] })]]);
    // 第一次：半遮盖 => 风险
    const base: RedactionMap = { 1: [box('b1', 99, 695, 120, 713)] };
    const before = rebuildReport([1], base, cache, [{ width: PAGE_W, height: PAGE_H }]);
    expect(before.pages[0].status).toBe('risk');

    // 批量扩展后重算 => ok
    const { map } = extendBoxesForRisks(base, before.pages[0].risks);
    const after = rebuildReport([1], map, cache, [{ width: PAGE_W, height: PAGE_H }]);
    expect(after.pages[0].status).toBe('ok');
    expect(after.totalRisks).toBe(0);
  });
});
