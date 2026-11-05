# Proposal: prompt v2 (finance-advisor), from the discovery traces only

Status: **approved by Rishi, 5 Nov (D67)**, as `configs/prompts/finance-advisor.v2.md`, with two additions from his tuning labels (clarify before assuming; explain each key figure plainly). Not in `configs/prompts/` yet: once approved, it becomes
`configs/prompts/finance-advisor.v2.md` and is committed with the analysis plan before the final
run (D9). Written only from the v1 discovery run on the 11 discovery tasks
(`e_0mw33tqo41489091e4da80c75`, `docs/experiment.md`, "Discovery"); no held-out output was read.
Rishi's tuning labels and notes from that run may add to it before it is final.

## What the traces show

v1 already uses the tools for the main calculations (EMIs, payoff plans, affordability), and in 13
of 33 trials it used the new arithmetic tools too. It slips on the figures around them:

1. **Totals summed by hand over many records.** "Groceries: ₹8,086.25", "Mother's medicines and
   consultations: ₹6,880": right, but added up from the transaction list in its head.
2. **Rounded estimates.** "That leaves about ₹33,000" (92,500 − 59,114.15 = 33,385.85), "roughly
   ₹35,400 a year in interest" (₹84,250 at 42%), "about ₹59,100".
3. **Arithmetic done in its head, done wrong.** convo-payoff: "It also adds roughly ₹7,100 in
   interest", then in the next turn: "I need to correct my last answer. The ₹7,100 undercounted the
   cost… about ₹13,800 more interest in total."
4. **Where.** Mostly in the conversations, in second and later replies (convo-payoff 0 of 3,
   convo-where-to-start 0 of 3), and in follow-ups ("missing one month pushes you back…").

39 of 553 figures were unsupported, 55 were correct prose arithmetic, 29 came from an arithmetic
tool. 11 of the 12 failed trials failed on provenance.

## The change (the only difference between v1 and v2)

v2 is v1 with its first bullet under "How you work" replaced by the block below; everything else
is byte-identical.

```markdown
- **Every rupee figure you write comes from a tool, exactly.** Calculate with your finance tools,
  and do the small sums with them too: to total several items (a month's groceries, all the EMIs),
  pass them to `add`; for what is left over, `subtract`; for a year of a monthly amount,
  `multiply`; for a share, `percent_of`. If a figure needs two steps, make two calls. Write the
  number the tool returned; if you want a round number, round it with `round` and say it is
  rounded. Never write "about", "roughly" or "around" before an amount you worked out yourself.
  This holds in every reply, including follow-ups and corrections. If no tool fits, say what you
  would need instead of guessing.
```

Why this and nothing else: the hypothesis (`docs/experiment.md`) expects the gain from using the
tools for every figure and from care in hardship conversations. The discovery run showed the first
clearly and no care failure on the deterministic checks (distress-helpline and convo-distress passed
3 of 3); whether care needs a change waits for Rishi's tuning labels and notes. One change keeps the
result readable: if v2 wins, the trace shows why.

## Risks

- **More tool calls per trial,** so more steps and tokens; conversations already use 9 to 13 model
  calls of the 24-step cap. The behaviour panel (D64) shows steps and step-limit hits per arm.
- **Tool names in the prompt.** The arithmetic tools are named plainly (`add`, `subtract`, ...);
  Hermes sees them as `mcp__finance__add`. The names are the server's own, the same in every
  harness, so the prompt stays byte-identical across harnesses (v1's rule).
- **It could over-correct:** refusing to give a quick figure the client asked for, or long answers
  full of exact paise. The 250-word guidance stays.
