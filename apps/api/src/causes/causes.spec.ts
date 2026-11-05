import { CAUSE_KINDS } from '../contract';
import { type CauseCall, type CauseGrade, type CauseTrial, CAUSE_RULES_VERSION, bareTool, causeOf, listWords, needsCause, quote, resolveLabels, wantedTools } from './causes';

/**
 * D64's failure-cause rules (docs/assumptions.md A45), each on synthetic trials: what a trial
 * recorded goes in, its primary and contributing causes come out. The grades' reasons and
 * evidence are written the way evals_graders writes them; no trial here is a real one.
 */

const call = (name: string, extra: Partial<CauseCall> = {}): CauseCall => ({ name, is_error: false, arguments: '{}', result: '{"ok": true}', ...extra });

const grade = (grader_id: string, type: string, verdict: string, extra: Partial<CauseGrade> = {}): CauseGrade => ({
  grader_id,
  type,
  required: true,
  verdict,
  reason: `${grader_id}: ${verdict}`,
  evidence: [],
  spec: { id: grader_id, type },
  ...extra,
});

/** A tool_called grade as the grader writes it. */
function toolCalled(tool: string, verdict: string, calls: { quote: string }[] = [], extra: Partial<CauseGrade> & { args?: unknown } = {}): CauseGrade {
  const { args, ...rest } = extra;
  const spec: Record<string, unknown> = { id: `used-${tool}`, type: 'tool_called', tool };
  if (args !== undefined) spec.args = args;
  const reason =
    verdict === 'pass'
      ? `${tool} was called ${calls.length} time(s)`
      : calls.length && args !== undefined
        ? `${tool} was called ${calls.length} time(s), but 0 matched with ${JSON.stringify(args)} (need 1)`
        : `${tool} was called 0 time(s), need at least 1 (tools called: none)`;
  return grade(`used-${tool}`, 'tool_called', verdict, { reason, spec, evidence: calls.map((c) => ({ source: 'span', span_id: 's', tool, quote: c.quote })), ...rest });
}

function trial(over: Partial<CauseTrial> = {}): CauseTrial {
  return {
    status: 'done',
    label: 'agent',
    outcome: 'fail',
    end_state: 'answered',
    harness: 'ownloop',
    stop_reason: 'stop',
    exception: null,
    has_answer: true,
    model_calls: 3,
    max_steps: 15,
    timeout_s: 300,
    max_output_tokens: 8192,
    malformed_tool_calls: 0,
    required_tools: [],
    calls: [],
    grades: [],
    labels: {},
    ...over,
  };
}

const causes = (t: CauseTrial) => {
  const c = causeOf(t);
  return c ? [c.cause, ...c.contributing.map((x) => x.cause)] : null;
};

describe('which trials get a cause', () => {
  it('a failed agent outcome, or one that ended other than answered; never a pass, an infra failure or a trial not done', () => {
    expect(needsCause(trial())).toBe(true);
    expect(needsCause(trial({ outcome: 'pass' }))).toBe(false);
    expect(needsCause(trial({ outcome: 'incomplete' }))).toBe(false);
    expect(needsCause(trial({ outcome: 'pass', end_state: 'step_limit' }))).toBe(true);
    expect(needsCause(trial({ outcome: null, end_state: 'timeout' }))).toBe(true);
    expect(needsCause(trial({ status: 'infra_failed', label: 'infra:provider_error' }))).toBe(false);
    expect(needsCause(trial({ status: 'done', label: 'infra:config_error' }))).toBe(false);
    expect(needsCause(trial({ status: 'running', outcome: null, end_state: null }))).toBe(false);
    expect(causeOf(trial({ outcome: 'pass' }))).toBeNull();
  });

  it('carries the rules version, and every cause it can give is one of the contract kinds', () => {
    const c = causeOf(trial())!;
    expect(c.rules_version).toBe(CAUSE_RULES_VERSION);
    expect(CAUSE_KINDS).toContain(c.cause);
  });
});

