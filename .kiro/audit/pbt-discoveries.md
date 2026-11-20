# PBT Discoveries

Real bugs caught by `fast-check` properties during the Suture build. One row per distinct counterexample. Rows are added by the `pbt-on-core-save` hook and the `pbt-adversary` agent. Only replayable counterexamples (with seed and path) are logged.

| Date | Commit | Property | Shrunk Counterexample | Root Cause & Fix |
|------|--------|----------|-----------------------|------------------|
