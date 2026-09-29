// lib/bash-file-targets.mjs — which files a Bash command reads / writes.
// The shapes under "real edit shapes" are copied from this repo's own transcripts
// (docs/audits/20260926-154904-session-history-analysis-r2.md §4.1): the extractor that
// preceded this module recovered the target file for 1 of these 6.
import { describe, it, expect } from 'vitest';
import { bashFileTargets, isScratchCommandPath, isTransientPath } from '../lib/bash-file-targets.mjs';

const REPO = '/home/u/dev/proj';
const t = (cmd, cwd = REPO) => bashFileTargets(cmd, { cwd });

describe('bashFileTargets — real edit shapes (R2 §4.1)', () => {
  it('python heredoc assigning a double-quoted absolute path, then writing it', () => {
    const cmd = `python3 - <<'EOF'\np = "${REPO}/hook.mjs"\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF`;
    expect(t(cmd).writes).toEqual([`${REPO}/hook.mjs`]);
  });

  it('python heredoc with a single-quoted path and write_text', () => {
    const cmd = `python3 - <<'EOF'\nfrom pathlib import Path\np = Path('${REPO}/hook.mjs')\np.write_text(p.read_text().replace('x', 'y'))\nEOF`;
    expect(t(cmd).writes).toEqual([`${REPO}/hook.mjs`]);
  });

  it('sed -i on a relative path resolves against cwd', () => {
    expect(t('sed -i "s/a/b/" lib/fast-summary.mjs').writes).toEqual([`${REPO}/lib/fast-summary.mjs`]);
  });

  it('cat >> file <<EOF appends: the target is written, the body is not scanned', () => {
    const cmd = `cat >> tests/fast-summary.test.mjs <<'EOF'\nimport { x } from '../lib/other.mjs';\nEOF`;
    const r = t(cmd);
    expect(r.writes).toEqual([`${REPO}/tests/fast-summary.test.mjs`]);
    expect([...r.reads, ...r.mentions]).toEqual([]);
  });

  it('cd <repo> && sed -i … file: the file, not the repo root', () => {
    const r = t(`cd ${REPO} && sed -i 's/x/y/' hook-llm.mjs`, '/elsewhere');
    expect(r.writes).toEqual([`${REPO}/hook-llm.mjs`]);
    expect([...r.reads, ...r.mentions]).not.toContain(REPO);
  });

  it('perl -0pi -e on an absolute path', () => {
    expect(t(`perl -0pi -e "s/x/y/" ${REPO}/cli.mjs`).writes).toEqual([`${REPO}/cli.mjs`]);
  });
});

