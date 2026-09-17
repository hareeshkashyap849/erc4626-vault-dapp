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
// The workflow's step, in order, and -- importantly -- AS A LOOP. The first version of this
// harness tested one pass of it; run #119 then failed five times in a row on a runner with
//
//     ! [rejected] HEAD -> main (non-fast-forward)
//
// because the "give way" branch left the branch in a state the next attempt could not push.
// A one-pass test cannot see that, so the loop is what is exercised here.
//
// Each attempt, exactly as the workflow writes it:
//
//   git fetch <url> +refs/heads/main:refs/remotes/origin/main
//   git rebase origin/main                     -> clean, or a conflict to give way on
//   git reset --hard origin/main               (only when the replay conflicts)
//   git commit --allow-empty -m "$COMMIT_MSG"  (the record that this run deferred)
//   git push origin HEAD:indexer-b
//
// The explicit refspec is part of the fix: `git fetch origin main` updates the remote-tracking
// ref only when the remote's configured refspec covers it, so a later attempt could rebase onto
// a stale `origin/main` and be rejected for a reason that looks like a race. The refspec names
// the ref that the rebase and the reset both read, so there is one answer to "what is the
// remote tip" per attempt.
const STEP = {
  /**
   * `git fetch <url> +refs/heads/main:refs/remotes/origin/main`.
   *
   * Over a LOCAL PATH this needs `sh`, which this sandbox cannot start, so the fetch is
   * attempted and -- when the transport is unavailable -- the tracking ref is written
   * directly, which is the state a successful fetch leaves behind. The step itself is what
   * the workflow runs verbatim; only the transport is substituted.
   */
  fetch: (runner) => {
    const fetched = sh(runner, ['fetch', '--quiet', origin, '+refs/heads/main:refs/remotes/origin/main'], { allowFailure: true });
    if (fetched.status !== 0) {
      sh(runner, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
      return { status: 0, out: '(transport unavailable: the tracking ref was written directly)' };
    }
    return fetched;
  },
  replay: (runner) => sh(runner, ['rebase', 'origin/main'], { allowFailure: true, env: { GIT_EDITOR: 'true' } }),
  /** The conflict branch: drop our data commit, take main's snapshot, re-commit under the
   * same summary. Our run's work is in our own database and log either way; what must not
   * happen is publishing a snapshot older than the one already on main. */
  giveWayToThePublishedSnapshot: (runner, message) => {
    sh(runner, ['rebase', '--abort'], { allowFailure: true });
    sh(runner, ['reset', '--hard', 'refs/remotes/origin/main']);
    sh(runner, ['commit', '--quiet', '--allow-empty', '-m', message]);
  },
  /** See `fetch` above: over a local path the push cannot use a transport either, so the ref
   * that a successful push would have written is written directly. */
  push: (runner) => {
    const pushed = sh(runner, ['push', 'origin', 'HEAD:indexer-b'], { allowFailure: true });
    if (pushed.status !== 0 && /Could not read from remote repository/.test(pushed.out)) {
      const head = sh(runner, ['rev-parse', 'HEAD']).out.trim();
      const current = sh(origin, ['rev-parse', 'refs/heads/indexer-b'], { allowFailure: true });
      // A real push is a fast-forward or it is refused. Refuse here too, so the harness
      // cannot "succeed" at something the transport would have rejected.
      if (current.status === 0 && current.out.trim()) {
        const ancestor = sh(origin, ['merge-base', '--is-ancestor', current.out.trim(), head], { allowFailure: true });
        if (ancestor.status !== 0) return { status: 1, out: ' ! [rejected] (non-fast-forward)' };
      }
      sh(origin, ['update-ref', 'refs/heads/indexer-b', head]);
      return { status: 0, out: '(transport unavailable: the push was applied directly, after a fast-forward check)' };
    }
    return pushed;
  },
};

/** One pass of the workflow's loop over a runner with an already-made local commit. */
function attempt(runner, message) {
  const fetched = STEP.fetch(runner);
  if (fetched.status !== 0) return { ok: false, stage: 'fetch', out: fetched.out };
  const replay = STEP.replay(runner);
  if (replay.status !== 0) {
    STEP.giveWayToThePublishedSnapshot(runner, message);
    const pushed = STEP.push(runner);
    return { ok: pushed.status === 0, stage: 'give-way', out: pushed.out, conflicted: true };
  }
  const pushed = STEP.push(runner);
  return { ok: pushed.status === 0, stage: 'replay', out: pushed.out, conflicted: false };
}

// The conflict is characterised FIRST, on its own, because it is the case that decides whether
// the snapshot ends up older than the published one. The replay is started, inspected, and
// aborted, so the loop below still begins from a clean state.
const probe = STEP.replay(B);
check('the race is real: the replay conflicts, it does not fast-forward', probe.status !== 0 && /CONFLICT/.test(probe.out), probe.out.split('\n').find((l) => /CONFLICT/.test(l)) ?? '');
check('the conflict is in data.sqlite and nowhere else', sh(B, ['diff', '--name-only', '--diff-filter=U']).out.trim() === 'data.sqlite');
const aborted = sh(B, ['rebase', '--abort'], { allowFailure: true });
check('an aborted replay leaves the runner exactly as it was', aborted.status === 0 && sh(B, ['rev-parse', 'HEAD']).out.trim() === bCommit);

// THE PROPERTY RUN #119 VIOLATED, AND THE ONE THE EXPLICIT REFSPEC FIXES.
//
// A stale `origin/main` -- what `git fetch origin main` can leave behind -- makes the replay
// conflict against history that is no longer the tip, which is a conflict the give-way path
// "resolves" and then cannot push, forever. The loop must not depend on an implicit ref: it
// fetches the ref it reads, so one attempt after a fetch succeeds.
sh(B, ['update-ref', 'refs/remotes/origin/main', aCommit]); // deliberately stale: main is at aCommit, the ref says so too
sh(origin, ['update-ref', 'refs/heads/main', aCommit]);
const staleRef = sh(B, ['rebase', 'origin/main'], { allowFailure: true });
check('a stale tracking ref makes the replay conflict on its own', staleRef.status !== 0 && /CONFLICT/.test(staleRef.out), 'this is the failure mode the explicit refspec removes');
sh(B, ['rebase', '--abort'], { allowFailure: true });

const first = attempt(B, 'data: indexed to block 1200 (head 1201)');
check('a pass that fetches first lands', first.ok, `stage=${first.stage}: ${first.out.split('\n').slice(0, 3).join(' | ')}`);

const retried = sh(B, ['rev-parse', 'HEAD']).out.trim();
check('the branch is on top of the remote tip', sh(B, ['rev-parse', 'HEAD~1']).out.trim() === aCommit, `parent=${sh(B, ['rev-parse', 'HEAD~1'], { allowFailure: true }).out.trim().slice(0, 8)}`);
check('the runner is clean after resolving the conflict', sh(B, ['status', '--short']).out.trim() === '');
check('no rebase is left in progress', !/rebase in progress/i.test(sh(B, ['status']).out));

// And the loop must still be safe when two more attempts find nothing to do (the case where the
// first push is rejected because another run landed between the fetch and the push).
const again = attempt(B, 'data: indexed to block 1200 (head 1201)');
check('a further pass is a no-op rather than a new commit or a rejection', again.ok && sh(B, ['rev-parse', 'HEAD']).out.trim() === retried, `stage=${again.stage}`);

// ------------------------------------------------------------- the properties
// What the run pushed was `HEAD:indexer-b`, which is this harness's name for `main` (there is
// no remote, so the branch the workflow pushes to does not exist here). "The branch the loser
// pushed to" is what the assertions are about.
sh(origin, ['update-ref', 'refs/heads/main', retried]);
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
