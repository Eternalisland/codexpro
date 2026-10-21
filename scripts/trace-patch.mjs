// Parse file sections from retained unified/Git patches. Never infer a file from untrusted code lines.
function patchPath(header, side) {
  const value = header.slice(4).trim();
  if (value === '/dev/null') return null;
  const prefix = side + '/';
  if (value.startsWith(prefix)) return value.slice(prefix.length).replaceAll('\\', '/');
  if (value.startsWith('"' + prefix) && value.endsWith('"')) {
    // Git C-style quoted paths: unsupported escape sequences are not guessed.
    try {
      const decoded = JSON.parse(value);
      if (decoded.startsWith(prefix)) return decoded.slice(prefix.length).replaceAll('\\', '/');
    } catch { /* Leave unrecognised quoted paths unattributed. */ }
  }
  return null;
}

export function patchSections(source) {
  if (typeof source !== 'string' || !source) return [];
  const sections = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const file = current.after || current.before;
    if (file && current.lines.length) {
      sections.push({
        file,
        text: current.lines.join('\n'),
        additions: current.additions,
        deletions: current.deletions,
        hunks: current.hunks
      });
    }
  };
  const start = () => {
    finish();
    current = { lines: [], before: null, after: null, additions: 0, deletions: 0,
      hunks: 0, oldRemaining: 0, newRemaining: 0, inHunk: false };
  };

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      start();
    } else if ((!current || !current.inHunk) &&
        line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') &&
        (!current || current.before !== null || current.after !== null)) {
      // A code line can itself resemble a file header; never split inside a hunk.
      start();
    }
    if (!current) continue;
    current.lines.push(line);
    const headerPair = !current.inHunk && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
    const nextHeader = !current.inHunk && line.startsWith('+++ ') && i > 0 &&
      lines[i - 1].startsWith('--- ');
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (headerPair) {
      current.before = patchPath(line, 'a');
    } else if (nextHeader) {
      current.after = patchPath(line, 'b');
    } else if (hunk) {
      current.inHunk = true;
      current.oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      current.newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.hunks += 1;
    } else if (current.inHunk && line.startsWith('+')) {
      current.additions += 1;
      current.newRemaining -= 1;
    } else if (current.inHunk && line.startsWith('-')) {
      current.deletions += 1;
      current.oldRemaining -= 1;
    } else if (current.inHunk && line.startsWith(' ')) {
      current.oldRemaining -= 1;
      current.newRemaining -= 1;
    }
    if (current.inHunk && current.oldRemaining <= 0 && current.newRemaining <= 0) {
      current.inHunk = false;
    }
  }
  finish();
  return sections;
}

export function sectionForFile(patch, file) {
  const normalized = String(file || '').replaceAll('\\', '/');
  const matches = patchSections(patch).filter((section) => section.file === normalized);
  if (!matches.length) return null;
  return {
    file: normalized,
    text: matches.map((section) => section.text).join('\n'),
    additions: matches.reduce((n, section) => n + section.additions, 0),
    deletions: matches.reduce((n, section) => n + section.deletions, 0),
    hunks: matches.reduce((n, section) => n + section.hunks, 0)
  };
}

export function fileStats(patch) {
  const result = Object.create(null);
  for (const section of patchSections(patch)) {
    if (!section.hunks) continue;
    const count = result[section.file] || { additions: 0, deletions: 0 };
    count.additions += section.additions;
    count.deletions += section.deletions;
    result[section.file] = count;
  }
  return result;
}
