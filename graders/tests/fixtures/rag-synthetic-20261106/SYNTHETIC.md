# Synthetic trials, not model output

Scripted agents on the fake model server, recorded through the own loop by
`graders/tests/fixtures/make_rag_fixtures.py` (6 Nov, D79), to prove each retrieval
task's graders: `<task>-correct` (finance-rag, searches the documents) must pass and
`<task>-made-up` (finance/v3, answers from memory) must fail `no-made-up-figure`.
They are not labels and say nothing about how a real model behaves.
