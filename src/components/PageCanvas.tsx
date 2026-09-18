import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { HitRect, RedactionBox, Tool } from '../types';
import { uid } from '../types';
import type { RectCoords } from '../pdf/scheme';

/** 视口（CSS 像素）坐标系中的矩形 */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 小于该尺寸（视口像素）的框视为误触 */
const MIN_SIZE = 4;

type DragState =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; id: string; rect: Rect; startX: number; startY: number }
  | { kind: 'resize'; id: string; handle: Handle; rect: Rect };

interface Draft {
  /** null 表示正在绘制新框 */
  id: string | null;
  rect: Rect;
}

interface Highlight {
  id: string;
  rects: HitRect[];
  checked: boolean;
}

/** 跨页重复区域的预览标记（PDF 页面坐标），仅显示不参与交互 */
export interface RepeatMarker {
  id: string;
  rect: RectCoords;
  /** 'apply' 计划加入；'skip' 与已有遮盖重复 / 夹取为空 */
  kind: 'apply' | 'skip' | 'source';
}

/**
 * 边缘泄漏检查的画布高亮（PDF 页面坐标）：
 * - exposed：片段露在遮盖外的部分（红色实心，最醒目）；
 * - rect：片段完整包围盒（青色描边）；
 * - linkedBoxIds：需要一并高亮的关联遮盖 id（画布上加描边）。
 */
export interface LeakHighlight {
  id: string;
  rect: RectCoords;
  exposed: RectCoords[];
  linkedBoxIds: string[];
}

interface Props {
  page: PDFPageProxy;
  zoom: number;
  /** 用户附加的旋转角度（0/90/180/270），叠加在页面自身旋转之上 */
  rotation: number;
  tool: Tool;
  boxes: RedactionBox[];
  selectedId: string | null;
  /** 文本查找候选（PDF 页面坐标），画布上高亮显示，不参与交互 */
  highlights: Highlight[];
  /**
   * 跨页重复区域框选回调：仅当 pickingRegion 为 true 时，
   * 「绘制遮盖」模式下拖出的矩形不写入遮盖，而是作为重复区域来源交给该回调。
   */
  pickingRegion: boolean;
  onPickRegion(rect: RectCoords): void;
  /** 跨页重复预览标记（PDF 页面坐标），画布上虚线显示，不参与交互 */
  repeatMarkers: RepeatMarker[];
  /** 边缘泄漏检查的高亮（外露部分 + 片段外框 + 关联遮盖），仅显示 */
  leakHighlights: LeakHighlight[];
  onSelect(id: string | null): void;
  onAdd(box: RedactionBox): void;
  onChange(box: RedactionBox): void;
}

