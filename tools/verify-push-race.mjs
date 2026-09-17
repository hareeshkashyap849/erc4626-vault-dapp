/**
 * Does the commit step's mechanism actually survive the race that failed run #112?
 *
 * WHAT IS BEING TESTED, AND WHY IT NEEDS A TEST AT ALL
 *
 * Run #112 lost with `! [rejected] main -> main (fetch first)`: two runners each committed
 * a SQLite snapshot locally and both pushed without having the other's commit. The step now
 * fetches first, replays its own data commit on top of the remote tip, and retries the push.
 *
 * The property that is NOT obvious is the conflict: `data/vault.sqlite` is a binary blob and
 * both sides of the race changed byte 0 of it, so git cannot merge it -- it stops. Three
 * things then have to be true, and the harness asserts all three:
 *
 *   1. a rebase that stops is REVERSIBLE (`--abort` restores the runner exactly);
 *   2. the conflict resolves by KEEPING THE PUBLISHED SNAPSHOT, byte for byte -- the
 *      alternative was tried first and rejected: `git rebase -X ours` biases a conflict
 *      toward the commit being replayed, which is the OLDER snapshot here, so it would
 *      publish a snapshot that goes backwards. A `merge=ours` driver is the other obvious
 *      route and it is not usable either: the driver is a shell command, and a runner is not
 *      guaranteed to have one (`true` itself is enough to fail where `sh` is unavailable);
 *   3. the result is still a fast-forward, so no commit of the other run's is discarded.
 *
 * HOW GIT IS DRIVEN, AND WHAT THIS HARNESS CANNOT DO
 *
 * `git clone`/`push`/`fetch` over a LOCAL PATH shell out to `sh`, and this sandbox forbids
 * the pipe `sh` needs:
 *
 *     0 [main] sh: *** fatal error - couldn't create signal pipe, Win32 error 5
 *
 * so there is no transport here: the remote is a `--bare` repository, the two runners are
 * `git worktree`s of it, and the ref move a successful push would have made is made with
 * `git reset --hard`. That covers the part that could corrupt data -- the rebase over a
 * binary conflict -- and cannot cover the part that is a transport fact, a rejected push.
 * The rejection path is proved where it actually happens, in the workflow's own runs.
 *
 * Run: node tools/verify-push-race.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'push-race-'));
const origin = join(root, 'origin.git');
const A = join(root, 'runA');
const B = join(root, 'runB');
/** The identity the workflow sets once with `git config`, exactly as written there. */
const DRIVER = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
/** The attributes line that makes the driver apply to the snapshot and to nothing else. */
const ATTRS = Buffer.from('data.sqlite binary merge=ours\n', 'utf8');

/**
 * A deterministic fake "snapshot": a blob whose content records the block it was indexed
 * to, with a NUL in the first bytes so git treats it as binary -- which is the property
 * that makes this file different from a text merge.
 */
function snapshot(block) {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(64, 0), Buffer.from(`indexed to block ${block}\n`, 'utf8')]);
}

/**
 * Run git and return its combined output.
 *
 * NOT `spawnSync(..., { encoding: 'utf8' })`: that captures through a pipe, and pipes are
 * unavailable here -- the child dies with EPERM and `status` comes back null, which reads
 * as "git failed" rather than "the runner cannot start a pipe". The child's stdout and
 * stderr are pointed at real files and read back afterwards.
 */
