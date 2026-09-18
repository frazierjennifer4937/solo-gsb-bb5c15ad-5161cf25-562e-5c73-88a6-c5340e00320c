import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { RedactionBox, RedactionMap } from '../types';
import type { RectCoords } from './scheme';
import { sameRectWithinTolerance } from './scheme';
import {
  buildPageText,
  itemFullRect,
  type PageText,
  type TextContent,
} from './textSearch';

/**
 * 边缘泄漏检查（导出前）：
 * 用 pdf.js 逐页提取文本片段（非空白 text item），取每个片段在“未旋转 PDF
 * 页面坐标”下的包围盒，与该页已有遮盖逐一比较：
 *   - 与遮盖相交（面积 > 容差）但未被任一遮盖完整包含的片段 => 泄漏风险；
 *   - 完全落在某遮盖内的片段视为已被遮住，不报告；
 *   - 与遮盖完全不相交的片段属于正常可见文字，不报告。
 * 没有任何可提取文字的页面（扫描件 / 图片页）单独标记为“未检查”，
 * 绝不能当作安全通过——文字提取层缺失时无法判断遮盖边缘外是否压着文字。
 *
 * 全部为纯本地计算；几何判定均为纯函数，便于回归测试。
 */

/** 相交 / 包含判定的容差（点），与方案合并一致 */
const EPS = 0.01;

export type LeakPageStatus = 'unchecked' | 'ok' | 'risk';

/** 与片段相交的遮盖及外露（片段减去遮盖并集）多边形 */
export interface LeakOverlap {
  /** 关联遮盖 id */
  boxId: string;
  /** 关联遮盖坐标（副本） */
  box: RectCoords;
}

export interface LeakRisk {
  /** 风险项稳定 id：由页码 + 片段坐标决定，遮盖被手工增删改后重新计算仍保持不变 */
  id: string;
  page: number;
  /** 片段原文（pdf.js text item 字符串） */
  text: string;
  /** 片段包围盒（PDF 页面坐标，点） */
  rect: RectCoords;
  /** 所有与该片段相交的遮盖（用于高亮“对应遮盖”） */
  overlaps: LeakOverlap[];
  /** 外露部分：片段包围盒减去遮盖并集后的矩形分区（轴对齐矩形） */
  exposed: RectCoords[];
}

export interface LeakPageResult {
  page: number;
  /**
   * - unchecked：没有任何可提取文字，无法判定（不得视为安全）；
   * - ok：有文字且无风险（含该页根本没有遮盖的情况——没有相交即无风险）；
   * - risk：存在一条或多条泄漏风险。
   */
  status: LeakPageStatus;
  risks: LeakRisk[];
}

export interface LeakReport {
  /** 按页码升序的逐页结果（未检查页也在其中） */
  pages: LeakPageResult[];
  totalRisks: number;
  uncheckedPages: number[];
  riskPages: number[];
}

/* ------------------------------ 矩形几何 ------------------------------ */

const intersect = (a: RectCoords, b: RectCoords): RectCoords | null => {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 - x1 <= EPS || y2 - y1 <= EPS) return null;
  return { x1, y1, x2, y2 };
};

/** b 是否完整包含 a（边界允许 EPS 容差） */
export function rectContains(outer: RectCoords, inner: RectCoords): boolean {
  return (
    outer.x1 <= inner.x1 + EPS &&
    outer.y1 <= inner.y1 + EPS &&
    outer.x2 >= inner.x2 - EPS &&
    outer.y2 >= inner.y2 - EPS
  );
}

interface Segment {
  lo: number;
  hi: number;
}

const mergeSegments = (segments: Segment[]): Segment[] => {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.lo - b.lo);
  const out: Segment[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    if (sorted[i].lo <= last.hi + EPS) {
      last.hi = Math.max(last.hi, sorted[i].hi);
    } else {
      out.push({ ...sorted[i] });
    }
  }
  return out;
};

/**
 * 计算 subject 被 covers 覆盖后剩下的外露区域（轴对齐矩形分区）。
 * 用 covers 在 subject 内部的竖向投影切条带，再在每条带内按横向投影扣除：
 * 条带未被横向覆盖的段即为外露矩形。返回空数组表示已被完整覆盖。
 */
