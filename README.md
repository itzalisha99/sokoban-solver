# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/itzalisha99/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/itzalisha99/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) (21 November 2026). One program answers a whole set of 5 generated levels in a single run.

## How it works

Every generated level is a one-square-wide hallway with 1–4 small rooms off it. A box pushed through a room's door into the hallway can never be pushed back, so every box stays in its room and the rooms are independent: the level's push-optimal count is the sum of its rooms' optima.

- **Room split** — the hallway row's dead squares (floor from which no box can reach a goal) are cut out, and each remaining component holding boxes is a room.
- **Push-optimal A\*** — each room (3–4 boxes) is solved with A\* over *pushes*, not moves. The heuristic is the minimum-assignment sum of grid distances from boxes to goals, which is admissible and consistent, so the first solution found uses the fewest pushes possible.
- **Deadlock pruning** — a box may only be pushed onto a "live" square (found by pulling boxes back from the goals), and pushes that create a frozen 2×2 block of walls and boxes are pruned.
- **Deterministic by construction** — the search budget is counted in states expanded, never in wall-clock time, so two runs write byte-identical answers. The whole practice set solves in under a second.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` for each instance and writes `/output/<id>/solution.txt` (player moves in `u`, `d`, `l`, `r`; an upper-case letter marks a push). Locally:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Results

- Practice set: **1,000,000 / 1,000,000** — all 5 instances solved in their push-optimal counts (13, 16, 29, 47, 60 pushes).
- 10 freshly generated sets (new random seeds, same generator): **1,000,000 on all 10**, every instance push-optimal, each set under ~1.1s (limit: 60s).
- House baseline (plain-astar 1.0.0) on the practice set: 200,000.

Built with Muse for the make.fun bounty. Referral code: `y05d5qm6`.