describe('bashFileTargets — reads', () => {
  it.each([
    ["sed -n '1,50p' lib/a.mjs", 'lib/a.mjs'],
    ['cat lib/a.mjs', 'lib/a.mjs'],
    ['head -n 40 lib/a.mjs', 'lib/a.mjs'],
    ['tail -20 lib/a.mjs', 'lib/a.mjs'],
    ['nl -ba lib/a.mjs | sed -n 10,20p', 'lib/a.mjs'],
    ['grep -n "foo" lib/a.mjs', 'lib/a.mjs'],
    ["awk 'NR<5' lib/a.mjs", 'lib/a.mjs'],
    ['wc -l lib/a.mjs', 'lib/a.mjs'],
  ])('%s → reads %s', (cmd, rel) => {
    const r = t(cmd);
    expect(r.reads).toEqual([`${REPO}/${rel}`]);
    expect(r.writes).toEqual([]);
  });

  it('grep -e PATTERN: the first operand is a file', () => {
    expect(t('grep -e foo lib/a.mjs lib/b.mjs').reads).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  it('the grep pattern itself is not a file even when it looks like one', () => {
    expect(t('grep -rn "foo.mjs" lib/a.mjs').reads).toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('a directory search yields no file', () => {
    const r = t('grep -rn foo .');
    expect([...r.reads, ...r.writes]).toEqual([]);
  });
});

describe('bashFileTargets — writes', () => {
  it.each([
    ['echo hi > out.json', 'out.json'],
    ['printf x >> notes.md', 'notes.md'],
    ['npm test 2>&1 | tee run.log', 'run.log'],
    ['cp lib/a.mjs lib/b.mjs', 'lib/b.mjs'],
    ['sed -i.bak "s/a/b/" lib/a.mjs', 'lib/a.mjs'],
    ['perl -pi -e "s/a/b/" lib/a.mjs', 'lib/a.mjs'],
    ["node -e \"require('fs').writeFileSync('lib/a.mjs', 'x')\"", 'lib/a.mjs'],
    ['touch lib/new.mjs', 'lib/new.mjs'],
  ])('%s → writes %s', (cmd, rel) => {
    expect(t(cmd).writes).toEqual([`${REPO}/${rel}`]);
  });

  it('an fd duplication does not end the command', () => {
    expect(t('cat lib/a.mjs 2>&1 lib/b.mjs').reads).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  it('2>&1 and >/dev/null are fd plumbing, not files', () => {
    const r = t('npm run build >/dev/null 2>&1');
    expect(r.writes).toEqual(['/dev/null']); // exclusion of /dev/ is the caller's rule
  });
});

describe('bashFileTargets — what it must not claim', () => {
  it.each([
    'git status',
    'npx vitest run',
    'echo "see lib/a.mjs"',
    'echo lib/a.mjs',
    'ls',
    'cd lib',
    'npm run format',
    'gh run list --limit 1',
  ])('%s → no file read, written or mentioned', (cmd) => {
    const r = t(cmd);
    expect([...r.reads, ...r.writes, ...r.mentions]).toEqual([]);
  });

  it('an expansion is skipped rather than guessed', () => {
    expect(t('sed -i "s/a/b/" "$F"').writes).toEqual([]);
    expect(t('cat lib/*.mjs').reads).toEqual([]);
  });

  it('relative paths without a known cwd are dropped', () => {
    expect(bashFileTargets('cat lib/a.mjs').reads).toEqual([]);
    expect(bashFileTargets(`cat ${REPO}/lib/a.mjs`).reads).toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('cd to an unknowable place forgets the cwd', () => {
    expect(t('cd "$DIR" && cat lib/a.mjs').reads).toEqual([]);
  });

  it('a runner operand is a mention, not a read', () => {
    const r = t('npx vitest run tests/foo.test.mjs');
    expect(r.mentions).toEqual([`${REPO}/tests/foo.test.mjs`]);
    expect([...r.reads, ...r.writes]).toEqual([]);
  });

  it('git -C resolves pathspecs against its own directory', () => {
    expect(t('git -C /other/repo add lib/a.mjs').mentions).toEqual(['/other/repo/lib/a.mjs']);
  });

  it('never throws on garbage', () => {
    for (const cmd of ['', '"', "'", '<<', 'a <<EOF', '$(', '`', '> ', null, 42]) {
      expect(() => bashFileTargets(cmd, { cwd: REPO })).not.toThrow();
    }
  });
});

describe('bashFileTargets — views (what PreToolUse recall fires on)', () => {
  it('cat / sed -n / head / tail view a file; grep / wc / awk only read it', () => {
    for (const cmd of ['cat lib/a.mjs', "sed -n '1,9p' lib/a.mjs", 'head lib/a.mjs', 'tail -5 lib/a.mjs']) {
      expect(t(cmd).views, cmd).toEqual([`${REPO}/lib/a.mjs`]);
    }
    for (const cmd of ['grep -n x lib/a.mjs', 'wc -l lib/a.mjs', "awk '{print}' lib/a.mjs"]) {
      expect(t(cmd).views, cmd).toEqual([]);
      expect(t(cmd).reads, cmd).toEqual([`${REPO}/lib/a.mjs`]);
    }
  });

  it('a file that is written is not also a view', () => {
    expect(t('sed -i s/a/b/ lib/a.mjs').views).toEqual([]);
  });
});

describe('isScratchCommandPath / isTransientPath', () => {
  it('/tmp is scratch unless it is inside the project', () => {
    expect(isScratchCommandPath('/tmp/x/a.mjs')).toBe(true);
    expect(isScratchCommandPath('/tmp/x/a.mjs', '/tmp/x')).toBe(false);
    expect(isScratchCommandPath('/tmp/x/a.mjs', '/tmp/x/')).toBe(false);
    expect(isScratchCommandPath('/tmp/xy/a.mjs', '/tmp/x')).toBe(true); // prefix is not containment
    expect(isScratchCommandPath('/dev/null', '/')).toBe(true);
    expect(isScratchCommandPath('/home/u/p/a.mjs')).toBe(false);
  });

  it('harness scratch, tool-results and node_modules are transient wherever they are', () => {
    expect(isTransientPath('/tmp/claude-1000/-p/s/scratchpad/a.md')).toBe(true);
    expect(isTransientPath('/home/u/p/node_modules/x/i.js')).toBe(true);
    expect(isTransientPath('/home/u/.claude/projects/p/s/tool-results/b.txt')).toBe(true);
    expect(isTransientPath('/home/u/p/lib/node_modules.mjs')).toBe(false);
  });
});

// Pre-ship defect review P2-1: a script that only PRINTS (sys.stdout.write,
// process.stdout.write, print(..., file=sys.stderr)) wrote nothing, yet every literal it
// named was classed a write — which silenced error recall on real failures, promoted
// schema reads to importance 3 and made reviewer subagents count as project editors.
// A literal is written only when it is the TARGET of a write call, directly or through a
// variable bound to it; every other literal is a read.
describe('bashFileTargets — interpreter literals: only write TARGETS are writes', () => {
  it.each([
    ['python3 -c "import sys; sys.stdout.write(open(\'tests/foo.test.mjs\').read())"', 'tests/foo.test.mjs'],
    ['node -e "const p=require(\'./package.json\'); process.stdout.write(p.version)"', 'package.json'],
    ['python3 -c "import sys; print(open(\'schema.mjs\').read(), file=sys.stderr)"', 'schema.mjs'],
    ["node -e \"console.log(require('fs').readFileSync('lib/a.mjs','utf8'))\"", 'lib/a.mjs'],
  ])('%s reads %s and writes nothing', (cmd, rel) => {
    const r = t(cmd);
    expect(r.writes).toEqual([]);
    expect(r.reads).toContain(`${REPO}/${rel}`);
  });

  it.each([
    ["python3 - <<'EOF'\np = 'lib/a.mjs'\ns = open(p).read()\nopen(p, 'w').write(s)\nEOF", 'lib/a.mjs'],
    [
      "python3 - <<'EOF'\nfrom pathlib import Path\np = Path('lib/a.mjs')\np.write_text(p.read_text())\nEOF",
      'lib/a.mjs',
    ],
    ["python3 -c \"open('out.json', 'w').write('{}')\"", 'out.json'],
    [
      "node -e \"const fs=require('fs'); const f='lib/a.mjs'; fs.writeFileSync(f, fs.readFileSync(f,'utf8'))\"",
      'lib/a.mjs',
    ],
    ["node -e \"require('fs').writeFileSync('lib/a.mjs', 'x')\"", 'lib/a.mjs'],
    ["python3 -c \"import shutil; shutil.copy('lib/a.mjs', 'lib/b.mjs')\"", 'lib/b.mjs'],
  ])('%s writes %s', (cmd, rel) => {
    expect(t(cmd).writes).toEqual([`${REPO}/${rel}`]);
  });

  it('a patch script reading one file and writing another splits them', () => {
    const cmd = "python3 - <<'EOF'\nsrc = open('lib/a.mjs').read()\nopen('lib/b.mjs', 'w').write(src)\nEOF";
    const r = t(cmd);
    expect(r.writes).toEqual([`${REPO}/lib/b.mjs`]);
    expect(r.reads).toEqual([`${REPO}/lib/a.mjs`]);
  });
});

describe('bashFileTargets — indirect write targets in patch scripts', () => {
  it('a python helper whose first parameter is opened for writing', () => {
    const cmd =
      "python3 - <<'EOF'\ndef edit(path, pairs):\n    s = open(path).read()\n    open(path, 'w').write(s)\nedit('lib/a.mjs', [('x', 'y')])\nsrc = open('lib/b.mjs').read()\nEOF";
    const r = t(cmd);
    expect(r.writes).toEqual([`${REPO}/lib/a.mjs`]);
    expect(r.reads).toEqual([`${REPO}/lib/b.mjs`]);
  });

  it('a JS arrow helper and a JS edit table', () => {
    expect(
      t(
        "node -e \"const fs=require('fs'); const rep=(p,a,b)=>fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace(a,b)); rep('lib/a.mjs','x','y')\"",
      ).writes,
    ).toEqual([`${REPO}/lib/a.mjs`]);
    expect(
      t(
        "node - <<'EOF'\nconst fs=require('fs');\nconst edits=[['lib/a.mjs','x','y'],['lib/b.mjs','p','q']];\nfor (const [f,a,b] of edits) fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(a,b));\nEOF",
      ).writes,
    ).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  it('a read-only helper does not turn its callers into writes', () => {
    const cmd = "python3 - <<'EOF'\ndef show(path):\n    print(open(path).read())\nshow('lib/a.mjs')\nEOF";
    expect(t(cmd).writes).toEqual([]);
  });
});

describe('bashFileTargets — loops over literal lists', () => {
  it.each([
    [
      "python3 - <<'EOF'\nfor p in ['lib/a.mjs', 'lib/b.mjs']:\n    s = open(p).read()\n    open(p, 'w').write(s)\nEOF",
    ],
    [
      "node -e \"const fs=require('fs'); for (const p of ['lib/a.mjs','lib/b.mjs']) fs.writeFileSync(p, fs.readFileSync(p,'utf8'))\"",
    ],
  ])('%s writes both', (cmd) => {
    expect(t(cmd).writes).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });
});

// Pre-ship defect review P3-2: shell keywords and wrapper options are not verbs, and a
// `cd` inside a subshell does not outlive it.
describe('bashFileTargets — keywords, wrappers, subshells', () => {
  it.each([
    ['if true; then sed -i s/a/b/ lib/x.mjs; fi', 'writes'],
    ['for i in 1; do sed -i s/a/b/ lib/x.mjs; done', 'writes'],
    ['{ cat lib/x.mjs; }', 'views'],
    ['! cat lib/x.mjs', 'views'],
    ['sudo -u bob cat lib/x.mjs', 'views'],
    ['timeout -s KILL 5 cat lib/x.mjs', 'views'],
    ['time cat lib/x.mjs', 'views'],
    ['env FOO=1 cat lib/x.mjs', 'views'],
  ])('%s → %s lib/x.mjs', (cmd, field) => {
    expect(t(cmd)[field]).toEqual([`${REPO}/lib/x.mjs`]);
  });

  it('a cd inside a subshell does not leak to the next command', () => {
    expect(t('(cd sub && cat a.js); cat b.js').views).toEqual([`${REPO}/sub/a.js`, `${REPO}/b.js`]);
  });

  it('jq --arg takes a name AND a value', () => {
    expect(t("jq --arg name value '.f' data.json").reads).toEqual([`${REPO}/data.json`]);
  });
});

// Pre-ship delta review P2-A / P3-2..4: indirect write shapes the target attribution
// dropped (the python tuple edit table is this repo's most common multi-file patch), and
// the false writes it still made.
describe('bashFileTargets — delta review shapes', () => {
  it.each([
    [
      "python3 - <<'EOF'\nedits = [('lib/a.mjs', 'x', 'y'), ('lib/b.mjs', 'p', 'q')]\nfor f, old, new in edits:\n    s = open(f).read()\n    open(f, 'w').write(s.replace(old, new))\nEOF",
      ['lib/a.mjs', 'lib/b.mjs'],
    ],
    [
      "python3 - <<'EOF'\nimport pathlib\np = pathlib.Path('lib/x.mjs')\np.write_text(p.read_text())\nEOF",
      ['lib/x.mjs'],
    ],
    [
      "python3 - <<'EOF'\nfrom pathlib import Path\nROOT = Path('.')\np = ROOT / 'lib/x.mjs'\np.write_text(p.read_text())\nEOF",
      ['lib/x.mjs'],
    ],
    [
      "python3 - <<'EOF'\nfiles = ['lib/a.mjs', 'lib/b.mjs']\nfor f in files:\n    open(f, 'w').write('')\nEOF",
      ['lib/a.mjs', 'lib/b.mjs'],
    ],
    [
      "node -e \"const fs=require('fs'); ['lib/a.mjs','lib/b.mjs'].forEach(f=>fs.writeFileSync(f,''))\"",
      ['lib/a.mjs', 'lib/b.mjs'],
    ],
    [
      "node -e \"const fs=require('fs'),path=require('path'); fs.writeFileSync(path.resolve('lib/x.mjs'),'')\"",
      ['lib/x.mjs'],
    ],
    [
      "node -e \"const fs=require('fs'); const w = f => fs.writeFileSync(f,'x'); w('lib/x.mjs')\"",
      ['lib/x.mjs'],
    ],
    ["ruby -e \"File.write('lib/x.rb','x')\"", ['lib/x.rb']],
    ["python3.12 -c \"open('lib/o.json','w').write('{}')\"", ['lib/o.json']],
  ])('%s writes %j', (cmd, rels) => {
    expect(t(cmd).writes).toEqual(rels.map((r) => `${REPO}/${r}`));
  });

  it('a read-only helper sharing a parameter name with a writing helper is not a writer', () => {
    const cmd =
      "python3 - <<'EOF'\ndef show(path):\n    print(open(path).read())\ndef save(path, s):\n    open(path, 'w').write(s)\nshow('lib/a.mjs')\nsave('lib/b.mjs', 'x')\nEOF";
    expect(t(cmd).writes).toEqual([`${REPO}/lib/b.mjs`]);
  });

  it('a read-only table is not written just because something else is', () => {
    const cmd =
      "python3 - <<'EOF'\nimport sys\nchecks = [['tests/a.test.mjs', 3], ['tests/b.test.mjs', 4]]\nopen(sys.argv[1], 'w').write(str(checks))\nEOF";
    expect(t(cmd).writes).toEqual([]);
  });

  it('jq --tab takes no value; time -p is a wrapper', () => {
    expect(t('jq --tab . data.json').reads).toEqual([`${REPO}/data.json`]);
    expect(t('time -p cat lib/x.mjs').views).toEqual([`${REPO}/lib/x.mjs`]);
  });
});

describe('bashFileTargets — dict-keyed edit maps', () => {
  it.each([
    [
      "python3 - <<'EOF'\nedits = {'lib/a.mjs': [('x', 'y')], 'lib/b.mjs': [('p', 'q')]}\nfor p, pairs in edits.items():\n    s = open(p).read()\n    open(p, 'w').write(s)\nEOF",
    ],
    ["python3 - <<'EOF'\nfor p in {'lib/a.mjs': 1, 'lib/b.mjs': 2}:\n    open(p, 'w').write('')\nEOF"],
  ])('%s writes both keys', (cmd) => {
    expect(t(cmd).writes).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });
});

// Round-3 review P3-1 (D#100): a loop's variable was matched to a write target by NAME
// program-wide, so a read-only loop reusing the name became a write.
describe('bashFileTargets — a loop writes only when its own body writes', () => {
  it.each([
    [
      "python3 - <<'EOF'\nchecks = [('lib/a.mjs', 'pat')]\nedits = [('lib/b.mjs', 'x', 'y')]\nfor f, pat in checks:\n    assert pat in open(f).read()\nfor f, a, b in edits:\n    open(f, 'w').write(open(f).read().replace(a, b))\nEOF",
    ],
    [
      "node - <<'EOF'\nconst fs = require('fs');\n['lib/a.mjs'].forEach(f => console.log(fs.readFileSync(f, 'utf8')));\nfor (const f of ['lib/b.mjs']) fs.writeFileSync(f, '');\nEOF",
    ],
    [
      "python3 - <<'EOF'\nfor f in ['lib/a.mjs']:\n    print(open(f).read())\nfor f in ['lib/b.mjs']:\n    open(f, 'w').write('')\nEOF",
    ],
    [
      "node - <<'EOF'\nconst fs = require('fs');\nfor (const f of ['lib/a.mjs']) { console.log(fs.readFileSync(f, 'utf8')); }\n['lib/b.mjs'].forEach(f => { fs.writeFileSync(f, ''); });\nEOF",
    ],
  ])('%s writes lib/b.mjs only', (cmd) => {
    const r = t(cmd);
    expect(r.writes).toEqual([`${REPO}/lib/b.mjs`]);
    expect(r.reads).toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('a python loop whose inline list wraps onto more lines keeps the header indent', () => {
    // From this repo's transcripts: the list's second row is indented past the loop body.
    const cmd =
      "python3 - <<'EOF'\nfor p,a,b in [('lib/a.mjs','x','y'),\n              ('lib/b.mjs','p','q')]:\n    s=open(p).read(); open(p,'w').write(s.replace(a,b))\nEOF";
    expect(t(cmd).writes).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  // Pre-ship review P3-4: the body check must follow a write through a writing helper, a
  // comprehension, and a python suite with a column-0 comment inside it.
  it.each([
    [
      "python3 - <<'EOF'\ndef patch(path, old, new):\n    s = open(path).read()\n    open(path, 'w').write(s.replace(old, new))\nedits = [('lib/a.mjs', 'x', 'y'), ('lib/b.mjs', 'p', 'q')]\nfor f, old, new in edits:\n    patch(f, old, new)\nEOF",
    ],
    [
      "node - <<'EOF'\nconst fs = require('fs');\nconst write = (p) => fs.writeFileSync(p, '');\nfor (const f of ['lib/a.mjs', 'lib/b.mjs']) write(f);\nEOF",
    ],
    [
      "node - <<'EOF'\nconst fs = require('fs');\nfunction rep(f, a, b) { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(a, b)); }\n['lib/a.mjs', 'lib/b.mjs'].forEach((f) => rep(f, 'x', 'y'));\nEOF",
    ],
    [
      "python3 - <<'EOF'\nfiles = ['lib/a.mjs', 'lib/b.mjs']\n_ = [open(f, 'w').write('') for f in files]\nEOF",
    ],
    [
      "python3 - <<'EOF'\nfor p in ['lib/a.mjs', 'lib/b.mjs']:\n    s = open(p).read()\n# keep the header\n    open(p, 'w').write(s)\nEOF",
    ],
    ["python3 - <<'EOF'\nfor p in ['lib/a.mjs', 'lib/b.mjs']: open(p, 'w').write('')\nprint('ok')\nEOF"],
  ])('%s writes both', (cmd) => {
    expect(t(cmd).writes).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  // Delta review P3-7: a JS `for (k in obj) { … }` is not a comprehension — its body is the block.
  it('a JS for-in loop over a bound object writes its keys through the block body', () => {
    const cmd =
      "node - <<'EOF'\nconst fs = require('fs');\nconst edits = {'lib/a.mjs': 1, 'lib/b.mjs': 2};\nfor (k in edits) {\n  fs.writeFileSync(k, '');\n}\nEOF";
    expect(t(cmd).writes).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });

  // Pre-ship review P3-5: the 200 KB shape tests skip indirect resolution entirely, so this one
  // stays under MAX_INDIRECT_PROGRAM and proves (via the write) that the loop path ran.
  it('64 nested loops plus forEach sites under the indirect-resolution cap stay bounded', () => {
    let prog = "x = ['lib/a.mjs']\n";
    for (let i = 0; i < 64; i++) prog += ' '.repeat(i) + 'for f in x:\n';
    const ind = ' '.repeat(64);
    while (prog.length < 60000) prog += ind + "print(open(g).read()); ['lib/c.mjs'].forEach(q => q)\n";
    prog += ind + "open(f, 'w')\n";
    const cmd = `python3 - <<'EOF'\n${prog}EOF`;
    const t0 = performance.now();
    const r = t(cmd);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.writes, 'premise: the loop path ran').toEqual([`${REPO}/lib/a.mjs`]);
  });

  it('a one-line python loop body still counts', () => {
    expect(
      t("python3 - <<'EOF'\nfor p in ['lib/a.mjs', 'lib/b.mjs']: open(p, 'w').write('')\nEOF").writes,
    ).toEqual([`${REPO}/lib/a.mjs`, `${REPO}/lib/b.mjs`]);
  });
});

describe('bashFileTargets — hot-path bound on pathological programs', () => {
  it('200 KB of helper definitions resolves well inside a hook timeout', () => {
    let body = '';
    for (let i = 0; body.length < 200 * 1024; i++)
      body += `def f(path, x):\n    open(path, 'w').write(x)\nf('lib/a${i}.mjs', 1)\n`;
    const t0 = Date.now();
    bashFileTargets(`python3 - <<'EOF'\n${body}EOF`, { cwd: REPO });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// Pre-ship round-3 review P2-1: every pathological shape it timed, each bounded well inside
// the 3 s PreToolUse / 5 s PostToolUse timeouts (the worst read 71.8 s at 200 KB).
describe('bashFileTargets — bounded on every round-3 pathological shape', () => {
  const shapes = [
    'x=[',
    'a = (',
    'for p in [',
    'const f = (p ',
    'for (const p ',
    '].forEach(p',
    'def f(p ',
    'a$',
  ];
  it.each(shapes)('%s x N (200 KB) stays under 500 ms', (frag) => {
    const body = `open(p, 'w')\nx = 'lib/a.mjs'\n${frag.repeat(Math.ceil((200 * 1024) / frag.length))}`;
    const t0 = Date.now();
    bashFileTargets(`python3 - <<'EOF'\n${body}\nEOF`, { cwd: REPO });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
