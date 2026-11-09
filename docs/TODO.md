# To do

Work that is known and not done yet, each with what "done" means. Finished items are deleted here and
described in their commit / the release notes.

## Prove the test suite under one-core CPU starvation (Linux)

**Why:** a timing-dependent test must fail on the developer's machine first, not on a slower CI runner.
On macOS (2026-11-09, Mac Mini) the suite under `taskpolicy -c background` passed 4 of 5 isolated runs;
the fifth stretched the whole run to ~101 s and three pipeline tests hit the 5 s per-test timeout. None
of those tests has a race or a wall-clock assertion — the process stalled — but macOS's background QoS
throttles far harder than the documented Linux one-core run, so it proves little either way.

**Do (on the Linux PC):**

```sh
cd ~/Projects/claude-progress-panel && git pull && mise install
for i in $(seq 1 20); do
  systemd-run --user --scope -q --slice=claude-build.slice -p CPUQuota=100% -- \
    nice -n 19 taskset -c 0 mise exec -- claude plugin test . > /tmp/pp-starved-$i.log 2>&1 \
    && echo "run $i ok" || echo "run $i FAILED"
done
```

**Done when:** 20 of 20 runs pass. A failure: find the shared state or the timing it depends on and fix
it at the root (deterministic clocks via `mock.clock`, a readiness signal) — no retries, no longer
timeouts — then repeat the 20 runs. Record the result in the commit that closes this item.