describe('ran_out_of_steps', () => {
  it('a step limit on the own loop: no answer, and the reason says how many calls and the limit', () => {
    const c = causeOf(trial({ end_state: 'step_limit', has_answer: false, model_calls: 15, stop_reason: 'max_steps', outcome: 'fail' }))!;
    expect(c.cause).toBe('ran_out_of_steps');
    expect(c.reason).toBe('Stopped at the step limit after 15 model calls (its limit is 15); the own loop stops at the limit without an answer (the own loop reported "max_steps")');
  });

  it("Hermes answers at the limit with a summary, and the reason keeps Hermes's own words", () => {
    const c = causeOf(trial({ harness: 'hermes', end_state: 'step_limit', has_answer: true, model_calls: 17, stop_reason: 'max_iterations_reached(15/15)' }))!;
    expect(c.cause).toBe('ran_out_of_steps');
    expect(c.reason).toContain('Hermes asks for a summary at the limit, and that summary is the answer that was graded');
    expect(c.reason).toContain('"max_iterations_reached(15/15)"');
  });

  it('a cut-off reply on the own loop says it was already sent again at double the cap; a timeout names the limit', () => {
    expect(causeOf(trial({ end_state: 'token_limit', stop_reason: 'length after one re-send' }))!.reason).toContain('cut off at the output cap of 8,192 tokens; the own loop had already sent it again once with the cap doubled');
    expect(causeOf(trial({ end_state: 'token_limit', harness: 'langgraph' }))!.reason).toContain('LangGraph stops on the first reply that is cut off');
    const t = causeOf(trial({ end_state: 'timeout', timeout_s: 60, harness: 'hermes' }))!;
    expect(t.cause).toBe('ran_out_of_steps');
    expect(t.reason).toBe("The trial ran past its time limit of 60 s and was stopped; Hermes's start-up counts inside that time");
  });

  it('comes first: the checks that failed because the run was cut short are contributing', () => {
    const c = causeOf(trial({ end_state: 'step_limit', has_answer: false, grades: [grade('emi', 'number', 'fail', { reason: 'the agent gave no final answer to find a number in' })] }))!;
    expect(c.cause).toBe('ran_out_of_steps');
    expect(c.contributing.map((x) => x.cause)).toEqual(['wrong_answer']);
  });
});

describe('an agent or harness error is other, in the harness’s own words', () => {
  it("LangGraph's malformed-only reply, with the count", () => {
    const c = causeOf(trial({ harness: 'langgraph', end_state: 'agent_error', malformed_tool_calls: 1, stop_reason: 'only invalid_tool_calls' }))!;
    expect(c.cause).toBe('other');
    expect(c.reason).toBe('The agent\'s run ended in an error after 1 malformed tool call: "only invalid_tool_calls"; LangGraph ends this way when a reply holds only malformed tool calls, and the model is never told');
  });

  it("Hermes's failed result is a harness error whose apology is not an answer", () => {
    const c = causeOf(trial({ harness: 'hermes', end_state: 'harness_error', stop_reason: null, exception: 'BadRequestError: prompt is too long', has_answer: false }))!;
    expect(c.cause).toBe('other');
    expect(c.reason).toContain('"BadRequestError: prompt is too long"');
    expect(c.reason).toContain("Hermes's own failed result ends this way");
  });
});

describe('judge_vs_label', () => {
  const judge = (verdicts: Record<string, 'yes' | 'no'>, required = false): CauseGrade =>
    grade('overall', 'judge', Object.values(verdicts).includes('no') ? 'fail' : 'pass', {
      required,
      evidence: [...Object.entries(verdicts).map(([criterion, verdict]) => ({ criterion, verdict, required: true })), { source: 'judge_call' }],
    });

  it("contributes when the judge's verdict on a labelled criterion differs from the label", () => {
    const c = causeOf(trial({ grades: [grade('emi', 'number', 'fail'), judge({ overall: 'no' })], labels: { overall: 'yes' } }))!;
    expect(c.cause).toBe('wrong_answer');
    expect(c.contributing).toEqual([{ cause: 'judge_vs_label', reason: 'On overall the judge said no and the human label says yes' }]);
  });

  it('is the primary cause when it explains the failure: only a required judge check failed, on criteria the label passes', () => {
    const c = causeOf(trial({ grades: [judge({ empathy: 'no', clear: 'yes' }, true)], labels: { empathy: 'yes', clear: 'yes' } }))!;
    expect(c.cause).toBe('judge_vs_label');
    expect(c.reason).toBe('On empathy the judge said no and the human label says yes');
  });

  it('a "not sure" label, an unlabelled criterion or an agreeing label is no disagreement; a second look answers a "not sure"', () => {
    expect(causes(trial({ grades: [grade('x', 'regex_present', 'fail'), judge({ overall: 'no' })], labels: { overall: 'unsure' } }))).toEqual(['wrong_answer']);
    expect(causes(trial({ grades: [grade('x', 'regex_present', 'fail'), judge({ overall: 'no' })], labels: { overall: 'no' } }))).toEqual(['wrong_answer']);
    expect(causes(trial({ grades: [grade('x', 'regex_present', 'fail'), judge({ overall: 'no' })] }))).toEqual(['wrong_answer']);
    const labels = resolveLabels([
      { criterion: 'overall', value: 'unsure', second_look: false },
      { criterion: 'overall', value: 'yes', second_look: true },
      { criterion: 'overall', value: 'no', second_look: true },
      { criterion: 'tone', value: 'no', second_look: false },
      { criterion: 'tone', value: 'yes', second_look: false },
    ]);
    expect(labels).toEqual({ overall: 'yes', tone: 'no' });
  });

  it('when the label disagrees but other checks failed too, it is not primary, and an unexplained failure is other', () => {
    const c = causeOf(trial({ grades: [judge({ empathy: 'no' }, true), grade('odd', 'end_state', 'fail', { reason: 'ended answered, not step_limit' })], labels: { empathy: 'yes' } }))!;
    expect(c.cause).toBe('other');
    expect(c.reason).toBe('overall and odd failed, which no rule explains: overall: fail');
    expect(c.contributing.map((x) => x.cause)).toEqual(['judge_vs_label']);
  });
});

