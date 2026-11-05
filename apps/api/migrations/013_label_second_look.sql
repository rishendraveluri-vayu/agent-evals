-- SP5, D46: a label given on a second look at a criterion Rishi first marked "unsure". The queue
-- brings such a criterion back once, after the fresh items; the answer then given is stored with
-- second_look true and replaces the "unsure" in the judge agreement (stats/, evals-agreement).
-- labels/<set>.jsonl stays the source: the line carries "second_look": true.
ALTER TABLE labels ADD COLUMN second_look boolean NOT NULL DEFAULT false;
