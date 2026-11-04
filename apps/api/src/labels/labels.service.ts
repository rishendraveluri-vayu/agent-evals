import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CreateLabelRequest, JsonObject, LabelCriterion, LabelLine, LabelQueueItem, LabelSet } from '../contract';
import { LABEL_SETS } from '../contract';
import { badRequest, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { sha256Hex } from '../common/hashing';
import { Db } from '../database/db.service';
import { NOT_EXAMPLE_TRIAL } from '../examples/example-guard';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Judge criteria from a task's graders: every grader with kind (or type) `judge` and a
 * `criteria` list of strings or {id, text}. The grader format is SP4's [Rishi designs]; this
 * reads only that much of it.
 */
export function judgeCriteria(task: JsonObject): LabelCriterion[] {
  const graders = Array.isArray(task.graders) ? task.graders : [];
  const out: LabelCriterion[] = [];
  for (const g of graders) {
    if (!isObj(g) || (g.kind !== 'judge' && g.type !== 'judge') || !Array.isArray(g.criteria)) continue;
    for (const c of g.criteria) {
      if (typeof c === 'string') out.push({ id: c, text: c });
      else if (isObj(c) && typeof c.id === 'string') {
        const text = typeof c.text === 'string' ? c.text : typeof c.description === 'string' ? c.description : c.id;
        out.push({ id: c.id, text });
      }
    }
  }
  return out;
}

/** Hermes calls tools mcp__<server>__<name>; the label view shows the bare name so the
 *  harness cannot be told from it. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_]+?__/, '');
}

function labelSet(value: unknown): LabelSet {
  if (typeof value !== 'string' || !(LABEL_SETS as readonly string[]).includes(value)) {
    throw badRequest('invalid_set', `set must be one of ${LABEL_SETS.join(', ')}`);
  }
  return value as LabelSet;
}

/**
 * The blind labelling queue and the label files (SP5). Labels are Rishi's own judgments,
 * entered by him through the UI; this service only appends what he submits to
 * labels/<set>.jsonl, which stays the source, and imports those lines read-only (R14).
 */
@Injectable()
export class LabelsService {
  private readonly logger = new Logger(LabelsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  private file(set: LabelSet): string {
    return path.join(this.config.labelsDir, `${set}.jsonl`);
  }

  /** Imports lines of labels/<set>.jsonl not yet in the table. Lines that do not parse are skipped. */
  async importFile(set: LabelSet): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file(set), 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let l: Partial<LabelLine>;
      try {
        l = JSON.parse(line) as Partial<LabelLine>;
      } catch {
        this.logger.warn(`labels/${set}.jsonl has a line that is not JSON; skipped`);
        continue;
      }
      const trial = typeof l.trial_id === 'string' ? l.trial_id : l.item_id;
      if (typeof trial !== 'string' || typeof l.criterion !== 'string' || !['yes', 'no', 'unsure'].includes(String(l.value)) || typeof l.labelled_at !== 'string') {
        this.logger.warn(`labels/${set}.jsonl has a line without trial, criterion, value or date; skipped`);
        continue;
      }
      await this.db.query(
        `INSERT INTO labels (trial_id, criterion, value, label_set, note, labelled_at, source, line_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (line_sha256) DO NOTHING`,
        [trial, l.criterion, l.value, set, typeof l.note === 'string' ? l.note : null, l.labelled_at, `labels/${set}.jsonl`, sha256Hex(line)],
      );
    }
  }

  /**
   * Agent-labelled trials whose task has judge criteria, not yet fully labelled in this set,
   * in a fixed shuffled order (a hash of set and trial id) so arms are mixed. Optionally
   * limited to one experiment. Nothing that tells the arm apart is included.
   */
  async queue(setInput: unknown, experimentId?: string): Promise<LabelQueueItem[]> {
    const set = labelSet(setInput);
    await this.importFile(set);
    const params: unknown[] = [set];
    // The sets stay disjoint: a trial labelled in one set never appears in another, so tuning
    // labels can never leak into the held-out agreement (SP5, CLAUDE.md: never tune on held-out).
    // A shipped example's trials (SP7) are not labelled here: labels/ holds Rishi's judgments of
    // his own runs, and an example's trials keep the ids they had on the machine they came from.
    let where = `t.status = 'done' AND NOT t.probe AND t.label = 'agent' AND t.result IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM labels o WHERE o.trial_id = t.id AND o.label_set <> $1)
      AND ${NOT_EXAMPLE_TRIAL('t')}`;
    if (experimentId) {
      params.push(experimentId);
      where += ` AND t.experiment_id = $${params.length}`;
    }
    const rows = await this.db.query<{ id: string; result: JsonObject; body: JsonObject; summary: string; done: string[] }>(
      `SELECT t.id, t.result, k.body, k.summary,
              coalesce((SELECT array_agg(DISTINCT l.criterion) FROM labels l WHERE l.trial_id = t.id AND l.label_set = $1), '{}') AS done
       FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
       WHERE ${where}
       ORDER BY md5($1 || ':' || t.id)`,
      params,
    );
    const items: LabelQueueItem[] = [];
    for (const r of rows) {
      const criteria = judgeCriteria(r.body).filter((c) => !r.done.includes(c.id));
      if (!criteria.length) continue;
      items.push({ item_id: r.id, task_summary: r.summary, transcript: transcriptOf(r.result), tool_calls: await this.toolCalls(r.id), criteria });
    }
    return items;
  }

  private async toolCalls(trialId: string): Promise<LabelQueueItem['tool_calls']> {
    const rows = await this.db.query<{ attributes: Record<string, unknown> }>(
      `SELECT attributes FROM spans WHERE trial_id = $1 AND name LIKE 'execute_tool %' ORDER BY start_ns, span_id`,
      [trialId],
    );
    return rows.map(({ attributes: a }) => ({
      name: bareToolName(typeof a['gen_ai.tool.name'] === 'string' ? a['gen_ai.tool.name'] : ''),
      arguments: typeof a['evals.tool.arguments'] === 'string' ? a['evals.tool.arguments'] : null,
      result: typeof a['evals.tool.result'] === 'string' ? a['evals.tool.result'] : null,
      is_error: typeof a['evals.tool.is_error'] === 'boolean' ? a['evals.tool.is_error'] : null,
    }));
  }

  /** Appends one line to labels/<set>.jsonl, with the date, then imports it. */
  async create(body: CreateLabelRequest): Promise<LabelLine> {
    if (!isObj(body)) throw badRequest('invalid_label', 'the body must be a JSON object');
    const set = labelSet(body.set);
    if (typeof body.item_id !== 'string' || !body.item_id) throw badRequest('invalid_label', 'item_id is required');
    if (typeof body.criterion !== 'string' || !body.criterion) throw badRequest('invalid_label', 'criterion is required');
    if (body.value !== 'yes' && body.value !== 'no' && body.value !== 'unsure') throw badRequest('invalid_label', 'value must be yes, no or unsure');
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw badRequest('invalid_label', 'note must be text');
    const [trial] = await this.db.query<{ id: string; body: JsonObject }>(
      `SELECT t.id, k.body FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256 WHERE t.id = $1 AND t.status = 'done'`,
      [body.item_id],
    );
    if (!trial) throw notFound('unknown_item', `no finished trial ${body.item_id} to label`);
    const criteria = judgeCriteria(trial.body);
    if (!criteria.some((c) => c.id === body.criterion)) {
      throw badRequest('unknown_criterion', `${body.criterion} is not one of this task's criteria: ${criteria.map((c) => c.id).join(', ') || 'none'}`);
    }
    const line: LabelLine = {
      item_id: body.item_id,
      trial_id: trial.id,
      set,
      criterion: body.criterion,
      value: body.value,
      note: typeof body.note === 'string' && body.note.trim() ? body.note : null,
      labelled_at: new Date().toISOString(),
    };
    await fs.mkdir(this.config.labelsDir, { recursive: true });
    await fs.appendFile(this.file(set), `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' });
    await this.importFile(set);
    return line;
  }
}

function transcriptOf(result: JsonObject): { role: string; content: string }[] {
  const conv = result.conversation;
  if (!isObj(conv) || !Array.isArray(conv.transcript)) {
    return typeof result.final_answer === 'string' ? [{ role: 'assistant', content: result.final_answer }] : [];
  }
  return conv.transcript
    .filter((m): m is JsonObject => isObj(m) && typeof m.role === 'string' && typeof m.content === 'string')
    .map((m) => ({ role: m.role as string, content: m.content as string }));
}
