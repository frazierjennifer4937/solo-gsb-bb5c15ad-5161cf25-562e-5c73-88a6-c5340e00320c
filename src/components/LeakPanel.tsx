import { useMemo } from 'react';
import type { LeakReport, LeakRisk } from '../pdf/edgeLeak';

export type LeakStatus =
  | { kind: 'idle' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'done'; complete: boolean }
  | { kind: 'error'; message: string };

interface Props {
  status: LeakStatus;
  /** 已扫描页面的报告（取消扫描时为部分结果）；未开始检查时为 null */
  report: LeakReport | null;
  /** 已扫描页数（取消时小于文档总页数） */
  scannedPages: number;
  numPages: number;
  checked: Set<string>;
  /** 当前在画布上高亮的风险项 id */
  activeRiskId: string | null;
  currentPage: number;
  onScan(): void;
  onCancel(): void;
  onClose(): void;
  onToggle(id: string): void;
  onTogglePage(page: number, on: boolean): void;
  onToggleAll(on: boolean): void;
  onJumpRisk(risk: LeakRisk): void;
  onJump(page: number): void;
  onApply(): void;
}

const MAX_UNCHECKED_SHOWN = 30;

/**
 * 边缘泄漏检查面板：
 * 按页列出“与遮盖相交但未被完整包住”的文本片段；没有可提取文字的页面
 * 单列为「未检查」并明确提示不能当作安全通过。点击风险项跳页并由画布高亮
 * 对应遮盖与外露部分；勾选后可批量把关联遮盖扩展到完整包住片段
 * （同一遮盖关联多项时取并集，整批只有一条撤销记录）。
 */
