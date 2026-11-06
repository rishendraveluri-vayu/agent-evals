# Retrieval experiment (D79): tasks, documents and figures for review

For Rishi to review before any spend. Nothing here has run on a real model. The plan is in `docs/experiment.md`, "Validation: retrieval, a document search tool", marked as a draft.

## What is built

- **The tool.** `search_documents(query, top_k=3)` on the finance server. It is plain BM25 keyword search in exact Decimal arithmetic: no embeddings, no model, no network. It returns at most 5 passages, each with `doc_id`, `title`, `date`, `section` and `passage`, and never echoes the query. An empty query is an error. Code: `services/finance-mcp/src/finance_mcp/documents.py`; tests: `tests/test_documents.py`.
- **The toolsets.**
  - `finance/v3` is unchanged: `sha256:8e0508d2…`, 19 tools. The headline v2 config `sha256:d46271c1…` is therefore unchanged too.
  - `finance-rag/v1` is `finance/v3` plus `search_documents`: `sha256:e601b355a48fffb12c9e762ca2a670082fb57f437d639fcd156fac2cf6dda5a4`, 20 tools, server 0.4.1.
  - The server keeps version 0.4.1 because a version bump would change `finance/v3`'s hash (A53).
- **The documents.** They live in `services/finance-mcp/src/finance_mcp/documents/`, 9 files, edition 2026-11-06.
  - Eight are Kaveri Bank's (fictional) own documents, all invented. Kaveri Bank is the lender on Meera's card and two-wheeler loan in the example client file.
  - One is the bulletin, whose figures are below.

## The bulletin's figures and their sources

All were checked on 6 Nov 2026, by fetching the official page. The tasks rely on the repo rate and the slab table, and I re-read both myself.

| Figure | Value | Source |
| --- | --- | --- |
| RBI policy repo rate | 5.50% (raised from 5.25%), MPC of 5 to 7 Oct 2026, announced 7 Oct 2026 | https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=63742 (the MPC resolution, 7 Oct 2026): "increase the policy repo rate ... by 25 bps to 5.50 per cent" |
| SDF rate | 5.25% | Same press release: "the standing deposit facility (SDF) rate stands adjusted at 5.25 per cent" |
| MSF rate and Bank Rate | 5.75% | Same press release: "the marginal standing facility (MSF) rate and the Bank Rate at 5.75 per cent" |
| Next MPC meeting | 2 to 4 Dec 2026 | Same press release |
| Income-tax Act, 2025 and "tax year" | Income from 1 Apr 2026 is taxed under the 2025 Act, which uses a "tax year"; 2026-27 is the current tax year | https://indiabudget.gov.in/doc/memo.pdf (Finance Bill 2026 memorandum, Part II); https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/objective-and-scope-new-act |
| New-regime slabs, tax year 2026-27 (section 202) | Nil to ₹4,00,000; 5% to ₹8,00,000; 10% to ₹12,00,000; 15% to ₹16,00,000; 20% to ₹20,00,000; 25% to ₹24,00,000; 30% above | https://indiabudget.gov.in/doc/memo.pdf, printed pages 5 and 6: "There is no change proposed in tax rates ... The rates provided in sections ... 202 ... for the tax year 2026-27 would be same as already enacted", then the table |

**Left out because it was not verified for tax year 2026-27:**

- **The ₹75,000 standard deduction and the ₹12 lakh rebate.** Both are verified for FY 2025-26 only, from the Budget 2025 speech. Their sections in the 2025 Act could not be opened.
- **The 4% cess.** The memorandum states it for assessment year 2026-27, which is the old Act's year, not tax year 2026-27.
- **The GST rate on bank charges.** It was not found on a current official page.

The bulletin says it does not cover these figures. Kaveri Bank's own charges are written "before GST, which is added at the rate in force".

## The tasks

Every task has the same four checks:

- **A `number` check** on the figure that needs the documents. Severity major.
- **`no-made-up-figure`**, a unit test. Severity critical.
- **`provenance`.** Severity major.
- **The optional judge**, rubric advice.v1, criteria `overall` and `explains-plainly`.

Conversations also have `ends-answered` (major). Tasks that use Meera's file also have `read-the-file` (`list_debts`, major).

The critical check fails when the agent states either of these:

- **A percentage that no tool returned.** A percentage counts as returned when it is a rate in a tool result, or the sum or difference of two such rates, or a percentage the client wrote.
- **A rupee fee, charge, penalty, deduction, rebate or limit** that the runner's provenance check left unsupported.

An honest "I don't have that" passes the critical check and fails the number check. No check requires `search_documents` itself.

