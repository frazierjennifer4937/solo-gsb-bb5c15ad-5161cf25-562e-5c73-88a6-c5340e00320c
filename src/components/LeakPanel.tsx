import { useMemo } from 'react';
import type { LeakReport, LeakRisk, UncheckedPage } from '../pdf/leakCheck';

export type LeakStatus =
  | { kind: 'idle' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'done'; incomplete: boolean }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

interface Props {
  status: LeakStatus;
  report: LeakReport | null;
  checked: Set<string>;
  selectedRiskId: string | null;
  currentPage: number;
  totalBoxes: number;
  onScan(): void;
  onCancel(): void;
  onClose(): void;
  onToggle(id: string): void;
  onTogglePage(page: number, on: boolean): void;
  onToggleAll(on: boolean): void;
  onApply(): void;
  /** 点击风险条目 / 页码：跳页、选中并高亮关联遮盖与外露部分 */
  onSelectRisk(risk: LeakRisk): void;
  onJump(page: number): void;
}

/**
 * 边缘泄漏检查面板。
 * 导出前逐页核对文本片段与遮盖的几何关系；无文字页明确列为「未检查」，
 * 不与「无风险」混为一谈。勾选风险后可批量扩展关联遮盖（整批一条撤销记录）。
 */
export function LeakPanel(props: Props) {
  const { report } = props;
  const pages = useMemo(
    () => (report ? report.pages.filter((p) => p.risks.length > 0) : []),
    [report],
  );
  const allRisks = useMemo(() => pages.flatMap((p) => p.risks), [pages]);
  const totalRisks = allRisks.length;
  const checkedCount = allRisks.filter((r) => props.checked.has(r.id)).length;
  const allChecked = totalRisks > 0 && checkedCount === totalRisks;

  const noTextPages = useMemo(
    () => (report ? report.unchecked.filter((u) => u.reason === 'no-text') : []),
    [report],
  );
  const cancelledPages = useMemo(
    () => (report ? report.unchecked.filter((u) => u.reason !== 'no-text') : []),
    [report],
  );

  const scanning = props.status.kind === 'scanning';

  return (
    <aside className="find-panel leak-panel">
      <div className="find-head">
        <span className="find-title">边缘泄漏检查</span>
        <button className="find-close" onClick={props.onClose} title="关闭面板" aria-label="关闭">
          ×
        </button>
      </div>

      <div className="find-hint">
        导出前逐页核对文本片段：与遮盖相交却没被完整盖住的文字会列为风险。
        纯本地解析，文件不会上传。
      </div>

      <div className="find-actions">
        {scanning ? (
          <button type="button" className="danger" onClick={props.onCancel}>
            取消扫描
          </button>
        ) : (
          <button type="button" className="primary" onClick={props.onScan}>
            {report ? '重新检查' : '开始检查'}
          </button>
        )}
      </div>

      {props.status.kind === 'scanning' && (
        <div className="find-status progress">
          正在逐页提取文字并核对遮盖：第 {props.status.done} / {props.status.total} 页
          <div className="find-progress-track">
            <div
              className="find-progress-bar"
              style={{
                width: `${(props.status.done / Math.max(1, props.status.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {props.status.kind === 'error' && (
        <div className="find-status warn">{props.status.message}</div>
      )}

      {report && props.status.kind === 'done' && (
        <div className="find-result-meta">
          {totalRisks > 0 ? (
            <div className="find-status warn">
              发现 {totalRisks} 处边缘泄漏风险，分布在 {pages.length} 页；
              勾选后可批量扩展关联遮盖。
            </div>
          ) : (
            <div className="find-status ok">
              已核对的页面中，与遮盖相交的文字均已被完整包住，未发现边缘泄漏。
            </div>
          )}
          {report.incomplete && (
            <div className="find-status warn">
              本次检查不完整：部分页面未扫描或提取失败（见下方「未检查页面」），结果不能代表全文安全，建议重新检查。
            </div>
          )}
          <div className="find-status dim">
            已核对 {report.pages.length} 页；未检查 {report.unchecked.length} 页
            （未检查 ≠ 安全）。
          </div>
        </div>
      )}

      {report && totalRisks > 0 && (
        <>
          <div className="find-selectbar">
            <label>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => props.onToggleAll(e.target.checked)}
              />{' '}
              全选
            </label>
            <span className="dim">{checkedCount} / {totalRisks}</span>
            <button
              type="button"
              className="primary small"
              disabled={checkedCount === 0 || scanning}
              onClick={props.onApply}
              title="把勾选风险的关联遮盖扩展到完整包住片段；同一遮盖关联多项取并集，整批一条撤销记录"
            >
              扩展遮盖（{checkedCount}）
            </button>
          </div>

          <div className="find-results">
            {pages.map((p) => {
              const risks = p.risks;
              const pageChecked = risks.every((r) => props.checked.has(r.id));
              const someChecked = risks.some((r) => props.checked.has(r.id));
              return (
                <div
                  key={p.page}
                  className={`find-group${p.page === props.currentPage ? ' current' : ''}`}
                >
                  <div className="find-group-head">
                    <div className="find-group-title">
                      <label className="find-hit-check">
                        <input
                          type="checkbox"
                          checked={pageChecked}
                          ref={(el) => {
                            if (el) el.indeterminate = !pageChecked && someChecked;
                          }}
                          onChange={(e) => props.onTogglePage(p.page, e.target.checked)}
                        />
                      </label>
                      <button
                        type="button"
                        className="find-page-link"
                        onClick={() => props.onJump(p.page)}
                      >
                        第 {p.page} 页
                      </button>
                    </div>
                    <span className="dim">{risks.length} 处风险</span>
                  </div>
                  <ul className="find-hit-list">
                    {risks.map((r) => (
                      <li
                        key={r.id}
                        className={
                          props.selectedRiskId === r.id
                            ? 'leak-risk checked selected'
                            : props.checked.has(r.id)
                              ? 'leak-risk checked'
                              : 'leak-risk'
                        }
                      >
                        <label className="find-hit-check">
                          <input
                            type="checkbox"
                            checked={props.checked.has(r.id)}
                            onChange={() => props.onToggle(r.id)}
                          />
                        </label>
                        <code
                          className="find-snippet"
                          title="点击跳页并高亮关联遮盖与外露部分"
                          onClick={() => props.onSelectRisk(r)}
                        >
                          {summarize(r.text)}
                          <span className="leak-where">
                            外露 {r.exposed.length} 块
                            {r.boxId ? '' : '（关联遮盖已删除，请重新检查）'}
                          </span>
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}

      {report && report.unchecked.length > 0 && (
        <div className="leak-unchecked">
          <div className="leak-unchecked-title">未检查页面（{report.unchecked.length} 页）</div>
          {noTextPages.length > 0 && (
            <div className="find-status dim">
              第 {formatPageList(noTextPages.map((u) => u.page))} 页没有可提取的文字
              （扫描件 / 图片页），无法自动核对，不得视为安全通过，请人工目检。
            </div>
          )}
          {cancelledPages.length > 0 && (
            <div className="find-status warn">
              第 {formatPageList(cancelledPages.map((u) => u.page))} 页
              {cancelledPages.every((u) => u.reason === 'error') ? '文字提取失败' : '本次未扫描到'}
              ，结果不代表这些页安全，请重新检查。
            </div>
          )}
        </div>
      )}

      {!report && !scanning && props.status.kind !== 'error' && props.totalBoxes === 0 && (
        <div className="find-status dim">当前文档还没有任何遮盖；请先绘制或生成遮盖后再检查。</div>
      )}
    </aside>
  );
}

/** 片段摘要：单行化、限长 */
function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = [...oneLine];
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : oneLine || '（空白片段）';
}

function formatPageList(pages: number[]): string {
  if (pages.length <= 8) return pages.join('、');
  return `${pages.slice(0, 8).join('、')} 等 ${pages.length} 页`;
}

export type { LeakRisk, UncheckedPage };
