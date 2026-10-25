# Usage and spend

The Usage tab (notch and board) shows a card per engine, **only for engines that at least one agent uses**. With
only Claude Code agents you see only Claude Code.

| Engine | Shows | Source |
|---|---|---|
| Claude Code | $ today, last 7 days, this month · running now · number of agents | `total_cost_usd` from each run's result event |
| Codex | Tokens today (input + output) · running now · number of agents | `turn.completed` usage; Codex doesn't report cost |

Important:

- **Claude Code cost is the API-equivalent price.** On a Pro/Max plan you aren't billed that amount. It counts
  toward your plan's limits, so treat it as a measure of how much you're using.
- Amounts under one cent show as `<$0.01`.
- Windows are in local time: today since midnight, 7 days rolling, month since the 1st.
- Only runs made by Hive agents are counted, not your own Claude Code / Codex sessions.

Budgets and alerts per agent are planned for step 4 ([roadmap.md](roadmap.md)).