function normalizeRect(r: Rect): Rect {
  return {
    left: r.width >= 0 ? r.left : r.left + r.width,
    top: r.height >= 0 ? r.top : r.top + r.height,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}

function applyHandle(r: Rect, handle: Handle, x: number, y: number): Rect {
  let left = r.left;
  let top = r.top;
  let right = r.left + r.width;
  let bottom = r.top + r.height;
  if (handle.includes('w')) left = x;
  if (handle.includes('e')) right = x;
  if (handle.includes('n')) top = y;
  if (handle.includes('s')) bottom = y;
  return normalizeRect({ left, top, width: right - left, height: bottom - top });
}

export function PageCanvas({
  page,
  zoom,
  rotation,
  tool,
  boxes,
  selectedId,
  highlights,
  pickingRegion,
  onPickRegion,
  repeatMarkers,
  leakHighlights,
  onSelect,
  onAdd,
  onChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // window 拖拽回调在组件首次挂载时注册，通过 ref 读取最新框选开关
  const pickingRegionRef = useRef(pickingRegion);
  pickingRegionRef.current = pickingRegion;

  // 所有坐标换算都经过 viewport：缩放 / 旋转不会改变已保存的页面坐标
  const viewport = useMemo(
    () => page.getViewport({ scale: zoom, rotation: (page.rotate + rotation) % 360 }),
    [page, zoom, rotation],
  );

  /** 当前页边缘泄漏高亮涉及的关联遮盖 id（画布上加醒目描边） */
  const leakLinkedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const h of leakHighlights) for (const id of h.linkedBoxIds) ids.add(id);
    return ids;
  }, [leakHighlights]);

  // 渲染 PDF 页面到底层 canvas（高分屏按 devicePixelRatio 超采样）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    task.promise.catch(() => {
      /* 渲染被取消（缩放/翻页）时忽略 */
    });
    return () => task.cancel();
  }, [page, viewport]);

  /** 页面坐标 -> 视口矩形（用于显示） */
  const coordsToRect = (b: RectCoords): Rect => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([b.x1, b.y1, b.x2, b.y2]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  const boxToRect = (b: RedactionBox): Rect => coordsToRect(b);

  /** 查找候选框（PDF 页面坐标） -> 视口矩形 */
  const hitRectToRect = (r: HitRect): Rect => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x1, r.y1, r.x2, r.y2]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  /** 视口矩形 -> 页面坐标（用于保存） */
  const rectToBox = (r: Rect, id: string): RedactionBox => {
    const [ax, ay] = viewport.convertToPdfPoint(r.left, r.top);
    const [bx, by] = viewport.convertToPdfPoint(r.left + r.width, r.top + r.height);
    return {
      id,
      x1: Math.min(ax, bx),
      y1: Math.min(ay, by),
      x2: Math.max(ax, bx),
      y2: Math.max(ay, by),
    };
  };

  const localPoint = (clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // 拖拽过程监听在 window 上，指针移出页面区域也能继续
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = localPoint(e.clientX, e.clientY);
      if (drag.kind === 'draw') {
        setDraft({
          id: null,
          rect: normalizeRect({
            left: drag.startX,
            top: drag.startY,
            width: p.x - drag.startX,
            height: p.y - drag.startY,
          }),
        });
      } else if (drag.kind === 'move') {
        setDraft({
          id: drag.id,
          rect: {
            ...drag.rect,
            left: drag.rect.left + p.x - drag.startX,
            top: drag.rect.top + p.y - drag.startY,
          },
        });
      } else {
        setDraft({
          id: drag.id,
          rect: applyHandle(drag.rect, drag.handle, p.x, p.y),
        });
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const d = draftRef.current;
      setDraft(null);
      if (!d || d.rect.width < MIN_SIZE || d.rect.height < MIN_SIZE) return;
      // 拖拽结束时才把结果换算回页面坐标并提交（产生一条撤销记录）
      if (drag.kind === 'draw') {
        const box = rectToBox(d.rect, uid());
        if (pickingRegionRef.current) {
          // 跨页重复区域框选模式：矩形不进入遮盖集合，仅作为重复来源
          onPickRegion({ x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 });
        } else {
          onAdd(box);
        }
      } else {
        onChange(rectToBox(d.rect, drag.id));
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  const startDraw = (e: React.PointerEvent) => {
    if (tool !== 'draw' || e.button !== 0) return;
    const p = localPoint(e.clientX, e.clientY);
    dragRef.current = { kind: 'draw', startX: p.x, startY: p.y };
    setDraft({ id: null, rect: { left: p.x, top: p.y, width: 0, height: 0 } });
  };

  const startMove = (e: React.PointerEvent, box: RedactionBox) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    onSelect(box.id);
    const p = localPoint(e.clientX, e.clientY);
    const rect = boxToRect(box);
    dragRef.current = { kind: 'move', id: box.id, rect, startX: p.x, startY: p.y };
    setDraft({ id: box.id, rect });
  };

  const startResize = (e: React.PointerEvent, box: RedactionBox, handle: Handle) => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    onSelect(box.id);
    const rect = boxToRect(box);
    dragRef.current = { kind: 'resize', id: box.id, handle, rect };
    setDraft({ id: box.id, rect });
  };

  return (
    <div
      className={`page-stage tool-${tool}`}
      style={{ width: viewport.width, height: viewport.height }}
      onPointerDown={tool === 'draw' ? startDraw : () => onSelect(null)}
    >
      <canvas ref={canvasRef} />
      <div ref={overlayRef} className="overlay">
        {highlights.map((h) =>
          h.rects.map((r, i) => {
            const vr = hitRectToRect(r);
            return (
              <div
                key={`${h.id}-${i}`}
                className={`find-highlight${h.checked ? ' checked' : ''}`}
                style={{ left: vr.left, top: vr.top, width: vr.width, height: vr.height }}
              />
            );
          }),
        )}
        {boxes.map((b) => {
          const r = draft && draft.id === b.id ? draft.rect : boxToRect(b);
          const selected = b.id === selectedId;
          const leakLinked = leakLinkedIds.has(b.id);
          return (
            <div
              key={b.id}
              className={`redaction-box${selected ? ' selected' : ''}${leakLinked ? ' leak-linked' : ''}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              onPointerDown={(e) => startMove(e, b)}
              title={leakLinked ? '与边缘泄漏风险关联的遮盖' : '遮盖区域'}
            >
              {selected &&
                tool === 'select' &&
                HANDLES.map((h) => (
                  <span
                    key={h}
                    className={`handle handle-${h}`}
                    onPointerDown={(e) => startResize(e, b, h)}
                  />
                ))}
            </div>
          );
        })}
        {draft && draft.id === null && (
          <div
            className="redaction-box drafting"
            style={{
              left: draft.rect.left,
              top: draft.rect.top,
              width: draft.rect.width,
              height: draft.rect.height,
            }}
          />
        )}
        {leakHighlights.flatMap((h) => {
          const fr = coordsToRect(h.rect);
          const nodes = [
            <div
              key={`leak-${h.id}-frag`}
              className="leak-fragment"
              style={{ left: fr.left, top: fr.top, width: fr.width, height: fr.height }}
            />,
          ];
          // 外露部分最后渲染，压在片段外框与遮盖之上
          h.exposed.forEach((e, i) => {
            const er = coordsToRect(e);
            nodes.push(
              <div
                key={`leak-${h.id}-exp-${i}`}
                className="leak-exposed"
                style={{ left: er.left, top: er.top, width: er.width, height: er.height }}
              />,
            );
          });
          return nodes;
        })}
        {repeatMarkers.map((m) => {
          const vr = coordsToRect(m.rect);
          return (
            <div
              key={m.id}
              className={`repeat-marker repeat-${m.kind}`}
              style={{ left: vr.left, top: vr.top, width: vr.width, height: vr.height }}
            />
          );
        })}
      </div>
    </div>
  );
}