describe('wrong_tool', () => {
  it('a wanted tool never called, with another tool called in its place, quoted as the brief asks', () => {
    const c = causeOf(trial({ calls: [call('amortization_schedule')], grades: [toolCalled('calculate_emi', 'fail')] }))!;
    expect(c.cause).toBe('wrong_tool');
    expect(c.reason).toBe('calculate_emi was never called; amortization_schedule was');
  });

  it("required_tools count as wanted, and Hermes's mcp__finance__ prefix is removed", () => {
    const c = causeOf(trial({ harness: 'hermes', required_tools: ['list_debts', 'list_transactions'], calls: [call('mcp__finance__get_client_profile'), call('mcp__finance__list_debts')], grades: [grade('read-the-file', 'required_tools', 'fail')] }))!;
    expect(c.cause).toBe('wrong_tool');
    expect(c.reason).toBe('list_transactions was never called; get_client_profile was');
  });

  it('a tool a tool_not_called check forbids was called', () => {
    const forbid = grade('no-payoff', 'tool_not_called', 'fail', { reason: 'debt_payoff_plan was called 1 time(s)', spec: { id: 'no-payoff', type: 'tool_not_called', tool: 'debt_payoff_plan' } });
    expect(causeOf(trial({ calls: [call('debt_payoff_plan')], grades: [forbid] }))!.reason).toBe('debt_payoff_plan was called, though a check says the task must not call it');
  });
});

describe('gave_up_early', () => {
  it('answered with no tool call at all, though the task needs one', () => {
    const c = causeOf(trial({ calls: [], grades: [toolCalled('calculate_emi', 'fail'), grade('emi', 'number', 'fail')] }))!;
    expect(c.cause).toBe('gave_up_early');
    expect(c.reason).toBe('Answered without calling any tool; the task needs calculate_emi');
    // The number check failed because the tool was never called: not a wrong answer with the right tools.
    expect(c.contributing).toEqual([]);
  });

  it('answered after only some of the wanted tools, with nothing else called in place of the rest', () => {
    const c = causeOf(trial({ calls: [call('list_debts')], grades: [toolCalled('list_debts', 'pass', [{ quote: '{}' }]), toolCalled('debt_payoff_plan', 'fail')] }))!;
    expect(c.cause).toBe('gave_up_early');
    expect(c.reason).toBe('Answered without calling debt_payoff_plan; it called only list_debts, which the task also needs');
  });

  it('is not a cause when the task wants no tool, or when the run did not end with an answer', () => {
    expect(causes(trial({ calls: [], grades: [grade('asks', 'unit_test', 'fail')] }))).toEqual(['wrong_answer']);
    expect(causes(trial({ end_state: 'step_limit', calls: [], grades: [toolCalled('calculate_emi', 'fail')] }))).toEqual(['ran_out_of_steps']);
  });
});

