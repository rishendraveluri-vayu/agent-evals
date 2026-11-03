# Experiment

Commit the first three sections before the run, so the git history shows they came first. Record any later change under Deviations.

## Hypothesis

Rishi to write.

## Setup

Axis (D9, 3 Nov): the system prompt, v1 versus v2. v1 runs first on the discovery tasks; trace analysis finds its failures; v2 and this analysis plan are committed before the re-run; v1 and v2 are then compared on held-out tasks not used to find the problems. Everything else is fixed: harness, model, settings, toolset version, simulator settings. To fill in before the run: config hashes, task set version and split sizes, harness SHA, model pins, N and how N was chosen.

## Analysis plan

Primary metric, unit of analysis, paired test, CI method, what counts as noise, how infra failures are handled, and how judge-graded tasks are treated.

## Invariance check

Result of the diff on the first request of each config. Anything beyond the axis is explained here.

## Results

Quality with CIs, per-task deltas, cost, latency and tokens. Raw export: `experiments/<id>/`.

## Trajectories

Two or three inspected trials that explain the difference.

## Conclusion

## Deviations

Anything changed after the plan was committed, and why.
