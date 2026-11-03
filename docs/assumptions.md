# Assumptions

The brief says to document every assumption. One line each: the assumption, why, and what changes if it's wrong.

| # | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| A1 | One local user: no auth or multi-tenancy | Local one-command run, scope cut | Add auth at the API layer |
| A2 | One machine: no multi-node workers | Local one-command run, scope cut | Workers need remote claim support |
| A3 | Configs and tasks live as files in git, plus a simple form | Versioning comes free, scope cut | Add editors |
| A4 | Polling is enough for run progress | The brief doesn't require live updates | Add SSE or WebSocket |
