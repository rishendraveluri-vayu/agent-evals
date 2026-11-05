# The judge's rubric v1 (`configs/rubrics/advice.v1.md`)

Status: **approved 5 Nov (D68).** The draft text below is `configs/rubrics/advice.v1.md`, verbatim
under a `<!-- -->` header, and every judge grader of the 21 tasks reads it; the new criteria and
where they went are in "Criteria for prompt v2's fixes" below. The rest of this section is the
proposal as it was written. Before D68 every task's
judge grader pointed at `open-coding.v0.md`, which is the instruction for Rishi's blind labels, not a
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

## Criteria for prompt v2's fixes (D68, applied 5 Nov)

Prompt v2 (D67) adds three things the deterministic graders cannot see. Without judge criteria for
them, the v1 vs v2 comparison could see only the tool fix. Each criterion is optional, like every
judge criterion, until it passes the trust bar on held-out labels (D8), and each is **major**. A
judge grader has one severity (the most severe of its criteria's), so every judge grader is now
major or critical. Each was placed from the task's own content (its message, hidden facts and
client file), never from a trial's output. Graders only changed, so every task moved one version
up (3, or 4 for the six D63 tasks) with the same core.

- **`explains-plainly`, all 21 tasks:** "Does the advisor explain each key figure in plain words,
  so this client would understand what it means for them? Yes or no." Three tasks get their own
  wording, because a good answer there gives no key figure, and the rubric's rule makes a
  criterion that cannot be answered a no:
  - draft-otp-scam: what the caller could do with the OTP and what to do now, in plain words.
  - draft-distress-helpline: any figure it gives, and the next step, in plain words.
  - draft-mba-loan-missing-info: why each fact it asks for matters to the decision.
- **`clarifies-ambiguous-amount`, 2 tasks, both discovery:** draft-payoff-order and
  draft-convo-payoff. "₹20,000 a month towards my debts" can mean in total, including the
  ₹18,332.50 of minimums, or on top of them; Rishi's notes and the 4 Nov simulator, which played it
  as "on top", show both readings. convo-payoff's version adds "if the client already said which,
  answer yes when the advisor plans on that reading", since its client's hidden fact now says "in
  total".
- **`asks-deciding-fact`, 6 tasks:**
  - draft-car-loan-afford and draft-convo-car (discovery): the down payment, from Rishi's note
    ("what down payment are u considering for the car"); neither the client nor the file gives it.
  - draft-convo-where-to-start (discovery): how much more her mother's care will cost; the file
    shows October only, and the new medicine is a hidden fact.
  - draft-convo-job-loss (held-out): how long she can keep paying depends on severance or other
    money if she is laid off. Neither her opening nor her file holds it; it is a hidden fact the
    advisor has to ask for.
  - draft-convo-phone-loan (held-out): how much sooner he can finish depends on how much extra he
    can pay each month, which only he knows (a hidden fact).
  - draft-convo-consolidation (held-out): whether the offer saves money depends on its rate and
    tenure. The opening gives neither, and no client file can.

**Considered and not added on held-out tasks**, since the content has no such gap:
draft-first-year-interest, draft-college-cost-stepup and draft-sip-education-goal state every term
and ask for a calculation; draft-loan-to-clear-card states the offer's amount, rate and tenure;
draft-spending-review says "on top of what I already pay"; draft-otp-scam's decision hangs on no
missing fact. For draft-prepay-personal-loan I weighed whether "a ₹1 lakh Diwali bonus" means
before or after tax: it matters, since less than ₹84,250 in hand would not clear the card, but the
client's words do not invite the question, so it is not added.

**What follows for the comparison.** Held-out tasks carry `asks-deciding-fact` on three
conversations and `clarifies-ambiguous-amount` on none. So **the comparison can measure v2's
"ask for the deciding fact" fix, but not its "clarify an ambiguous amount" fix**: that half is seen
only on discovery tasks, where v2 was written. The task set is frozen (D65), so this is recorded,
not fixed.

## Open for Rishi (as written before D68)

1. Which of his tuning notes become new criteria, and on which tasks (D7 is still open: which judge
   criteria become required once trusted).
2. Whether the judge gets reference facts (the client file and the expected tool results) as the
   proposal's section 6 suggests; the plumbing takes an optional `reference` today.
3. The "overall" criterion ("Would a real client in this situation be well served by this?") stays
   as the whole-conversation check from his worry list, validated like the others.
