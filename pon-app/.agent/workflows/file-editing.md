---
description: How to safely edit files via terminal (especially with Cyrillic/UTF-8 content)
---

# File Editing via Terminal

## Rule

Do **NOT** use `sed`, `Select-String -replace`, PowerShell `-replace`, or terminal text editors to modify source files.

## Why

These tools break Cyrillic (UTF-8) encoding and produce mojibake. PowerShell string handling is unreliable with multi-byte characters.

## Instead

Write a short **Node.js** or **Python** one-liner/script to modify the file:

### Option A: Inline one-liner

```powershell
node -e "const fs=require('fs'); const f='path/to/file.js'; let txt=fs.readFileSync(f,'utf8'); /* modifications */ fs.writeFileSync(f, txt, 'utf8'); console.log('Done');"
```

### Option B: Temp script (for complex edits)

1. Write a `.js` script to a temp location
2. User executes it via `node temp-script.js`
3. Delete the script after execution

## Important Notes

- The user will execute commands manually in PowerShell — provide the full command ready to paste.
- Always use `'utf8'` encoding in `fs.readFileSync` / `fs.writeFileSync`.
- For line-range deletions, split by `\r?\n`, use `.splice()`, then join with `\n`.
- Always log what was changed so the user can verify.