export function LeakPanel(props: Props) {
  const { report } = props;
  const riskPages = useMemo(
    () => (report ? report.pages.filter((p) => p.status === 'risk') : []),
    [report],
  );
  const allRisks = useMemo(() => riskPages.flatMap((p) => p.risks), [riskPages]);
  const totalRisks = allRisks.length;
  const checkedCount = allRisks.filter((r) => props.checked.has(r.id)).length;
  const allChecked = totalRisks > 0 && checkedCount === totalRisks;
  const scanning = props.status.kind === 'scanning';
  const scanState = props.status.kind === 'scanning' ? props.status : null;
  const complete = props.status.kind === 'done' && props.status.complete;
  const unchecked = report?.uncheckedPages ?? [];  const okPages = report
    ? report.pages.length - riskPages.length - unchecked.length
    : 0;

  return (
    <aside className="find-panel leak-panel">
      <div className="find-head">
        <span className="find-title">边缘泄漏检查</span>
        <button className="find-close" onClick={props.onClose} title="关闭面板" aria-label="关闭">
          ×
        </button>
      </div>

      <div className="find-hint">
        导出前逐页提取文字，找出与现有遮盖相交、却没有被完整包住的文本片段；
        纯本地解析，文件不会上传。
      </div>

      <div className="find-actions">
        {scanning ? (
          <button type="button" className="danger" onClick={props.onCancel}>
            取消扫描
          </button>
        ) : (
          <button type="button" className="primary" onClick={props.onScan}>
            {report ? '重新扫描' : '开始检查'}
          </button>
        )}
      </div>

      {scanState && (
        <div className="find-status progress">
          正在逐页提取文字：第 {scanState.done} / {scanState.total} 页
          <div className="find-progress-track">
            <div
              className="find-progress-bar"
              style={{ width: `${(scanState.done / Math.max(1, scanState.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {props.status.kind === 'error' && (
        <div className="find-status warn">{props.status.message}</div>
      )}

      {!scanning && report && (
        <>
          {!complete && (
            <div className="find-status warn">
              扫描已取消，以下仅为前 {props.scannedPages} / {props.numPages} 页的结果，
              未扫描页面的情况未知。
            </div>
          )}

          <div className="leak-summary">
            <div className={`leak-count${totalRisks > 0 ? ' risk' : ' ok'}`}>
              泄漏风险 <strong>{totalRisks}</strong> 项
              <span className="dim">（{riskPages.length} 页）</span>
            </div>
            <div className="dim">
              无风险 {okPages} 页 · 未检查 {unchecked.length} 页
            </div>
          </div>

          {unchecked.length > 0 && (
            <div className="leak-unchecked">
              <div className="leak-unchecked-title">⚠ 未检查页面（不可视为安全通过）</div>
              <div className="find-hint">
                以下页面没有可提取的文字（可能是扫描件 / 图片页），无法用文字坐标判断
                遮盖边缘是否压着内容，请手工逐页核对或先做 OCR 后再检查：
              </div>
              <div className="repeat-chips">
                {unchecked.slice(0, MAX_UNCHECKED_SHOWN).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`repeat-chip leak-page-chip${p === props.currentPage ? ' current' : ''}`}
                    onClick={() => props.onJump(p)}
                    title={`跳转到第 ${p} 页人工核对`}
                  >
                    {p}
                  </button>
                ))}
                {unchecked.length > MAX_UNCHECKED_SHOWN && (
                  <span className="dim">等 {unchecked.length} 页</span>
                )}
              </div>
            </div>
          )}

          {totalRisks > 0 ? (
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
                  className="primary small"
                  disabled={checkedCount === 0}
                  onClick={props.onApply}
                  title="把勾选风险关联的遮盖扩展到完整包住片段；同一遮盖关联多项时取并集，整批只产生一条撤销记录"
                >
                  扩展遮盖（{checkedCount}）
                </button>
              </div>

              <div className="find-results">
                {riskPages.map((pg) => {
                  const pageChecked = pg.risks.every((r) => props.checked.has(r.id));
                  const someChecked = pg.risks.some((r) => props.checked.has(r.id));
                  return (
                    <div
                      key={pg.page}
                      className={`find-group${pg.page === props.currentPage ? ' current' : ''}`}
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
                              onChange={(e) => props.onTogglePage(pg.page, e.target.checked)}
                            />
                          </label>
                          <button
                            type="button"
                            className="find-page-link"
                            onClick={() => props.onJump(pg.page)}
                          >
                            第 {pg.page} 页
                          </button>
                        </div>
                        <span className="leak-risk-count">{pg.risks.length} 项风险</span>
                      </div>
                      <ul className="find-hit-list">
                        {pg.risks.map((r) => (
                          <li
                            key={r.id}
                            className={props.activeRiskId === r.id ? 'leak-active' : ''}
                          >
                            <label className="find-hit-check">
                              <input
                                type="checkbox"
                                checked={props.checked.has(r.id)}
                                onChange={() => props.onToggle(r.id)}
                              />
                            </label>
                            <code
                              className="find-snippet leak-snippet"
                              title="点击跳转到该页并高亮对应遮盖与外露部分"
                              onClick={() => props.onJumpRisk(r)}
                            >
                              <span className="leak-text">{r.text || '（空白片段）'}</span>
                              <span className="leak-meta">
                                外露 {r.exposed.length} 块 · 关联遮盖 {r.overlaps.length} 个
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
          ) : (
            <div className="find-status ok">
              {complete
                ? '已检查全部有文字的页面，未发现遮盖边缘外露出文字。'
                : `已扫描的 ${props.scannedPages} 页中未发现边缘泄漏。`}
              {unchecked.length > 0 &&
                ' 但仍有未检查页面，不能据此认定整份文档安全。'}
            </div>
          )}
        </>
      )}

      {!scanning && !report && (
        <div className="find-status dim">
          点击「开始检查」后，将用 pdf.js 逐页扫描各文本片段的页面坐标；
          与遮盖相交但未被完整包含的片段会列在这里，没有可提取文字的页面会标记为未检查。
        </div>
      )}
    </aside>
  );
}
