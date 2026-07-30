import { useEffect, useRef, useState } from 'react';
import type { SpendSummary } from '../../../common/ipc';
import { useSettings } from '../settings/store';
import { Modal } from './Modal';
import { notifyInfo } from '../notifications/bus';
import {
  BUDGET_ENFORCEMENTS,
  BUDGET_ENFORCEMENT_LABELS,
  evaluateBudget,
  parseBudgetEnforcement,
} from '../../../common/budgetGate';
import { parseModelBudgets, evaluateModelBudgets } from '../../../common/modelBudget';

/**
 * AI spend indicator + dashboard (PRD Phases 152/197). Shows today's estimated
 * spend in the status bar (live via the spend-changed push), turning red past an
 * optional daily budget; clicking opens a breakdown (session / today / all-time,
 * top models) and the budget control. Estimates only — the provider bills BYOK.
 */
const EMPTY: SpendSummary = {
  sessionUsd: 0,
  todayUsd: 0,
  totalUsd: 0,
  todayTokens: 0,
  totalTokens: 0,
  count: 0,
  topModels: [],
};

function fmtUsd(n: number): string {
  if (n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function fmtUsdPrecise(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function SpendStatusItem() {
  const { values, set } = useSettings();
  const [summary, setSummary] = useState<SpendSummary>(EMPTY);
  const [open, setOpen] = useState(false);
  const prevTodayRef = useRef(0);

  const dailyBudget =
    typeof values['ai.dailyBudgetUsd'] === 'number' ? (values['ai.dailyBudgetUsd'] as number) : 0;
  const dailyBudgetRef = useRef(dailyBudget);
  dailyBudgetRef.current = dailyBudget;

  useEffect(() => {
    let cancelled = false;
    void window.axiom.ai.spend
      .summary()
      .then((s) => {
        if (!cancelled) {
          setSummary(s);
          prevTodayRef.current = s.todayUsd;
        }
      })
      .catch(() => undefined);
    const unsub = window.axiom.ai.spend.onChanged((s) => {
      setSummary(s);
      const cap = dailyBudgetRef.current;
      if (cap > 0 && prevTodayRef.current <= cap && s.todayUsd > cap) {
        notifyInfo(
          `Daily AI budget exceeded — ${fmtUsdPrecise(s.todayUsd)} of ${fmtUsdPrecise(cap)}`,
          { source: 'Axiom AI' },
        );
      }
      prevTodayRef.current = s.todayUsd;
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const overBudget = dailyBudget > 0 && summary.todayUsd > dailyBudget;
  const enforcement = parseBudgetEnforcement(values['ai.budgetEnforcement']);
  const gate = evaluateBudget({
    todayUsd: summary.todayUsd,
    budgetUsd: dailyBudget,
    enforcement,
  });
  const modelBudgetsRaw =
    typeof values['ai.modelBudgets'] === 'string' ? (values['ai.modelBudgets'] as string) : '';
  const modelBudgets = parseModelBudgets(modelBudgetsRaw);
  const modelRows = evaluateModelBudgets(summary.topModels, modelBudgets);

  // Persistent HUD: always present, so cost is never a surprise discovered later.
  // When a budget is set it doubles as a meter of how much of it is left.
  const meterPercent = gate.enforced ? Math.min(100, Math.round(gate.usedFraction * 100)) : 0;
  const meterState = gate.overBudget ? 'is-over' : gate.decision === 'warn' ? 'is-warn' : 'is-ok';
  const hudLabel =
    dailyBudget > 0
      ? `${fmtUsd(summary.todayUsd)} / ${fmtUsd(dailyBudget)}`
      : `${fmtUsd(summary.todayUsd)} today`;
  const hardStop = gate.enforced && enforcement === 'block';

  return (
    <>
      <button
        type="button"
        className={`status-item status-button spend-hud${overBudget ? ' status-warn' : ''}`}
        title={`Axiom AI spend — session ${fmtUsdPrecise(summary.sessionUsd)}, today ${fmtUsdPrecise(
          summary.todayUsd,
        )}, all-time ${fmtUsdPrecise(summary.totalUsd)}. ${fmtTokens(
          summary.todayTokens,
        )} tokens today across ${summary.count} turn${summary.count === 1 ? '' : 's'}.${
          dailyBudget > 0
            ? ` Daily budget ${fmtUsdPrecise(dailyBudget)} — ${
                hardStop
                  ? 'requests are blocked once it is reached.'
                  : 'enforcement is set to warn only.'
              }`
            : ' No daily budget set.'
        } Click for details.`}
        onClick={() => setOpen(true)}
      >
        {'\uD83D\uDCB2'} {hudLabel}
        <span className="spend-hud-tokens">{fmtTokens(summary.todayTokens)} tok</span>
        {gate.enforced ? (
          <span className={`spend-hud-meter ${meterState}`} aria-hidden="true">
            <span className="spend-hud-meter-fill" style={{ width: `${meterPercent}%` }} />
          </span>
        ) : null}
        {hardStop ? (
          <span className="spend-hud-stop" title="Hard stop: requests are blocked over budget">
            stop
          </span>
        ) : null}
      </button>
      {open ? (
        <Modal
          title={'Axiom AI \u2014 Spend'}
          onClose={() => setOpen(false)}
          footer={
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void window.axiom.ai.spend.clear().then(setSummary)}
            >
              Clear spend history
            </button>
          }
        >
          <div className="spend-dash">
            <div className="spend-row">
              <span>This session</span>
              <strong>{fmtUsdPrecise(summary.sessionUsd)}</strong>
            </div>
            <div className={`spend-row${overBudget ? ' status-warn' : ''}`}>
              <span>Today</span>
              <strong>{fmtUsdPrecise(summary.todayUsd)}</strong>
            </div>
            <div className="spend-row">
              <span>All time</span>
              <strong>{fmtUsdPrecise(summary.totalUsd)}</strong>
            </div>
            <div className="spend-row spend-muted">
              <span>Tokens (today / all-time)</span>
              <span>
                {fmtTokens(summary.todayTokens)} / {fmtTokens(summary.totalTokens)}
              </span>
            </div>
            <div className="spend-row spend-muted">
              <span>Turns recorded</span>
              <span>{summary.count}</span>
            </div>

            {summary.topModels.length > 0 ? (
              <div className="spend-models">
                <div className="spend-subhead">Top models</div>
                {modelRows.map((m) => (
                  <div
                    className={`spend-row spend-muted${
                      m.status === 'over' || m.status === 'warn' ? ' status-warn' : ''
                    }`}
                    key={m.model}
                    title={m.reason}
                  >
                    <span title={m.model}>{m.model}</span>
                    <span>
                      {fmtUsdPrecise(m.usd)}
                      {m.budget > 0 ? ` / ${fmtUsdPrecise(m.budget)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <label className="spend-budget">
              <span>Daily budget (USD, 0 = off)</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={dailyBudget}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set('ai.dailyBudgetUsd', Number.isFinite(n) && n >= 0 ? n : 0, 'user');
                }}
              />
            </label>
            <label className="spend-budget">
              <span>Budget enforcement</span>
              <select
                value={enforcement}
                onChange={(e) => set('ai.budgetEnforcement', e.target.value, 'user')}
              >
                {BUDGET_ENFORCEMENTS.map((m) => (
                  <option key={m} value={m}>
                    {BUDGET_ENFORCEMENT_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="spend-budget">
              <span>Per-model budgets (model=usd)</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="gpt-4o=5, claude-3-5-sonnet=3"
                value={modelBudgetsRaw}
                onChange={(e) => set('ai.modelBudgets', e.target.value, 'user')}
              />
            </label>
            {gate.enforced ? (
              <p className={`spend-note${gate.overBudget ? ' status-warn' : ''}`}>{gate.reason}</p>
            ) : null}
            <p className="spend-note">
              Estimates only — your provider bills your API key directly, and prices are
              approximate.
            </p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