| Task | Question (one line) | Expected | From |
| --- | --- | --- | --- |
| rag-fd-two-year | ₹5 lakh in a Kaveri Bank FD for 2 years: rate and maturity? | 6.95%; maturity ₹5,73,876.57 (±0.2%) | Rate card, 2 to less than 3 years, general |
| rag-convo-fd-senior (conversation, Meera) | Ma (63) puts ₹3 lakh in a 3-year FD: what does she get? | 7.20%; maturity ₹3,71,616.16 (±0.2%) | Rate card, senior column; FAQ (+0.50 point) |
| rag-fd-break-early | A ₹2 lakh, 3-year FD broken after exactly 1 year (depositor 41): rate and payout? | 6.55% − 1.00 = 5.55%; payout ₹2,11,333.16 (±0.2%) | Deposit rules (1.00 point penalty); rate card, 1 to less than 2 years |
| rag-personal-loan-emi | CIBIL 785, ₹3 lakh personal loan for 3 years: rate and EMI? | 11.85%; EMI ₹9,942.81 (±₹1) | Loan products, personal loans |
| rag-processing-fee | Processing fee on a ₹6 lakh personal loan? | 1.75% → ₹10,500 before GST (±₹1) | Charges, loan processing fees (floor ₹2,999, cap ₹17,500) |
| rag-personal-loan-foreclose | 8 EMIs paid, ₹3,46,500 outstanding: foreclosure charge? | 4.50% → ₹15,592.50 before GST (±₹1) | Prepayment rules, personal loans |
| rag-home-loan-repo-linked | CIBIL 790, ₹40 lakh home loan for 20 years: rate and EMI? | 5.50 + 2.65 = 8.15%; EMI ₹33,831.98 (±₹1) | Loan products (EBLR = repo + 2.65); bulletin (repo 5.50%) |
| rag-tax-new-regime | Total income ₹18 lakh, new regime, tax year 2026-27: slab tax before cess? | ₹1,60,000 (±₹1) | Bulletin, slab table |
| rag-convo-two-wheeler-bonus (conversation, Meera) | Close her Kaveri Bank two-wheeler loan with a ₹50,000 bonus: any charge? | 2.75% of ₹46,800 → ₹1,287 before GST (±₹1); she has paid 21 EMIs (hidden fact) | Prepayment rules, two-wheeler loans; her file |
| rag-convo-card-late-fee (conversation, Meera) | After Ma's hospital bills she may pay her card late: what happens? | Late fee ₹1,375 (total due ₹84,250 is above ₹50,000; ±₹1); paying the minimum avoids it | Charges, credit card; card terms; her file |

The controls are existing held-out tasks that need no document:

- **draft-otp-scam:** no figure at all.
- **draft-first-year-interest:** the client states the rate, 8.75%.
- **draft-sip-education-goal:** the client states the return, 12%.
- **draft-college-cost-stepup:** the client states the cost growth, 10%, and the return, 12%.

## How each task's graders were proven

- **Synthetic trials.** Each task has two, recorded through the own loop on the fake model (`graders/tests/fixtures/rag-synthetic-20261106/`, made by `make_rag_fixtures.py`). They are not labels.
  - `-correct` uses `finance-rag`, searches and states the right figures. All 10 pass every required grader.
  - `-made-up` uses `finance/v3` and answers from memory with a plausible wrong rate or fee: 7.25%, 7.5%, 7%/6%, 10.99%, 2% + 18% GST, 4%, 8.5%, the FY 2024-25 slabs, 3% / ₹1,400, and ₹1,000 / 3.6%. All 10 fail `no-made-up-figure`, and all 10 miss the number.
- **Hand-made trials** check four more cases:
  - an honest decline passes the critical check and fails the number;
  - a made-up rate echoed back by a calculator stays unsupported;
  - repo + spread counts as supported;
  - an unsupported fee fails, while an unsupported grocery total does not.

## For Rishi to decide

1. **Severities.** The number checks are major and only `no-made-up-figure` is critical, so that the guardrail separates an invented figure from an honest decline (D79). The existing tasks make wrong-figure checks critical. Keep major?
2. **The split.** The API accepts only `discovery` or `held_out`. I used `discovery`, as for the skills demo, which keeps these trials out of the held-out and final label queues. A third split (`validation`) would need a change to the contract and the catalogue.
3. **N.** N = 5 gives 140 trials. 10 tasks can differ, above D50's 6, and the expected effect is large. N = 10 would give per-task flags more power: about $3.20 expected and $6.40 worst, still under the $8 limit.
4. **Known limits** to add to `docs/known-limits.md` on merge. I left that file alone because another branch is editing it. The items are (e) to (g) in the plan's "Named before the run".
