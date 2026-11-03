# Agent Evals Platform: instructions for Claude Code

Take-home for an Applied AI Engineer role. Submit by Saturday 7 Nov 2026.
The work plan is `docs/SPEC.md`. Read it before starting any task.

## Roles

Rishi is the architect and designer. He has to explain every part of this system in the next interview round.
You implement what he has agreed. You do not make design calls for him.

- Open decisions are listed in `docs/decisions.md`. Status there is the only thing that counts.
- If a task depends on an open decision, stop. Lay out the options and tradeoffs, then ask. Do not pick a default and carry on.
- Tasks marked **[Rishi designs]** in the spec start with a proposal for him to approve, not with code.
- Scaffolding, setup, boilerplate and tests of agreed behaviour are yours to lead.
- Push back when something looks wrong. Say so plainly, with the evidence.

## How to work

1. Work one sub-project (SP) at a time. Read its section in `docs/SPEC.md`, including its done-when test.
2. Keep scope to the current task. New ideas go in the Parking lot in the spec.
3. Write tests with the code. A task is done only when its tests pass and you have run them.
4. Make small commits, one concern each, with the SP in the subject: `[SP3] resume runs after worker crash`.
5. When you finish a chunk, explain to Rishi what you built and why it works, briefly enough that he can repeat it.
6. Tick the task in `docs/SPEC.md` when it is done, not before.

## Never

- **Never make real LLM calls in tests or CI.** Tests use the fake LLM server. Real calls cost money and need Rishi to ask for them.
- **Never start a real run without Rishi's explicit go-ahead,** including pilots and dev or smoke runs on cheap models, even for a dollar or less (R8). State the expected trials, models and cost first.
- **Never write or infer human labels.** Files under `labels/` hold Rishi's own judgments only. Synthetic examples go in a separate file and are marked synthetic.
- **Never tune a rubric on held-out labels,** or change the analysis plan after seeing experiment results without recording it in `docs/experiment.md` as a deviation.
- **Never delete or overwrite trial results,** and never drop failed trials from analysis silently. Infra failures are labelled and reported.
- **Never turn on LiteLLM's response cache for trials.** It would replay answers, so repeated trials stop being independent samples.
- **Never modify Hermes source.** Pin the SHA and wrap it. Quirks go in `docs/hermes-notes.md` and `docs/known-limits.md`.
- **Never commit secrets.** Keys live in a local `.env`, with names only in `.env.example`.
- **Never present an unrun or unverified result as fact.** Say what you ran and what you did not.

## Keep the docs current

Update these in the same commit as the change that caused the update. The full register is in `docs/SPEC.md`.

| When this happens | Update |
| --- | --- |
| Rishi settles a decision | `docs/decisions.md` |
| You rely on something the brief does not state | `docs/assumptions.md` |
| You find a case where results should not be trusted | `docs/known-limits.md` |
| You learn how Hermes actually behaves | `docs/hermes-notes.md` |
| An interface, the data model, isolation or the stats change | `docs/design.md` |
| You finish a sub-project | `docs/worklog.md` |

## Commands

Fill this in during SP0 with the real commands: start, test, lint, run an experiment, export results.