export function exposedParts(subject: RectCoords, covers: RectCoords[]): RectCoords[] {
  const clips = covers
    .map((c) => intersect(subject, c))
    .filter((c): c is RectCoords => c !== null);
  if (clips.length === 0) return [{ ...subject }];

  // 竖向条带边界：subject 两端 + 各遮盖在 subject 内的上下边
  const cuts = [subject.y1, subject.y2];
  for (const c of clips) cuts.push(c.y1, c.y2);
  cuts.sort((a, b) => a - b);

  const out: RectCoords[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const lo = cuts[i];
    const hi = cuts[i + 1];
    if (hi - lo <= EPS) continue;
    // 与该条带有完整竖向重叠的遮盖，在条带内取其横向投影
    const xCover: Segment[] = [];
    for (const c of clips) {
      if (c.y1 <= lo + EPS && c.y2 >= hi - EPS) {
        xCover.push({ lo: Math.max(c.x1, subject.x1), hi: Math.min(c.x2, subject.x2) });
      }
    }
    const covered = mergeSegments(xCover);
    let cursor = subject.x1;
    for (const seg of covered) {
      if (seg.lo > cursor + EPS) out.push({ x1: cursor, y1: lo, x2: seg.lo, y2: hi });
      cursor = Math.max(cursor, seg.hi);
    }
    if (cursor < subject.x2 - EPS) {
      out.push({ x1: cursor, y1: lo, x2: subject.x2, y2: hi });
    }
  }
  return out.filter((r) => r.x2 - r.x1 > EPS && r.y2 - r.y1 > EPS);
}

/* ------------------------------ 单页判定 ------------------------------ */

/** 片段候选：非空白 text item 的原文与整串包围盒 */
export interface FragmentCandidate {
  text: string;
  rect: RectCoords;
}

/** 从已构建的页面文本中提取全部非空白片段（跳过纯空白 item） */
export function pageFragments(
  pt: PageText,
  pageWidth: number,
  pageHeight: number,
): FragmentCandidate[] {
  const out: FragmentCandidate[] = [];
  for (const item of pt.items) {
    if (item.str.trim() === '') continue;
    out.push({ text: item.str, rect: itemFullRect(item, pageWidth, pageHeight) });
  }
  return out;
}

/**
 * 纯几何单页检查：每个片段若与任一遮盖相交且未被遮盖并集完整包含，记为风险。
 * boxIdFor 为遮盖列表与 id 的配对来源，便于测试直接构造。
 */
export function checkPageGeometry(
  page: number,
  fragments: FragmentCandidate[],
  boxes: Array<RedactionBox>,
): LeakPageResult {
  if (fragments.length === 0) {
    return { page, status: 'unchecked', risks: [] };
  }

  const risks: LeakRisk[] = [];
  const idSeen = new Set<string>();
  for (const frag of fragments) {
    const overlaps: LeakOverlap[] = [];
    const hitBoxes: RectCoords[] = [];
    for (const b of boxes) {
      if (intersect(frag.rect, b)) {
        overlaps.push({ boxId: b.id, box: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 } });
        hitBoxes.push(b);
      }
    }
    if (overlaps.length === 0) continue; // 与遮盖不相交：正常可见文字
    // 单个遮盖完整包住片段时不算泄漏（快速路径，结果与并集扣除一致）
    if (hitBoxes.some((b) => rectContains(b, frag.rect))) continue;

    const exposed = exposedParts(frag.rect, hitBoxes);
    if (exposed.length === 0) continue; // 多遮盖并集已完整覆盖

    // 稳定 id：页码 + 片段包围盒坐标；同页完全重叠的片段附加出现序号
    let id = `leak:${page}:${frag.rect.x1.toFixed(2)},${frag.rect.y1.toFixed(2)},${frag.rect.x2.toFixed(2)},${frag.rect.y2.toFixed(2)}`;
    if (idSeen.has(id)) {
      let n = 2;
      while (idSeen.has(`${id}#${n}`)) n += 1;
      id = `${id}#${n}`;
    }
    idSeen.add(id);

    risks.push({
      id,
      page,
      text: frag.text,
      rect: { ...frag.rect },
      overlaps,
      exposed,
    });
  }

  return { page, status: risks.length > 0 ? 'risk' : 'ok', risks };
}

/* ------------------------------ 批量修复（扩展遮盖） ------------------------------ */

export interface LeakFixResult {
  map: RedactionMap;
  /** 实际被扩展的遮盖 id 集合 */
  changedBoxIds: string[];
  /** 被处理（风险消失）的风险项数 */
  fixedRiskCount: number;
  /** 因遮盖已被删除等原因无法关联而跳过的风险项数 */
  skippedRiskCount: number;
}

/**
 * 把勾选风险关联的遮盖扩展为“原遮盖 ∪ 片段包围盒”的最小轴对齐外接矩形：
 * - 同一遮盖被多项风险关联时取并集（一次扩展包住全部关联片段）；
 * - 与现状坐标在 0.01 点容差内相同的扩展视为无变化；
 * - 找不到关联遮盖（风险生成后遮盖被删除）的风险项跳过；
 * - 整批只返回一个新 RedactionMap，由调用方一次 set 提交，只有一条撤销记录。
 */