describe('made_up_arguments', () => {
  it("the wanted tool was called, but never with the arguments its check wants, from the grade's own evidence", () => {
    const c = causeOf(
      trial({
        calls: [call('debt_payoff_plan', { arguments: '{"monthly_budget": 25000}' })],
        grades: [toolCalled('debt_payoff_plan', 'fail', [{ quote: '{"monthly_budget": 25000}' }], { args: { monthly_budget: 20000 } })],
      }),
    )!;
    expect(c.cause).toBe('made_up_arguments');
    expect(c.reason).toBe('debt_payoff_plan was called once, but never with the arguments the check wants ({"monthly_budget":20000}); it sent {"monthly_budget": 25000}');
  });

  it("an unsupported figure that came from an arithmetic call the runner's checks rejected for an input with no source", () => {
    const prov = grade('every-amount-from-a-tool', 'provenance', 'fail', {
      reason:
        "1 of 3 amount(s) in the agent's replies have no tool result, client-file number or user message behind them: Rs 3,000 (round's input 2,950 (subtract's result, itself unsupported) is not supported), more than the 0 allowed; 0 written without a tool and verified by recomputing them (derived in prose)",
      evidence: [
        { source: 'final_answer', quote: 'Rs 3,000' },
        { source: 'span', span_id: 's3', tool: 'round', quote: '{"value": 2950}' },
      ],
    });
    const c = causeOf(trial({ calls: [call('list_debts'), call('round', { arguments: '{"value": 2950}' })], grades: [prov] }))!;
    expect(c.cause).toBe('made_up_arguments');
    expect(c.reason).toBe("Rs 3,000 came from a tool call given a number with no source (round's input 2,950 (subtract's result, itself unsupported) is not supported)");
    expect(c.contributing).toEqual([{ cause: 'unsupported_figure', reason: "Rs 3,000 has no tool result, client-file number or message behind it (1 of 3 figures)" }]);
  });

  it('a check that failed on too many calls, or a tool never called, is not a made-up argument', () => {
    const cap = grade('once', 'tool_called', 'fail', { reason: 'calculate_emi was called 3 times, more than the 1 allowed', spec: { id: 'once', type: 'tool_called', tool: 'calculate_emi', max_calls: 1 }, evidence: [{ source: 'span', tool: 'calculate_emi', quote: '{}' }] });
    expect(causes(trial({ calls: [call('calculate_emi'), call('calculate_emi'), call('calculate_emi')], grades: [cap] }))).toEqual(['other']);
    expect(causes(trial({ calls: [call('fd_maturity')], grades: [toolCalled('calculate_emi', 'fail', [], { args: { principal: 1 } })] }))).toEqual(['wrong_tool']);
  });
});

describe('tool_error', () => {
  it('a tool returned an error and was never called successfully after it, with what the harness does with errors', () => {
    const c = causeOf(
      trial({
        calls: [call('calculate_emi', { is_error: true, result: '{"error": "annual_rate_pct must be between 0 and 60"}' })],
        grades: [toolCalled('calculate_emi', 'pass', [{ quote: '{}' }]), grade('emi', 'number', 'fail')],
      }),
    )!;
    expect(c.cause).toBe('tool_error');
    expect(c.reason).toBe('calculate_emi returned an error and was not called successfully after it: "{"error": "annual_rate_pct must be between 0 and 60"}"; the own loop passes the server\'s error text back as it is');
    expect(c.contributing.map((x) => x.cause)).toEqual(['wrong_answer']);
  });

  it('an error followed by a successful call of the same tool is recovered from, and is no cause', () => {
    expect(causes(trial({ calls: [call('calculate_emi', { is_error: true }), call('calculate_emi')], grades: [toolCalled('calculate_emi', 'pass', [{ quote: '{}' }]), grade('emi', 'number', 'fail')] }))).toEqual(['wrong_answer']);
  });

  it("on Hermes, a call with no arguments may be Hermes's own repair of a malformed one, and the reason says so", () => {
    const c = causeOf(trial({ harness: 'hermes', calls: [call('mcp__finance__list_debts', { is_error: true, arguments: '{}' }), call('mcp__finance__list_debts', { is_error: true, arguments: '{}' })], grades: [grade('x', 'number', 'fail')] }))!;
    expect(c.cause).toBe('tool_error');
    expect(c.reason).toMatch(/^list_debts returned an error twice and was not called successfully after it/);
    expect(c.reason).toContain('pauses the tools for a minute after three errors in a row; Hermes runs a call it cannot repair with no arguments');
  });
});