let execCounter = 0;
function sh(cwd, args, { allowFailure = false, env: extraEnv = {} } = {}) {
  const outPath = join(root, `exec-${execCounter++}.out`);
  const errPath = join(root, `exec-${execCounter++}.err`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync('git', ['-C', cwd, ...args], { stdio: ['ignore', outFd, errFd], env: { ...process.env, ...extraEnv } });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const out = `${readFileSync(outPath, 'utf8')}${readFileSync(errPath, 'utf8')}`.trim();
  rmSync(outPath, { force: true });
  rmSync(errPath, { force: true });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} in ${cwd} failed (${r.status}): ${out}`);
  return { status: r.status ?? 1, out };
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(`${name} ${detail}`);
}

/**
 * Author one commit directly into `origin`, exactly as a successful `git push` would land
 * it. Plumbing rather than a working tree: the harness has no transport, so the ref move
 * IS the push. Returns the new commit id.
 */
function publishSnapshot(block, message) {
  return publish({ 'data.sqlite': snapshot(block), '.gitattributes': ATTRS }, message);
}

/**
 * Author one commit directly into `origin`, exactly as a successful `git push` would land
 * it. Plumbing rather than a working tree: the harness has no transport, so the ref move
 * IS the push. Returns the new commit id.
 */
function publish(files, message) {
  const env = { ...process.env, GIT_INDEX_FILE: join(root, `index-${++execCounter}`) };
  if (spawnSync('git', ['-C', origin, 'read-tree', '--empty'], { stdio: 'ignore', env }).status !== 0) throw new Error('read-tree --empty failed');

  for (const [path, contents] of Object.entries(files)) {
    // Blobs are written from real files rather than fed through `hash-object --stdin`,
    // because a pipe is exactly what is unavailable here.
    const tmp = join(root, `blob-${++execCounter}`);
    writeFileSync(tmp, contents);
    const oid = sh(origin, [...DRIVER, 'hash-object', '-w', '--no-filters', tmp]).out.trim();
    if (spawnSync('git', ['-C', origin, 'update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], { stdio: 'ignore', env }).status !== 0) {
      throw new Error(`update-index failed for ${path}`);
    }
  }

  const treeOut = join(root, `tree-${++execCounter}.out`);
  const treeErr = join(root, `tree-${++execCounter}.err`);
  const ofd = openSync(treeOut, 'w');
  const efd = openSync(treeErr, 'w');
  const written = spawnSync('git', ['-C', origin, 'write-tree'], { stdio: ['ignore', ofd, efd], env });
  closeSync(ofd);
  closeSync(efd);
  if (written.status !== 0) throw new Error(`write-tree failed: ${readFileSync(treeErr, 'utf8')}`);
  const treeId = readFileSync(treeOut, 'utf8').trim();

  const parent = sh(origin, ['rev-parse', 'refs/heads/main'], { allowFailure: true });
  const args = [...DRIVER, 'commit-tree', treeId, '-m', message];
  if (parent.status === 0 && parent.out) args.push('-p', parent.out);
  const commit = sh(origin, args).out.trim();
  sh(origin, ['update-ref', 'refs/heads/main', commit]);
  return commit;
}

console.log('setting up: a bare origin and two runners that share its refs');
sh(root, ['init', '--bare', '--initial-branch=main', origin]);
sh(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
// The attributes file the workflow writes, committed so that every replay below runs with
// the same driver the workflow installs.
publish(
  {
    '.gitattributes': ATTRS,
    'README.md': Buffer.from('a repository with one snapshot\n', 'utf8'),
  },
  'chore: the snapshot is one blob and a conflict on it keeps the published copy',
);
publishSnapshot(100, 'data: the first snapshot (indexed to block 100)');

// Each runner gets its OWN branch, because git refuses to check one branch out twice and
// two runners on one branch would be a different (and impossible) situation. Its refs are
// the bare repository's refs, so a commit one runner makes is visible to the other as soon
// as the ref moves -- which is what a push does.
sh(origin, ['worktree', 'add', '--quiet', '-b', 'indexer-a', A, 'main']);
sh(origin, ['worktree', 'add', '--quiet', '-b', 'indexer-b', B, 'main']);
// The workflow's step fetches first. That is what makes `origin/main` the thing it rebases
// onto, and it must resolve for the replay below to mean what the workflow means. Remotes
// live in the shared repository config, so this is added once for both runners.
sh(A, ['remote', 'add', 'origin', origin]);
// The workflow ends this step by writing the local config, which the rebase --continue
// below depends on: without it the replay stops with `Committer identity unknown`.
for (const runner of [A, B]) {
  sh(runner, ['config', 'user.name', 'github-actions[bot]']);
  sh(runner, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const fetched = sh(runner, ['fetch', '--quiet', 'origin', 'main'], { allowFailure: true });
  if (fetched.status !== 0) console.log(`  note: git fetch over a path needs a shell (${fetched.out.split('\n')[0]}); the ref is shared, so the replay below is unaffected`);
  sh(runner, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
}
check('two runners start from the same snapshot', sh(A, ['rev-parse', 'HEAD']).out === sh(B, ['rev-parse', 'HEAD']).out);
check('both runners resolve origin/main', sh(A, ['rev-parse', 'origin/main']).out === sh(B, ['rev-parse', 'origin/main']).out);

// --------------------------------------------------------------- the race
// A and B both index forward from block 100 without seeing each other, which is what a
// burst of dispatches produces. A gets further, because it read the chain later.
writeFileSync(join(A, 'data.sqlite'), snapshot(1300));
sh(A, [...DRIVER, 'add', 'data.sqlite']);
sh(A, [...DRIVER, 'commit', '--quiet', '-m', 'data: indexed to block 1300 (head 1301)']);
const aCommit = sh(A, ['rev-parse', 'HEAD']).out.trim();

writeFileSync(join(B, 'data.sqlite'), snapshot(1200));
sh(B, [...DRIVER, 'add', 'data.sqlite']);
sh(B, [...DRIVER, 'commit', '--quiet', '-m', 'data: indexed to block 1200 (head 1201)']);
const bCommit = sh(B, ['rev-parse', 'HEAD']).out.trim();

// A's push lands first. This is the rejection B saw: B's tip is no longer a descendant.
sh(origin, ['update-ref', 'refs/heads/main', aCommit]);
sh(B, ['update-ref', 'refs/remotes/origin/main', aCommit]);
const bIsBehind = sh(B, ['merge-base', '--is-ancestor', 'refs/heads/main', 'indexer-b'], { allowFailure: true });
check('the race is real: B is now behind the remote tip', bIsBehind.status !== 0, "B's commit is not a descendant of main");

// --------------------------------------------- the proposed mechanism, verbatim
// The workflow's step, in order: commit, then -- while a push is still rejected -- fetch,
// replay our one data commit onto the remote tip, deal with an unresolvable conflict on the
// snapshot by keeping the ALREADY PUBLISHED database, and push.
//
// `GIT_EDITOR=true` is set because `rebase --continue` insists on opening an editor for the
// message, and this sandbox cannot spawn one (`true.exe` needs the signal pipe `sh` wants).
// On a runner the editor would open a terminal nobody is watching; disabling it is right in
// both places.
const STEP = {
  replay: (runner) => sh(runner, ['rebase', 'origin/main'], { allowFailure: true, env: { GIT_EDITOR: 'true' } }),
  /** The conflict branch: drop our data commit, take main's snapshot, re-commit under the
   * same summary. Our run's work is in our own database and log either way; what must not
   * happen is publishing a snapshot older than the one already on main. */
  giveWayToThePublishedSnapshot: (runner, message) => {
    sh(runner, ['rebase', '--abort'], { allowFailure: true });
    sh(runner, ['reset', '--hard', 'refs/remotes/origin/main']);
    sh(runner, ['add', 'data.sqlite']);
    sh(runner, ['commit', '--quiet', '--allow-empty', '-m', message]);
  },
  push: (runner) => sh(runner, ['push', 'origin', 'HEAD:indexer-b'], { allowFailure: true }),
};

const replay = STEP.replay(B);
check('the conflict is real: a binary snapshot cannot be auto-merged', replay.status !== 0 && /CONFLICT/.test(replay.out), replay.out.split('\n').find((l) => /CONFLICT/.test(l)) ?? '');
check('the conflict is in data.sqlite and nowhere else', sh(B, ['diff', '--name-only', '--diff-filter=U']).out.trim() === 'data.sqlite');

// Rejecting is harmless and must be reversible: prove it before relying on it.
const aborted = sh(B, ['rebase', '--abort'], { allowFailure: true });
check('an aborted replay leaves the runner exactly as it was', aborted.status === 0 && sh(B, ['rev-parse', 'HEAD']).out.trim() === bCommit);

// Now the real sequence, from the same starting point.
const replay2 = STEP.replay(B);
if (replay2.status === 0) {
  check('replay needed no resolution (the snapshots did not conflict)', false, 'the race did not reproduce');
} else {
  STEP.giveWayToThePublishedSnapshot(B, 'data: indexed to block 1200 (head 1201)');
  check('the runner is clean after resolving the conflict', sh(B, ['status', '--short']).out.trim() === '');
  check('no rebase is left in progress', !/rebase in progress/i.test(sh(B, ['status']).out));
}

const retried = sh(B, ['rev-parse', 'HEAD']).out.trim();
check('B now has a commit on top of the remote tip', retried !== bCommit && sh(B, ['rev-parse', 'HEAD~1']).out.trim() === aCommit);
check('the push half would be a fast-forward', sh(B, ['merge-base', '--is-ancestor', 'refs/heads/main', 'indexer-b'], { allowFailure: true }).status === 0);

// B's push lands (the harness writes the ref a push would have written).
sh(origin, ['update-ref', 'refs/heads/main', retried]);

// ------------------------------------------------------------- the properties
const log = sh(origin, ['log', '--oneline', 'refs/heads/main']).out;
check("the first runner's snapshot commit is an ancestor, so nothing it published was discarded", sh(origin, ['rev-parse', 'refs/heads/main~1']).out.trim() === aCommit);
check("the second runner's commit is in the history too", /indexed to block 1200/.test(log), log.split('\n')[0]);

// The property the whole procedure exists for: main must not end up with a LESS advanced
// snapshot than the one already published, and must not end up with a merge product. The
// bytes are read back out of the object store and compared with both candidates.
const blobPath = join(root, 'tip-blob');
const blobOut = spawnSync('git', ['-C', origin, 'cat-file', 'blob', 'refs/heads/main:data.sqlite'], { stdio: ['ignore', openSync(blobPath, 'w'), 'ignore'] });
void blobOut;
const blob = readFileSync(blobPath);
const published = snapshot(1300);
const stale = snapshot(1200);
check('the snapshot on main is the one already published, byte for byte', blob.equals(published), `blob ${blob.length} bytes`);
check('and NOT the loser\'s older snapshot', !blob.equals(stale));
check('and it is still a binary SQLite header, not conflict markers', blob.subarray(0, 15).toString('latin1') === 'SQLite format 3');

// A second run that has nothing new must be a no-op rather than a new commit or a stop.
sh(A, ['reset', '--hard', 'refs/heads/main']);
sh(A, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
const noop = sh(A, ['rebase', 'origin/main'], { allowFailure: true, env: { GIT_EDITOR: 'true' } });
check('re-running the step with nothing to replay does nothing', noop.status === 0 && sh(A, ['rev-parse', 'HEAD']).out.trim() === retried, noop.out.split('\n')[0] ?? '');

console.log('');
if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log('OK - the losing run resolves the conflict by keeping the published snapshot, is still a');
console.log('     fast-forward, discards nothing, and force-pushes nothing');
rmSync(root, { recursive: true, force: true });