export function extendBoxesForRisks(
  base: RedactionMap,
  risks: LeakRisk[],
): LeakFixResult {
  const map: RedactionMap = {};
  for (const key of Object.keys(base)) {
    map[Number(key)] = (base[Number(key)] ?? []).map((b) => ({ ...b }));
  }

  // boxId -> 需要并入的片段矩形并集（直接累加到目标遮盖的新边界上）
  const pending = new Map<string, { page: number; rect: RectCoords }>();
  let fixedRiskCount = 0;
  let skippedRiskCount = 0;

  for (const risk of risks) {
    // 优先使用第一个仍存在的关联遮盖
    const target = risk.overlaps.find((o) =>
      (map[risk.page] ?? []).some((b) => b.id === o.boxId),
    );
    if (!target) {
      skippedRiskCount += 1;
      continue;
    }
    const cur = pending.get(target.boxId);
    if (cur) {
      cur.rect = unionRect(cur.rect, risk.rect);
    } else {
      pending.set(target.boxId, { page: risk.page, rect: { ...risk.rect } });
    }
    fixedRiskCount += 1;
  }

  const changedBoxIds: string[] = [];
  for (const [boxId, { page, rect }] of pending) {
    const list = map[page] ?? [];
    const idx = list.findIndex((b) => b.id === boxId);
    if (idx < 0) continue;
    const original = list[idx];
    const grown = unionRect(original, rect);
    if (sameRectWithinTolerance(original, grown)) continue;
    list[idx] = { ...original, ...grown };
    map[page] = list;
    changedBoxIds.push(boxId);
  }

  return { map, changedBoxIds, fixedRiskCount, skippedRiskCount };
}

const unionRect = (a: RectCoords, b: RectCoords): RectCoords => ({
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
  x2: Math.max(a.x2, b.x2),
  y2: Math.max(a.y2, b.y2),
});

/* ------------------------------ 文档扫描 ------------------------------ */

export interface LeakScanCallbacks {
  onProgress?(done: number, total: number): void;
  shouldCancel?(): boolean;
}

/**
 * 逐页提取文本并执行边缘泄漏检查。pageTextCache 与文本查找共用，
 * 已提取过的页面不重复调用 getTextContent；每页之间让出事件循环以更新进度 / 响应取消。
 * 取消时返回已扫描页面的报告，并由 cancelled 标记告知调用方。
 */
export async function scanEdgeLeaks(
  pdf: PDFDocumentProxy,
  redactions: RedactionMap,
  cache: Map<number, PageText>,
  cb: LeakScanCallbacks = {},
): Promise<{ report: LeakReport; scannedPages: number; cancelled: boolean }> {
  const results: LeakPageResult[] = [];
  const total = pdf.numPages;
  let scanned = 0;

  for (let n = 1; n <= total; n += 1) {
    if (cb.shouldCancel?.()) break;

    const proxy: PDFPageProxy = await pdf.getPage(n);
    const base = proxy.getViewport({ scale: 1 });

    let pt = cache.get(n);
    if (!pt) {
      const content: TextContent = await proxy.getTextContent();
      pt = buildPageText(n, content);
      cache.set(n, pt);
    }

    const fragments = pageFragments(pt, base.width, base.height);
    results.push(checkPageGeometry(n, fragments, redactions[n] ?? []));
    scanned = n;

    cb.onProgress?.(n, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const cancelled = scanned < total;
  const report = summarize(results);
  return { report, scannedPages: scanned, cancelled };
}

/** 汇总逐页结果：未检查页明确单列，不计入安全通过 */
export function summarize(pages: LeakPageResult[]): LeakReport {
  const uncheckedPages: number[] = [];
  const riskPages: number[] = [];
  let totalRisks = 0;
  for (const p of pages) {
    if (p.status === 'unchecked') uncheckedPages.push(p.page);
    if (p.status === 'risk') {
      riskPages.push(p.page);
      totalRisks += p.risks.length;
    }
  }
  return { pages, totalRisks, uncheckedPages, riskPages };
}

/**
 * 用已缓存的页面文本，按给定页码范围基于最新遮盖重新计算检查结果
 * （遮盖在扫描进行中被编辑、或扫描结束后被修改时用于即时刷新）。
 * 未缓存文本的页保留占位结果，调用方应保证这些页确实扫描过。
 */
export function rebuildReport(
  pagesToInclude: number[],
  redactions: RedactionMap,
  cache: Map<number, PageText>,
  pageSizes: ReadonlyArray<{ width: number; height: number }>,
): LeakReport {
  const results: LeakPageResult[] = [];
  for (const n of pagesToInclude) {
    const pt = cache.get(n);
    const size = pageSizes[n - 1];
    if (!pt || !size) {
      results.push({ page: n, status: 'unchecked', risks: [] });
      continue;
    }
    const fragments = pageFragments(pt, size.width, size.height);
    results.push(checkPageGeometry(n, fragments, redactions[n] ?? []));
  }
  return summarize(results);
}
