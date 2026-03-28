---
description: "Recall past observations for a file before editing. Use when: about to edit a file, investigating a file with past issues, or before refactoring to check for past lessons"
argument-hint: <file_path>
---

## File Memory
!`claude-mem-lite recall $ARGUMENTS 2>/dev/null || echo "No history found"`

Consider these past observations before making changes.
