import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CreateLabelRequest, JsonObject, LabelCriterion, LabelLine, LabelQueueItem, LabelSet, TaskSplit } from '../contract';
import { LABEL_SETS, RATER_ID } from '../contract';
import { badRequest, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { sha256Hex } from '../common/hashing';
import { CatalogueService } from '../catalogue/catalogue.service';
import { Db } from '../database/db.service';
import { NOT_EXAMPLE_TRIAL } from '../examples/example-guard';
import { FIRST_RATER, raterId } from './raters';

type Obj = Record<string, unknown>;
/** A trial id as the API mints them (`t_` and base36/hex), with room for test fixtures. */
const TRIAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
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

/** D52: the task split a label set draws from. */
export function splitFor(set: LabelSet): TaskSplit {
  return set === 'tuning' ? 'discovery' : 'held_out';
}

function labelSet(value: unknown): LabelSet {
  if (typeof value !== 'string' || !(LABEL_SETS as readonly string[]).includes(value)) {
    throw badRequest('invalid_set', `set must be one of ${LABEL_SETS.join(', ')}`);
  }
  return value as LabelSet;
}

/**
 * The blind labelling queue and the label files (SP5). Labels are human judgments, Rishi's and
 * the raters he names (D73), entered by each through the UI; this service only appends what they
 * submit to labels/<set>.jsonl, each line with its rater, which stays the source, and imports
 * those lines read-only (R14).
 */
@Injectable()
export class LabelsService {
  private readonly logger = new Logger(LabelsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly catalogue: CatalogueService,
  ) {}

  /**
   * D52: the split a label set goes by is the task's split in tasks/ today, not the split of the
   * version a trial ran on, so a task moved to held-out is never tuning material through its older
   * trials. A task no longer in tasks/ counts as held-out if any version of it ever was.
   * Returns the SQL condition on `k` (the trial's task row) and its two parameters.
   */
  private async splitCondition(params: unknown[], set: LabelSet): Promise<string> {
    const files = (await this.catalogue.taskFiles()).filter((f) => !f.problems.length);
    params.push(files.filter((f) => f.split === 'held_out').map((f) => f.id), files.filter((f) => f.split === 'discovery').map((f) => f.id), splitFor(set));
    const [held, disc, want] = [params.length - 2, params.length - 1, params.length];
    return `(CASE WHEN k.id = ANY($${held}::text[]) THEN 'held_out'
                  WHEN k.id = ANY($${disc}::text[]) THEN 'discovery'
                  WHEN EXISTS (SELECT 1 FROM tasks kv WHERE kv.id = k.id AND kv.split = 'held_out') THEN 'held_out'
                  ELSE k.split END) = $${want}`;
  }

  private file(set: LabelSet): string {
    return path.join(this.config.labelsDir, `${set}.jsonl`);
  }

  /**
   * Imports lines of labels/<set>.jsonl not yet in the table. Lines that do not parse are skipped.
   * A line without a rater was written before D73 and is Rishi's; a line whose rater is not a rater
   * id is skipped, as any other malformed line is.
   */
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
      const rater = l.rater === undefined ? FIRST_RATER : l.rater;
      if (typeof rater !== 'string' || !RATER_ID.test(rater)) {
        this.logger.warn(`labels/${set}.jsonl has a line whose rater is not a rater id; skipped`);
        continue;
      }
      await this.db.query(
        `INSERT INTO labels (trial_id, criterion, value, label_set, note, labelled_at, source, line_sha256, second_look, rater)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (line_sha256) DO NOTHING`,
        [trial, l.criterion, l.value, set, typeof l.note === 'string' ? l.note : null, l.labelled_at, `labels/${set}.jsonl`, sha256Hex(line), l.second_look === true, rater],
      );
    }
  }

  /**
   * Agent-labelled trials of a real model whose task has judge criteria, not yet fully labelled
   * in this set, in a fixed shuffled order (a hash of set and trial id) so arms are mixed.
   * Optionally limited to one experiment. Nothing that tells the arm apart is included.
   * D73: with a rater, "labelled" means labelled by that rater, so each rater has their own queue
   * and second looks, and nothing in it depends on another rater's labels except D52's rule that a
   * trial labelled in one set (by anyone) is offered in no other. Without a rater, any rater's
   * label counts, as before D73.
   */
  async queue(setInput: unknown, experimentInput?: unknown, itemsInput?: unknown, raterInput?: string): Promise<LabelQueueItem[]> {
    const set = labelSet(setInput);
    // E9: a repeated query parameter arrives as a list (`items` twice was a 500).
    for (const [name, v] of [['experiment', experimentInput], ['items', itemsInput]] as const) {
      if (v !== undefined && typeof v !== 'string') throw badRequest('invalid_query', `give ${name} once`, `Send one ${name} parameter${name === 'items' ? ', with the trial ids comma-separated' : ''}.`);
    }
    const experimentId = experimentInput as string | undefined;
    const rater = raterInput === undefined ? null : raterId(raterInput);
    // `items` (comma-separated trial ids) limits the queue to a chosen list, such as the trials a
    // judge panel disagreed on (D71). Every other rule still applies: a listed trial outside the
    // set is simply not offered.
    const items = itemsInput === undefined || itemsInput === '' ? null : (itemsInput as string).split(',').map((s) => s.trim()).filter(Boolean);
    if (items && (items.length > 500 || items.some((id) => !TRIAL_ID.test(id)))) {
      throw badRequest('invalid_items', 'items must be up to 500 comma-separated trial ids', 'Pass trial ids as GET /experiments/:id/trials lists them, for example items=t_abc,t_def.');
    }
    await this.importFile(set);
    const params: unknown[] = [set];
    // The sets stay disjoint: a trial labelled in one set never appears in another, so tuning
    // labels can never leak into the held-out agreement (SP5, CLAUDE.md: never tune on held-out).
    // A shipped example's trials (SP7) are not labelled here: labels/ holds Rishi's judgments of
    // his own runs, and an example's trials keep the ids they had on the machine they came from.
    // A trial whose agent ran on a fake model (`fake/*`) played a script: there is no agent output
    // to judge, so it is left out too.
    // D52: the sets follow the task split, so no task is both tuned on and scored on: tuning takes
    // trials of discovery tasks only; held-out and final take trials of held-out tasks only.
    const split = await this.splitCondition(params, set);
    let where = `${split} AND t.status = 'done' AND NOT t.probe AND t.label = 'agent' AND t.result IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM labels o WHERE o.trial_id = t.id AND o.label_set <> $1)
      AND ${NOT_EXAMPLE_TRIAL('t')}
      AND NOT EXISTS (SELECT 1 FROM configs fc WHERE fc.hash = t.config_hash AND fc.model LIKE 'fake/%')`;
    if (experimentId) {
      params.push(experimentId);
      where += ` AND t.experiment_id = $${params.length}`;
    }
    if (items) {
      params.push(items);
      where += ` AND t.id = ANY($${params.length}::text[])`;
    }
    // D73: only this rater's labels decide what they have seen and settled.
    let byRater = '';
    if (rater) {
      params.push(rater);
      byRater = ` AND l.rater = $${params.length}`;
    }
    // seen: criteria with any label in this set (by this rater, when one is given); settled: those
    // with a firm answer (yes or no) or a second-look answer. A criterion seen but not settled was
    // only ever marked "unsure" (D46).
    const rows = await this.db.query<{ id: string; result: JsonObject; body: JsonObject; summary: string; seen: string[]; settled: string[] }>(
      `SELECT t.id, t.result, k.body, k.summary,
              coalesce((SELECT array_agg(DISTINCT l.criterion) FROM labels l WHERE l.trial_id = t.id AND l.label_set = $1${byRater}), '{}') AS seen,
              coalesce((SELECT array_agg(DISTINCT l.criterion) FROM labels l
                        WHERE l.trial_id = t.id AND l.label_set = $1${byRater} AND (l.value <> 'unsure' OR l.second_look)), '{}') AS settled
       FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
       WHERE ${where}
       ORDER BY md5($1 || ':' || t.id)`,
      params,
    );
    // Fresh criteria first. A criterion marked "unsure" comes back once, after every fresh item, for
    // a firm answer (D46). An item with fresh criteria shows those first; its second look comes on a
    // later load of the queue, so an item is never in the queue twice.
    const fresh: LabelQueueItem[] = [];
    const again: LabelQueueItem[] = [];
    for (const r of rows) {
      const all = judgeCriteria(r.body);
      const unseen = all.filter((c) => !r.seen.includes(c.id));
      const unsure = all.filter((c) => r.seen.includes(c.id) && !r.settled.includes(c.id));
      const [list, criteria, secondLook] = unseen.length ? [fresh, unseen, false] : [again, unsure, true];
      if (!criteria.length) continue;
      list.push({ item_id: r.id, task_summary: r.summary, transcript: transcriptOf(r.result), tool_calls: await this.toolCalls(r.id), criteria, second_look: secondLook });
    }
    return [...fresh, ...again];
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

  /** Appends one line to labels/<set>.jsonl, with its rater and the date, then imports it. */
  async create(body: CreateLabelRequest): Promise<LabelLine> {
    if (!isObj(body)) throw badRequest('invalid_label', 'the body must be a JSON object');
    const set = labelSet(body.set);
    const rater = raterId(body.rater);
    if (typeof body.item_id !== 'string' || !body.item_id) throw badRequest('invalid_label', 'item_id is required');
    if (typeof body.criterion !== 'string' || !body.criterion) throw badRequest('invalid_label', 'criterion is required');
    if (body.value !== 'yes' && body.value !== 'no' && body.value !== 'unsure') throw badRequest('invalid_label', 'value must be yes, no or unsure');
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw badRequest('invalid_label', 'note must be text');
    const params: unknown[] = [body.item_id];
    const split = await this.splitCondition(params, set);
    params.push(set);
    // E11 (6 Nov review): the queue's own rules (queue() above), so a label can only be given to a
    // trial the queue could have offered: not a probe, an agent outcome with a result, not a
    // shipped example's, not a fake model's script, and labelled in no other set (D52).
    const [trial] = await this.db.query<{
      id: string;
      body: JsonObject;
      task_id: string;
      in_split: boolean;
      probe: boolean;
      label: string | null;
      has_result: boolean;
      own: boolean;
      fake: boolean;
      other_set: string | null;
    }>(
      `SELECT t.id, k.body, k.id AS task_id, ${split} AS in_split, t.probe, t.label, t.result IS NOT NULL AS has_result,
              ${NOT_EXAMPLE_TRIAL('t')} AS own,
              EXISTS (SELECT 1 FROM configs fc WHERE fc.hash = t.config_hash AND fc.model LIKE 'fake/%') AS fake,
              (SELECT min(o.label_set) FROM labels o WHERE o.trial_id = t.id AND o.label_set <> $${params.length}) AS other_set
       FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256 WHERE t.id = $1 AND t.status = 'done'`,
      params,
    );
    if (!trial) throw notFound('unknown_item', `no finished trial ${body.item_id} to label`);
    const why = !trial.own
      ? `${trial.id} belongs to a shipped example: labels/ holds judgments of this database's own runs`
      : trial.probe
        ? `${trial.id} is a probe (a prompt check on the fake model), not an agent's answer`
        : trial.fake
          ? `${trial.id} ran on a fake model (fake/*), which plays a script: there is no agent output to judge`
          : trial.label !== 'agent' || !trial.has_result
            ? `${trial.id} has no agent outcome with a result to judge`
            : null;
    if (why) throw badRequest('not_labellable', why, 'Label the items GET /labels/queue offers.');
    if (!trial.in_split) {
      const other = splitFor(set) === 'held_out' ? 'discovery' : 'held-out';
      throw badRequest(
        'wrong_split',
        `${trial.task_id} is a ${other} task, and the ${set} set takes ${splitFor(set) === 'held_out' ? 'held-out' : 'discovery'} tasks only`,
        'Label it in the set its task belongs to: tuning for discovery tasks, held-out or final for held-out tasks.',
      );
    }
    if (trial.other_set) {
      throw badRequest(
        'wrong_set',
        `${trial.id} already has labels in the ${trial.other_set} set, and a trial is labelled in one set only (D52)`,
        `Label it in the ${trial.other_set} set, or pick another item from GET /labels/queue?set=${set}.`,
      );
    }
    const criteria = judgeCriteria(trial.body);
    if (!criteria.some((c) => c.id === body.criterion)) {
      throw badRequest('unknown_criterion', `${body.criterion} is not one of this task's criteria: ${criteria.map((c) => c.id).join(', ') || 'none'}`);
    }
    if (body.second_look !== undefined && typeof body.second_look !== 'boolean') throw badRequest('invalid_label', 'second_look must be true or false');
    const secondLook = body.second_look === true;
    if (secondLook) {
      // D46: a second look answers a criterion marked "unsure" in this set, and only once. D73: by
      // the same rater, so each rater's second looks are their own.
      const [prior] = await this.db.query<{ unsure: number; settled: number }>(
        `SELECT count(*) FILTER (WHERE value = 'unsure' AND NOT second_look)::int AS unsure,
                count(*) FILTER (WHERE value <> 'unsure' OR second_look)::int AS settled
         FROM labels WHERE trial_id = $1 AND criterion = $2 AND label_set = $3 AND rater = $4`,
        [trial.id, body.criterion, set, rater],
      );
      if (!prior.unsure || prior.settled) {
        throw badRequest(
          'not_a_second_look',
          prior.settled
            ? `${body.criterion} on ${trial.id} already has a firm or second-look answer from ${rater} in ${set}`
            : `${body.criterion} on ${trial.id} was not marked unsure by ${rater} in ${set}`,
          'Save it as an ordinary label (leave second_look out).',
        );
      }
    }
    const line: LabelLine = {
      item_id: body.item_id,
      trial_id: trial.id,
      set,
      rater,
      criterion: body.criterion,
      value: body.value,
      note: typeof body.note === 'string' && body.note.trim() ? body.note : null,
      labelled_at: new Date().toISOString(),
      ...(secondLook ? { second_look: true } : {}),
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
