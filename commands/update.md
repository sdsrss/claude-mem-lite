---
description: "Auto-maintain memory and resource registry — deduplicate, merge, decay, cleanup, reindex. Use when: search results seem noisy, after bulk imports, or during periodic maintenance"
---

# Memory & Registry Maintenance

Run intelligent maintenance on both the memory database and tool resource registry.

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
6. **If pending purge items > 0**: Report the count to the user and ask for confirmation. If confirmed, call `mem_maintain(action="execute", operations=["purge_stale"])`. User may optionally specify `retain_days` (default 30) to control how many days of data to keep. Do NOT purge without explicit user confirmation.

### Phase 2: Registry Maintenance

1. Call `mem_registry(action="stats")` to get registry overview
2. Call `mem_registry(action="reindex")` to rebuild FTS5 search index
3. Report updated stats

### Phase 3: Summary

Summarize all maintenance actions taken in zh-CN:
- Memory: observations cleaned, decayed, boosted, deduplicated, compressed
- Registry: total resources, adoption rates, reindex status
- Overall health assessment
