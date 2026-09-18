import type { RectCoords } from '../pdf/scheme';
import type { RepeatPlan } from '../pdf/repeatRegion';

interface Props {
  numPages: number;
  /** 框选区域所在页（面板打开时的当前页） */
  sourcePage: number;
  sourceRect: RectCoords | null;
  rangeInput: string;
  onRangeInputChange(v: string): void;
  onPreview(): void;
  onApply(): void;
  onCancelPreview(): void;
  onClearSource(): void;
  onClose(): void;
  onJump(page: number): void;
  currentPage: number;
  /** 页码范围解析错误提示（null 表示无错误） */
  error: string | null;
  /** 已生成的预览；null 表示尚未预览或已取消 */
  plan: RepeatPlan | null;
}

const MAX_CHIPS = 24;

/**
 * 跨页重复区域面板。
 * 面板只负责收集框选区域 + 页码范围并展示预览；在用户点击「确认加入」前
 * 不会改动任何现有遮盖，「取消预览」/关闭面板即完全回到现状。
 */
export function RepeatPanel(props: Props) {
  const { plan } = props;
  const applied = plan ? plan.previews.filter((p) => p.rect && !p.duplicate) : [];
  const skipped = plan ? plan.previews.filter((p) => !p.rect || p.duplicate) : [];

  return (
    <aside className="find-panel repeat-panel">
      <div className="find-head">
        <span className="find-title">跨页重复区域</span>
        <button className="find-close" onClick={props.onClose} title="关闭面板" aria-label="关闭">
          ×
        </button>
      </div>

      <div className="find-hint">
        把当前页框选的页眉 / 页脚等固定区域，按页面宽高比例复制到指定页面；
        纯本地计算，文件不会上传。
      </div>

      <div className="repeat-section">
        <div className="repeat-label">① 框选区域</div>
        {props.sourceRect ? (
          <div className="repeat-source">
            <div className="repeat-source-info">
              来源：第 {props.sourcePage} 页
              <span className="dim">
                {' '}
                （{fmt(props.sourceRect.x1)}, {fmt(props.sourceRect.y1)}）–（
                {fmt(props.sourceRect.x2)}, {fmt(props.sourceRect.y2)}）
              </span>
            </div>
            <button type="button" className="repeat-link-btn" onClick={props.onClearSource}>
              重新框选
            </button>
          </div>
        ) : (
          <div className="find-status warn">
            请在左侧页面上按住鼠标拖出要重复的区域（页眉 / 页脚等）。
          </div>
        )}
      </div>

      <div className="repeat-section">
        <div className="repeat-label">② 目标页码范围</div>
        <form
          className="find-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onPreview();
          }}
        >
          <input
            className="find-input repeat-range-input"
            value={props.rangeInput}
            onChange={(e) => props.onRangeInputChange(e.target.value)}
            placeholder={`如 1-3,5（共 ${props.numPages} 页）`}
            spellCheck={false}
          />
          <div className="find-actions">
            <button
              type="submit"
              className="primary"
              disabled={!props.sourceRect || props.rangeInput.trim() === ''}
              title="按比例映射并预览各目标页将生成的遮盖框"
            >
              预览
            </button>
          </div>
          <div className="find-hint">支持 “1-3,5”、“3-1” 等写法，超出文档页数的部分自动忽略。</div>
        </form>
        {props.error && <div className="find-status warn">{props.error}</div>}
      </div>

      {plan && (
        <div className="repeat-section">
          <div className="repeat-label">③ 预览结果</div>
          <div className="find-status ok">
            将在 {applied.length} 页生成遮盖框
            {props.sourceRect && plan.targets.includes(props.sourcePage) && '（含来源页自身）'}。
          </div>
          {applied.length > 0 && (
            <div className="repeat-pages">
              <span className="repeat-pages-tag">应用页</span>
              <PageChips
                pages={applied.map((p) => p.page)}
                currentPage={props.currentPage}
                onJump={props.onJump}
              />
            </div>
          )}
          {skipped.length > 0 && (
            <div className="repeat-pages">
              <span className="repeat-pages-tag skip">跳过页</span>
              <PageChips
                pages={skipped.map((p) => p.page)}
                currentPage={props.currentPage}
                onJump={props.onJump}
              />
              <div className="find-hint">
                {skipped.every((p) => p.duplicate)
                  ? '这些页面已存在相同遮盖（0.01 点容差内）。'
                  : skipped.some((p) => p.duplicate)
                    ? '与已有遮盖重复，或区域越界夹取后为空。'
                    : '区域映射后完全落在页面外（夹取为空），不会生成遮盖。'}
              </div>
            </div>
          )}
          <div className="repeat-actions">
            <button type="button" className="danger-outline" onClick={props.onCancelPreview}>
              取消预览
            </button>
            <button
              type="button"
              className="primary"
              disabled={applied.length === 0}
              onClick={props.onApply}
              title="一次批量加入，整批只产生一条撤销记录"
            >
              确认加入（{applied.length} 页）
            </button>
          </div>
          <div className="find-hint">确认前不会修改任何现有遮盖；整批加入仅一条撤销记录。</div>
        </div>
      )}
    </aside>
  );
}

function PageChips({
  pages,
  currentPage,
  onJump,
}: {
  pages: number[];
  currentPage: number;
  onJump(page: number): void;
}) {
  const shown = pages.slice(0, MAX_CHIPS);
  const rest = pages.length - shown.length;
  return (
    <div className="repeat-chips">
      {shown.map((p) => (
        <button
          key={p}
          type="button"
          className={`repeat-chip${p === currentPage ? ' current' : ''}`}
          onClick={() => onJump(p)}
          title={`跳转到第 ${p} 页核对`}
        >
          {p}
        </button>
      ))}
      {rest > 0 && <span className="dim">等 {pages.length} 页</span>}
    </div>
  );
}

const fmt = (n: number) => Math.round(n * 100) / 100;