describe('unsupported_figure', () => {
  it('names the figures the provenance grade quotes, with the count from its reason', () => {
    const prov = grade('every-amount-from-a-tool', 'provenance', 'fail', {
      reason: "2 of 6 amount(s) in the agent's replies have no tool result, client-file number or user message behind them: Rs 23,120, Rs 9,500, more than the 0 allowed",
      evidence: [
        { source: 'final_answer', quote: 'Rs 23,120' },
        { source: 'final_answer', quote: 'Rs 9,500' },
        { source: 'final_answer', quote: 'Rs 1,120', verified_by: 'derived_in_prose', derivation: '8,000 − 6,880 = 1,120' },
      ],
    });
    const c = causeOf(trial({ calls: [call('list_debts')], grades: [prov] }))!;
    expect(c.cause).toBe('unsupported_figure');
    expect(c.reason).toBe('Rs 23,120 and Rs 9,500 have no tool result, client-file number or message behind them (2 of 6 figures)');
  });

  it('more than three figures are counted, not all listed', () => {
    const quotes = ['Rs 1', 'Rs 2', 'Rs 3', 'Rs 4', 'Rs 5'];
    const prov = grade('p', 'provenance', 'fail', { reason: '5 of 9 amount(s) in the final answer have ...', evidence: quotes.map((quote) => ({ source: 'final_answer', quote })) });
    expect(causeOf(trial({ grades: [prov] }))!.reason).toBe('Rs 1, Rs 2, Rs 3 and 2 more have no tool result, client-file number or message behind them (5 of 9 figures)');
  });
});

describe('wrong_answer', () => {
  it('a number check failed though every wanted tool was called, quoting the grade', () => {
    const c = causeOf(
      trial({
        calls: [call('calculate_emi')],
        grades: [toolCalled('calculate_emi', 'pass', [{ quote: '{}' }]), grade('emi-value', 'number', 'fail', { reason: 'no rupee amount within ±1 of ₹8,997.26; the closest is ₹9,000, 2.74 away from 8997.26' }), grade('total', 'regex_present', 'fail')],
      }),
    )!;
    expect(c.cause).toBe('wrong_answer');
    expect(c.reason).toBe('emi-value failed, though calculate_emi was called: no rupee amount within ±1 of ₹8,997.26; the closest is ₹9,000, 2.74 away from 8997.26; total also failed');
  });

  it('a judge check that fails with no label against it is other: the judge is not a deterministic check', () => {
    const judge = grade('overall', 'judge', 'fail', { reason: 'judge: overall no', evidence: [{ criterion: 'overall', verdict: 'no' }] });
    expect(causeOf(trial({ grades: [judge] }))).toMatchObject({ cause: 'other', reason: 'overall failed, which no rule explains: judge: overall no', contributing: [] });
  });
});

describe('precedence and helpers', () => {
  it('the first rule that matches is primary and the rest contribute, in order', () => {
    const c = causeOf(
      trial({
        calls: [call('fd_maturity', { is_error: true })],
        grades: [
          toolCalled('calculate_emi', 'fail'),
          grade('p', 'provenance', 'fail', { reason: '1 of 1 amount(s) ...', evidence: [{ source: 'final_answer', quote: 'Rs 5' }] }),
          grade('emi', 'number', 'fail'),
        ],
      }),
    )!;
    // wrong_answer needs every wanted tool called, so it is not listed here.
    expect([c.cause, ...c.contributing.map((x) => x.cause)]).toEqual(['wrong_tool', 'tool_error', 'unsupported_figure']);
  });

  it('a failure with no rule and no failed check says so', () => {
    expect(causeOf(trial({ grades: [] }))).toMatchObject({ cause: 'other', reason: 'No rule fits what this trial recorded' });
  });

  it('wanted tools: required_tools first, then required tool_called checks that ask for a call, once each', () => {
    expect(
      wantedTools(
        ['mcp__finance__list_debts'],
        [
          { type: 'tool_called', tool: 'calculate_emi' },
          { type: 'tool_called', tool: 'list_debts' },
          { type: 'tool_called', tool: 'fd_maturity', required: false },
          { type: 'tool_called', tool: 'round', min_calls: 0 },
          { type: 'number', tool: 'x' },
        ],
      ),
    ).toEqual(['list_debts', 'calculate_emi']);
    expect(bareTool(' mcp__finance__add ')).toBe('add');
    expect(listWords(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(listWords(['a', 'b'])).toBe('a and b');
    expect(quote('a\n  b', 10)).toBe('a b');
    expect(quote('abcdefghijkl', 6)).toBe('abcde…');
  });
});
