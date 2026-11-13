// Heap-budget probe for AI-1960 worker scopes (owner amendment, Decision 9):
// spawned as `node --expose-gc test-helpers/worker-scope-heap.js` by
// test/worker-scopes-caps.test.js. Builds the opted structures at GLOBAL
// saturation (1,024 worker ids / 2,048 worker-scoped sessions, each record
// carrying a pin and a per-bucket latest sequence) and prints the forced-GC
// heapUsed delta as JSON on one line. Exits non-zero if it cannot measure —
// the budget test must never silently skip.
import { SessionTracker, MAX_WORKERS_GLOBAL, MAX_WORKER_SESSIONS_GLOBAL } from '../src/session-tracker.js';

if (typeof globalThis.gc !== 'function') {
  console.error('globalThis.gc unavailable: spawn with --expose-gc');
  process.exit(2);
}

const measure = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
};

// A scoped pin key in the internally generated shape (see conversation.js
// workerScopedPinKey), long enough to stand for a real one (session id +
// conversation digest).
const pinKeyFor = (c, w, s) =>
  `w:${'ab'.repeat(16)}\x00${`sess-${c}-${w}-${s}-`.padEnd(120, 'x')}${'y'.repeat(22)}`;
const workerId = (w) => `w1_${String(w).padStart(32, '0')}`;
const keyHash = (c) => `${String(c).padStart(64, 'f')}`;

const before = measure();

const st = new SessionTracker();
// 16 clients x 64 workers x 2 sessions = the global caps exactly: 1,024 worker
// ids and 2,048 worker-scoped sessions.
let workers = 0;
let sessions = 0;
for (let c = 0; c < 16; c++) {
  for (let w = 0; w < 64; w++) {
    for (let s = 0; s < 2; s++) {
      const pin = pinKeyFor(c, w, s);
      if (!st.admitWorkerScope(keyHash(c), workerId(w), pin)) {
        console.error(`admission refused below the caps at c=${c} w=${w} s=${s}`);
        process.exit(3);
      }
      st.beginRequest(pin);
      const seq = st.allocatePinSeq(pin, 'unified7d');
      st.touch(pin, 0, 'unified7d', undefined, seq);
      st.endRequest(pin);
      sessions += 1;
    }
    workers += 1;
  }
}

const counts = st.workerScopeCounts();
if (counts.workers !== MAX_WORKERS_GLOBAL || counts.sessions !== MAX_WORKER_SESSIONS_GLOBAL) {
  console.error(`saturation not reached: ${JSON.stringify(counts)}`);
  process.exit(4);
}

const after = measure();
console.log(JSON.stringify({ before, after, delta: after - before, workers, sessions }));
