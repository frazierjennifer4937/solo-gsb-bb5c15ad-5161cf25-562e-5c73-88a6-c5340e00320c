import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { RedactionBox, RedactionMap } from '../types';
import type { RectCoords } from './scheme';
import {
  buildPageText,
  itemRect,
  type PageText,
  type TextContent,
} from './textSearch';

/**
 * 边缘泄漏检查（导出前安全核对，纯本地）：
 *
 * 以 pdf.js 文本项为“文本片段”粒度，逐页取每个含字片段在未旋转 PDF 页面坐标
 * 下的包围盒（与文本查找命中同一几何模型），再与该页现有遮盖比对：
 *
 * - 与所有遮盖都不相交的片段：正常（文字本就不打算遮住），不报告；
 * - 与至少一个遮盖相交、且已被遮盖（并集）完整包住的片段：安全，不报告；
 * - 与遮盖相交、但仍有部分露在遮盖外的片段：列为「边缘泄漏风险」。
 *
 * 风险按页展示；点击结果可跳页并高亮“关联遮盖 + 外露部分”。
 * 勾选风险后可批量把关联遮盖扩展到完整包住片段（同一遮盖关联多项时取并集），
 * 整批只产生一条撤销记录。
 *
 * 没有可提取文字的页面（如纯扫描件 / 图片页）无法核对，明确列为「未检查」，
 * 绝不视为安全通过。
 */

/** 判定“已被完整包住”时允许的坐标容差（点）：小于 0.02 cm，兜住取整 / 渲染误差 */
export const CONTAIN_TOLERANCE = 0.5;
/** 批量扩展遮盖时在片段包围盒外预留的余量（点），避免衬线 / 抗锯齿边缘擦边露出 */
export const EXPAND_MARGIN = 1;
/** 外露部分按条带拆分后，宽或高小于该值（点）的碎片视为空，不展示 */
const MIN_PIECE_SIZE = 0.25;

/** 一个待核对的文本片段（对应一个含字的 pdf.js 文本项） */
export interface TextFragment {
  page: number;
  /** 在该页含字文本项中的序号（稳定标识用） */
  index: number;
  /** 片段文字（首尾空白已修剪） */
  text: string;
  rect: RectCoords;
}

/** 一条边缘泄漏风险：片段与遮盖相交但未被完整包住 */
export interface LeakRisk {
  page: number;
  /** 稳定 id：同一份文本提取结果下不随遮盖变化，批量处理 / 重扫后可据此保留勾选 */
  id: string;
  text: string;
  /** 片段在页面上的完整包围盒 */
  rect: RectCoords;
  /** 外露（未被任一遮盖覆盖）的部分，轴对齐矩形列表；非空才会成为风险 */
  exposed: RectCoords[];
  /**
   * 建议扩展的关联遮盖：与片段相交面积最大的那个遮盖。
   * 若遮盖在扫描后被删除则为 null（面板会要求重新检查）。
   */
  boxId: string | null;
  /** 与片段相交的全部遮盖（画布高亮用） */
  relatedBoxIds: string[];
}

export interface LeakPageReport {
  page: number;
  width: number;
  height: number;
  risks: LeakRisk[];
  /** 本页参与核对的文本片段数量（仅统计含字、非退化片段） */
  fragmentCount: number;
}

export type UncheckedReason = 'no-text' | 'cancelled' | 'error';

export interface UncheckedPage {
  page: number;
  /** no-text 无可提取文字；cancelled 扫描被取消未到达；error 文字提取失败 */
  reason: UncheckedReason;
}

export interface LeakReport {
  pages: LeakPageReport[];
  unchecked: UncheckedPage[];
  /** 生成报告时遮盖集合的快照（用于检测报告是否过期） */
  redactions: RedactionMap;
  /** 扫描是否在到达末页前被取消 / 出错 */
  incomplete: boolean;
}

interface ScanCallbacks {
  onProgress?(done: number, total: number): void;
  shouldCancel?(): boolean;
}

/* ------------------------------ 几何判定 ------------------------------ */

