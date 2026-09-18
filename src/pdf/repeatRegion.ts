import type { RedactionBox, RedactionMap } from '../types';
import { sameRectWithinTolerance, type RectCoords } from './scheme';

/**
 * 跨页重复区域：
 * 用户在当前页框选页眉 / 页脚等固定区域，给出页码范围（如 "1-3,5"），
 * 源区域以「占源页宽 / 高的比例」映射到各目标页（适配不同页面尺寸），
 * 映射后越界部分夹取到目标页边界；与目标页已有遮盖在 0.01 点容差内相同的框跳过。
 *
 * 整个计算过程是纯函数：只产出预览结果，不修改任何现有遮盖；
 * 用户确认后由调用方一次性提交（仅一条撤销记录），取消预览则什么都不发生。
 */

export interface RepeatSource {
  /** 框选区域所在页码（从 1 开始） */
  page: number;
  /** 区域矩形（未旋转 PDF 页面坐标，点），调用前已归一化 x1<x2、y1<y2 */
  rect: RectCoords;
}

/** 单个目标页的预览结果 */
export interface RepeatTargetPreview {
  page: number;
  /** 映射 + 夹取后的矩形（点）；为 null 表示夹取后退化为空区域，不会生成遮盖 */
  rect: RectCoords | null;
  /** 与该页已有遮盖（含本次批内）在 0.01 点容差内相同，将跳过 */
  duplicate: boolean;
}

export interface RepeatPlan {
  source: RepeatSource;
  /** 解析出的全部目标页（升序、去重、已夹到文档范围） */
  targets: number[];
  previews: RepeatTargetPreview[];
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/* ------------------------------ 页码范围解析 ------------------------------ */

/**
 * 解析 "1-3,5"、"2,4-6, 9" 这类页码范围。
 * 页码必须为正整数；范围可以正序（1-3）或倒序（3-1，等价于 1-3）；
 * 越出 [1, numPages] 的页码 / 范围段忽略；结果升序去重。
 * 输入为空或没有任何有效页时返回 null。
 */
export function parsePageRanges(input: string, numPages: number): number[] | null {
  const out = new Set<number>();
  for (const part of input.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    let m = token.match(/^(\d+)\s*[-–—~]\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let n = lo; n <= hi; n += 1) {
        if (n >= 1 && n <= numPages) out.add(n);
      }
      continue;
    }
    m = token.match(/^(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= numPages) out.add(n);
      continue;
    }
    // 出现无法识别的片段（含非数字、0、小数等）：整体判为无效输入
    return null;
  }
  const pages = [...out].sort((a, b) => a - b);
  return pages.length > 0 ? pages : null;
}

/* ------------------------------ 比例映射 + 夹取 ------------------------------ */

/**
 * 把源页上的区域按宽高比例映射到目标页，并把结果夹取到目标页边界内。
 * 映射公式：目标坐标 = 源坐标 / 源页尺寸 * 目标页尺寸（x、y 各自独立缩放）。
 * 夹取后宽或高退化为 0（区域完全落在页面外）时返回 null。
 */
export function mapRectToPage(
  rect: RectCoords,
  sourceSize: { width: number; height: number },
  targetSize: { width: number; height: number },
): RectCoords | null {
  if (!(sourceSize.width > 0) || !(sourceSize.height > 0)) return null;
  const sx = targetSize.width / sourceSize.width;
  const sy = targetSize.height / sourceSize.height;

  const x1 = clamp(rect.x1 * sx, 0, targetSize.width);
  const x2 = clamp(rect.x2 * sx, 0, targetSize.width);
  const y1 = clamp(rect.y1 * sy, 0, targetSize.height);
  const y2 = clamp(rect.y2 * sy, 0, targetSize.height);

  const loX = Math.min(x1, x2);
  const hiX = Math.max(x1, x2);
  const loY = Math.min(y1, y2);
  const hiY = Math.max(y1, y2);
  if (hiX - loX <= 0 || hiY - loY <= 0) return null;
  return { x1: loX, y1: loY, x2: hiX, y2: hiY };
}

/* ------------------------------ 预览计划 ------------------------------ */

/**
 * 生成跨页重复预览：逐目标页映射、夹取，并标记与现有遮盖重复的页。
 * 不修改 redactions；多个目标页映射出相同矩形时（理论上仅同尺寸页间可能），
 * 因分属不同页面互不影响。
 */
export function buildRepeatPlan(
  source: RepeatSource,
  targets: number[],
  pageSizes: ReadonlyArray<{ width: number; height: number }>,
  redactions: RedactionMap,
): RepeatPlan {
  const sourceSize = pageSizes[source.page - 1];
  const previews: RepeatTargetPreview[] = targets.map((p) => {
    const mapped = sourceSize
      ? mapRectToPage(source.rect, sourceSize, pageSizes[p - 1])
      : null;
    let duplicate = false;
    if (mapped) {
      duplicate = (redactions[p] ?? []).some((b) =>
        sameRectWithinTolerance(b, mapped),
      );
    }
    return { page: p, rect: mapped, duplicate };
  });
  return { source, targets, previews };
}

/* ------------------------------ 确认应用 ------------------------------ */

export interface RepeatApplyResult {
  map: RedactionMap;
  /** 实际新增遮盖的页（矩形不重复且非退化） */
  appliedPages: number[];
  /** 跳过页：与已有遮盖重复，或夹取后退化为空 */
  skippedPages: number[];
}

/**
 * 按预览计划一次性生成新遮盖集合：每页至多追加一个框，
 * 重复 / 退化页跳过。返回全新 RedactionMap（不就地修改入参），
 * 调用方只需一次 set 提交，因此整批只产生一条撤销记录。
 */
export function applyRepeatPlan(
  base: RedactionMap,
  plan: RepeatPlan,
  nextId: () => string,
): RepeatApplyResult {
  const map: RedactionMap = {};
  for (const key of Object.keys(base)) {
    map[Number(key)] = (base[Number(key)] ?? []).map((b) => ({ ...b }));
  }

  const appliedPages: number[] = [];
  const skippedPages: number[] = [];
  // 批内去重（同一目标页不会出现两次——targets 已去重，这里仅作防御）
  const addedByPage = new Map<number, RectCoords[]>();

  for (const preview of plan.previews) {
    const rect = preview.rect;
    if (!rect) {
      skippedPages.push(preview.page);
      continue;
    }
    const known: Array<RedactionBox | RectCoords> = [
      ...(map[preview.page] ?? []),
      ...(addedByPage.get(preview.page) ?? []),
    ];
    if (known.some((b) => sameRectWithinTolerance(b, rect))) {
      skippedPages.push(preview.page);
      continue;
    }
    const box: RedactionBox = { id: nextId(), ...rect };
    map[preview.page] = [...(map[preview.page] ?? []), box];
    addedByPage.set(preview.page, [...(addedByPage.get(preview.page) ?? []), rect]);
    appliedPages.push(preview.page);
  }

  return { map, appliedPages, skippedPages };
}
