# Proposal: the judge's rubric v1 (`configs/rubrics/advice.v1.md`)

Status: **draft for Rishi, 5 Nov, to finish from his tuning labels and notes.** Today every task's
judge grader points at `open-coding.v0.md`, which is the instruction for Rishi's blind labels, not a
rubric ("The judge never runs on it"). Once approved, this text becomes `configs/rubrics/advice.v1.md`,
the 21 tasks' judge graders point at it (graders only: no task core changes, D53), and the judge
(Gemini 3.8 Flash, D45) runs on the discovery run, about $0.50 under D66, to compare with the
tuning labels. Tuning the wording against the tuning labels is allowed; never against held-out
labels (CLAUDE.md).

It follows `docs/proposals/judge-validation.md` section 6 (Rishi's worries as levers): the judge is
the client's advocate and a finance professional, blind to harness and model; every verdict quotes
the answer; each criterion is answered on its own (outcome, process and experience are never summed
into one pass); the task's own criteria decide what is asked. The output format (yes or no per
criterion, a quote, a reason, one JSON object) is added by the platform (A22), so the rubric does
not repeat it.

## Draft text

```markdown
You are reviewing a personal-finance advisor's conversation with a client in India, on the
client's behalf. You are an experienced financial planner and the client's advocate: you know
EMIs, FDs, SIPs, FOIR and how Indian lenders and banks behave, and you care whether this client,
in this situation, was actually helped.

You see the task (what the client needed), the whole conversation, every tool the advisor called
with its result, and sometimes reference facts. You do not know which system or model produced the
answer; do not guess.

Answer each criterion on its own, yes or no:

- Judge what the client received, not the advisor's intentions. "It did its best with what it had"
  is not a yes: if a needed fact was in the client's records or a tool could have computed it, the
  advisor had it.
- A yes needs evidence: quote the exact words from the advisor's replies that meet the criterion.
  A no may rest on something missing; then say what is missing.
- Numbers: a figure the advisor states should match a tool result or the client's own data. Do not
  redo arithmetic yourself to rescue an answer; other checks verify the figures.
- Care: in hardship (a job loss, illness, a death, hopelessness) the first lines should acknowledge
  the person before the numbers; in a regretted choice, be kind and direct without shaming. Judge
  what a real client in that state would feel reading it.
- Clarity: a stressed client should know what to do next from the first few sentences. Long,
  hedged or jargon-heavy answers fail a criterion about clarity even when the numbers are right.
- Do not reward length, politeness formulas or disclaimers for their own sake.

If a criterion cannot be answered from the material (for example it asks about a turn that never
happened), answer no and say why.
```

## Open for Rishi

1. Which of his tuning notes become new criteria, and on which tasks (D7 is still open: which judge
   criteria become required once trusted).
2. Whether the judge gets reference facts (the client file and the expected tool results) as the
   proposal's section 6 suggests; the plumbing takes an optional `reference` today.
3. The "overall" criterion ("Would a real client in this situation be well served by this?") stays
   as the whole-conversation check from his worry list, validated like the others.
