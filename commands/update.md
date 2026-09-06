---
name: update
description: "Use when: search results seem noisy or for periodic memory maintenance"
---

# Memory Maintenance

Run intelligent maintenance on the memory database.

## Usage

- `/mem:update` — Run full maintenance cycle

## Instructions

When the user invokes `/mem:update`, perform the following maintenance cycle:

### Phase 1: Memory Maintenance

1. Call `mem_maintain(action="scan")` to analyze maintenance candidates
2. Report scan results to the user (duplicates, stale items, broken items, boostable items, **pending purge** items)
3. Call `mem_maintain(action="execute", operations=["cleanup","decay","boost"])` to apply safe automatic changes
4. If duplicates were found in scan, review them and call `mem_maintain(action="execute", operations=["dedup"], merge_ids=[[keepId, removeId1, ...], ...])` — keep the more important/recent observation in each pair
5. Run `mem_compress(preview=false)` for old low-value observations
6. **If pending purge items > 0**: Report the count to the user and ask for confirmation. If confirmed, call `mem_maintain(action="execute", operations=["purge_stale"], confirm=true)`. **`confirm=true` is required:** without it the call returns a dry-run preview and deletes nothing while still succeeding, so you would report a purge that never happened. User may optionally specify `retain_days` (default 30, allowed range 7–365) to control how many days of data to keep. Do NOT purge without explicit user confirmation.

### Phase 2: Summary

Summarize all maintenance actions taken in zh-CN:
- Memory: observations cleaned, decayed, boosted, deduplicated, compressed
- Overall health assessment