export interface RectLike {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const intersectRect = (a: RectLike, b: RectLike): RectCoords | null => {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
};

/** 相交面积（点²）；不相交返回 0 */
export function intersectionArea(a: RectLike, b: RectLike): number {
  const r = intersectRect(a, b);
  return r ? (r.x2 - r.x1) * (r.y2 - r.y1) : 0;
}

/** 矩形 outer 是否完整包住 inner（各边允许 tol 点容差） */
export function rectContains(inner: RectLike, outer: RectLike, tol = CONTAIN_TOLERANCE): boolean {
  return (
    outer.x1 <= inner.x1 + tol &&
    outer.y1 <= inner.y1 + tol &&
    outer.x2 >= inner.x2 - tol &&
    outer.y2 >= inner.y2 - tol
  );
}

/**
 * 从矩形 rect 中减去一组覆盖矩形，返回剩余部分的轴对齐矩形列表（横纵条带切分）。
 * 用于计算片段“外露部分”：先减去一个遮盖，再用其输出条带继续减去其余遮盖。
 */
export function rectSubtractAll(rect: RectLike, covers: RectLike[]): RectCoords[] {
  let pieces: RectCoords[] = [{ ...rect }];
  for (const cover of covers) {
    const next: RectCoords[] = [];
    for (const piece of pieces) {
      const hit = intersectRect(piece, cover);
      if (!hit) {
        next.push(piece);
        continue;
      }
      // 按相交矩形的四条边把本块切成：左 / 右 / 中上部 / 中下部 四条
      if (hit.x1 > piece.x1) {
        next.push({ x1: piece.x1, y1: piece.y1, x2: hit.x1, y2: piece.y2 });
      }
      if (hit.x2 < piece.x2) {
        next.push({ x1: hit.x2, y1: piece.y1, x2: piece.x2, y2: piece.y2 });
      }
      if (hit.y1 > piece.y1) {
        next.push({ x1: hit.x1, y1: piece.y1, x2: hit.x2, y2: hit.y1 });
      }
      if (hit.y2 < piece.y2) {
        next.push({ x1: hit.x1, y1: hit.y2, x2: hit.x2, y2: piece.y2 });
      }
    }
    pieces = next.filter((p) => p.x2 - p.x1 >= MIN_PIECE_SIZE && p.y2 - p.y1 >= MIN_PIECE_SIZE);
    if (pieces.length === 0) break;
  }
  return pieces;
}

const unionRect = (a: RectLike, b: RectLike): RectCoords => ({
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
  x2: Math.max(a.x2, b.x2),
  y2: Math.max(a.y2, b.y2),
});

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/** 外扩 margin 点并夹取到页面范围内 */
function expandWithMargin(
  rect: RectLike,
  pageWidth: number,
  pageHeight: number,
): RectCoords {
  return {
    x1: clamp(rect.x1 - EXPAND_MARGIN, 0, pageWidth),
    y1: clamp(rect.y1 - EXPAND_MARGIN, 0, pageHeight),
    x2: clamp(rect.x2 + EXPAND_MARGIN, 0, pageWidth),
    y2: clamp(rect.y2 + EXPAND_MARGIN, 0, pageHeight),
  };
}

/* ------------------------------ 片段提取 ------------------------------ */

/** 从一页已解析文本中提取全部含字、非退化片段（pdf.js 文本项粒度） */
export function extractFragments(
  page: number,
  pt: PageText,
  pageWidth: number,
  pageHeight: number,
): TextFragment[] {
  const out: TextFragment[] = [];
  let index = 0;
  for (const item of pt.items) {
    if (![...item.str].some((ch) => !/\s/.test(ch))) continue;
    const rect = itemRect(item, pageWidth, pageHeight);
    if (rect.x2 - rect.x1 < MIN_PIECE_SIZE || rect.y2 - rect.y1 < MIN_PIECE_SIZE) continue;
    out.push({ page, index, text: item.str.trim(), rect });
    index += 1;
  }
  return out;
}

/* ------------------------------ 单页核对 ------------------------------ */

/**
 * 用给定遮盖集合核对一页的全部文本片段：
 * 与遮盖相交但未被遮盖并集完整包住（仍有外露）的片段列为风险。纯函数。
 */
export function classifyPage(
  page: number,
  width: number,
  height: number,
  fragments: TextFragment[],
  boxes: RedactionBox[],
): LeakPageReport {
  const risks: LeakRisk[] = [];
  for (const f of fragments) {
    // 与片段相交的遮盖（按相交面积降序）
    const hits = boxes
      .map((b) => ({ box: b, area: intersectionArea(f.rect, b) }))
      .filter((h) => h.area > 0)
      .sort((a, b) => b.area - a.area);
    if (hits.length === 0) continue; // 与遮盖无关的文字：不在检查范围

    // 已被任一遮盖完整包住：安全
    if (hits.some((h) => rectContains(f.rect, h.box))) continue;

    // 单个遮盖包不住时，再看多个遮盖的并集是否恰好拼合包住
    const exposed = rectSubtractAll(
      f.rect,
      hits.map((h) => h.box),
    );
    if (exposed.length === 0) continue;

    risks.push({
      page,
      id: `leak-${page}-${f.index}`,
      text: f.text,
      rect: { ...f.rect },
      exposed,
      boxId: hits[0].box.id,
      relatedBoxIds: hits.map((h) => h.box.id),
    });
  }
  return { page, width, height, risks, fragmentCount: fragments.length };
}

/** 依据缓存的文本解析结果与遮盖集合生成单页报告 */
export function reportFromPageText(
  page: number,
  width: number,
  height: number,
  pt: PageText,
  boxes: RedactionBox[],
): LeakPageReport {
  return classifyPage(page, width, height, extractFragments(page, pt, width, height), boxes);
}

/* ------------------------------ 全文扫描 ------------------------------ */

/**
 * 逐页提取文本并做边缘泄漏核对。复用调用方的 PageText 缓存
 * （与文本查找面板共享），每页之间让出事件循环以更新进度并响应取消。
 */
export async function scanLeakReport(
  pdf: PDFDocumentProxy,
  cache: Map<number, PageText>,
  redactions: RedactionMap,
  cb: ScanCallbacks = {},
): Promise<{ report: Omit<LeakReport, 'redactions'>; cancelled: boolean; failed: boolean }> {
  const pages: LeakPageReport[] = [];
  const unchecked: UncheckedPage[] = [];
  const total = pdf.numPages;
  let cancelled = false;
  let failed = false;

  for (let n = 1; n <= total; n += 1) {
    if (cb.shouldCancel?.()) {
      cancelled = true;
      for (let p = n; p <= total; p += 1) unchecked.push({ page: p, reason: 'cancelled' });
      break;
    }

    const proxy: PDFPageProxy = await pdf.getPage(n);
    // 与遮盖框同一坐标系：未旋转页面尺寸（pageSizes 也是 rotation: 0 收集的）。
    // 不指定 rotation 时 pdf.js 会带上页面自身旋转，横版页可能给出交换后的宽高，
    // 这里显式归零以保证两侧一致。
    const base = proxy.getViewport({ scale: 1, rotation: 0 });

    let pt = cache.get(n);
    if (!pt) {
      try {
        const content: TextContent = await proxy.getTextContent();
        pt = buildPageText(n, content);
        cache.set(n, pt);
      } catch {
        failed = true;
        unchecked.push({ page: n, reason: 'error' });
        cb.onProgress?.(n, total);
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
    }

    if (pt.textItemCount === 0) {
      // 没有可提取文字的页面无法核对：明确列为未检查，不得当作安全通过
      unchecked.push({ page: n, reason: 'no-text' });
    } else {
      pages.push(reportFromPageText(n, base.width, base.height, pt, redactions[n] ?? []));
    }

    cb.onProgress?.(n, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    report: { pages, unchecked, incomplete: cancelled || failed },
    cancelled,
    failed,
  };
}

/* ------------------------------ 批量扩展遮盖 ------------------------------ */

export interface LeakFixResult {
  map: RedactionMap;
  /** 实际被扩展（坐标发生变化）的遮盖数量 */
  fixedBoxes: number;
  /** 已被处理的风险数量（关联遮盖存在） */
  fixedRisks: number;
  /** 关联遮盖已不存在、无法处理的风险数量 */
  missingBoxRisks: number;
  /** 各扩展遮盖所在页（升序去重，提示用） */
  fixedPages: number[];
}

/**
 * 把勾选风险的关联遮盖一次性扩展到完整包住片段：
 * - 以（页, 遮盖 id）分组，同一遮盖关联多项时取“各片段外扩后的包围盒”
 *   与遮盖自身的并集，一次扩到位；
 * - 返回全新 RedactionMap（不就地修改入参），调用方只需一次 set 提交，
 *   因此整批修改只产生一条撤销记录。
 */
export function applyLeakFixes(
  base: RedactionMap,
  risks: LeakRisk[],
  pageSizes: ReadonlyArray<{ width: number; height: number }>,
): LeakFixResult {
  const map: RedactionMap = {};
  for (const key of Object.keys(base)) {
    map[Number(key)] = (base[Number(key)] ?? []).map((b) => ({ ...b }));
  }

  // (page, boxId) -> 需要包住的全部风险
  const groups = new Map<string, { page: number; boxId: string; items: LeakRisk[] }>();
  let missingBoxRisks = 0;
  for (const risk of risks) {
    if (!risk.boxId) {
      missingBoxRisks += 1;
      continue;
    }
    const key = `${risk.page}:${risk.boxId}`;
    let g = groups.get(key);
    if (!g) {
      g = { page: risk.page, boxId: risk.boxId, items: [] };
      groups.set(key, g);
    }
    g.items.push(risk);
  }

  let fixedBoxes = 0;
  const fixedPageSet = new Set<number>();

  for (const g of groups.values()) {
    const boxes = map[g.page] ?? [];
    const target = boxes.find((b) => b.id === g.boxId);
    if (!target) {
      missingBoxRisks += g.items.length;
      continue;
    }
    const size = pageSizes[g.page - 1] ?? { width: Infinity, height: Infinity };
    let bounds: RectCoords = { x1: target.x1, y1: target.y1, x2: target.x2, y2: target.y2 };
    for (const risk of g.items) {
      bounds = unionRect(bounds, expandWithMargin(risk.rect, size.width, size.height));
    }
    const next: RedactionBox = { id: target.id, ...bounds };
    const changed =
      next.x1 !== target.x1 ||
      next.y1 !== target.y1 ||
      next.x2 !== target.x2 ||
      next.y2 !== target.y2;
    if (changed) {
      map[g.page] = boxes.map((b) => (b.id === target.id ? next : b));
      fixedBoxes += 1;
      fixedPageSet.add(g.page);
    }
  }

  return {
    map,
    fixedBoxes,
    fixedRisks: risks.length - missingBoxRisks,
    missingBoxRisks,
    fixedPages: [...fixedPageSet].sort((a, b) => a - b),
  };
}

/* ------------------------------ 重新核对（遮盖变化后） ------------------------------ */

/**
 * 遮盖集合发生变化后，依据文本缓存对已扫描页面重新做纯计算核对，
 * 使面板 / 画布结果始终与当前遮盖一致（批量扩展、手工增删后调用）。
 * 未检查页（无文字 / 取消 / 出错）原样保留；已扫描页缺少缓存时降级为 error。
 */
export function rebuildReport(
  prev: LeakReport,
  cache: Map<number, PageText>,
  nextRedactions: RedactionMap,
): LeakReport {
  const pages: LeakPageReport[] = [];
  const extraUnchecked: UncheckedPage[] = [];

  for (const p of prev.pages) {
    const pt = cache.get(p.page);
    if (!pt) {
      extraUnchecked.push({ page: p.page, reason: 'error' });
      continue;
    }
    pages.push(reportFromPageText(p.page, p.width, p.height, pt, nextRedactions[p.page] ?? []));
  }

  return {
    pages: pages.sort((a, b) => a.page - b.page),
    unchecked: [...prev.unchecked, ...extraUnchecked].sort((a, b) => a.page - b.page),
    redactions: nextRedactions,
    incomplete: prev.incomplete,
  };
}

/** 全部已核对页面的风险总数 */
export function countRisks(report: LeakReport): number {
  return report.pages.reduce((sum, p) => sum + p.risks.length, 0);
}
