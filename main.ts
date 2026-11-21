// Sokoban solver: push-optimal A* over pushes, room by room.
//
// Idea (my own implementation): a generated level is a one-wide hallway
// with 1-4 small rooms off it. A box pushed out of a room's door into the
// hallway can never come back, so every box stays in its room and the
// rooms are independent: the level optimum is the sum of the room optima.
// Each room (3-4 boxes, ~6x6) is solved push-optimally with A* over
// pushes, then the room solutions are joined by the player's walks.
//
// Search details, per room:
//  - States are (sorted box squares, player square). Two states with the
//    same boxes and the same player-reachable region are one state.
//  - Cost is pushes. The heuristic is the minimum-assignment sum of
//    grid distances (box square -> goal, ignoring other boxes), which is
//    admissible and consistent: one push moves one box one square.
//  - Deadlock pruning: a box may only be pushed onto a "live" square
//    (a square from which a lone box can still reach a goal, found by
//    pulling boxes back from the goals), and a push that creates a frozen
//    2x2 block of walls/boxes with a box off its goal is pruned.
//  - The search budget is counted in states expanded, never in wall
//    clock time, so two runs write identical bytes.
//  - Moves between pushes are shortest walks (BFS, fixed direction
//    order u, d, l, r), so the whole answer is deterministic.
//
// Fallback: if the level does not split into rooms, the same A* runs on
// the whole level (with a per-box nearest-goal heuristic). If a search
// exhausts its node budget the level is left empty (valid format, 0).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed direction order: up, down, left, right. Deterministic everywhere.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

// Node budgets (states expanded). Work, never the clock.
const ROOM_EXPANSION_CAP = 400_000;
const WHOLE_EXPANSION_CAP = 400_000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

// Squares from which a lone box can still be pushed onto some goal:
// pull boxes back from the goals over open floor (ignoring other boxes).
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d; // the square the box is pulled back onto
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Grid distance (in pushes, ignoring other boxes) from every square to
// each goal, by BFS over floor squares.
function goalDistances(w: number, wall: Uint8Array, goals: number[]): Int32Array[] {
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

// Minimum-assignment sum of box->goal distances (boxes <= 4: brute-force
// permutations in fixed order). Admissible: each push moves one box one
// square, so it can lower this sum by at most 1.
function assignmentHeuristic(
  boxes: number[],
  dists: Int32Array[],
  perms: number[][],
): number {
  let best = Infinity;
  for (const perm of perms) {
    let s = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = dists[perm[i]]![boxes[i]]!;
      if (d < 0) {
        s = Infinity;
        break;
      }
      s += d;
    }
    if (s < best) best = s;
  }
  return best;
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(n);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

// Shortest walk from `from` to `to` around walls and boxes, lower-case
// letters, fixed direction order (first direction first on ties).
function walkTo(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = LETTER[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p]! + s;
  return s;
}

type SearchResult = { pushes: number; moves: string } | null;

// Push-optimal A* over pushes for one (sub)level. `goals` are this
// sublevel's goals only; `boxes` its boxes; the player starts at `player`.
// Returns the moves (lower = walk, upper = push) or null on budget loss.
function solvePushAStar(sub: Level, cap: number): SearchResult {
  const { w, wall, goals } = sub;
  const n = wall.length;
  const goalSet = new Uint8Array(n);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  const dists = goalDistances(w, wall, goals);
  const nb = sub.boxes.length;
  if (sub.boxes.some((b) => !live[b])) return null;
  const useAssignment = nb <= 4 && nb === goals.length;
  const perms = useAssignment ? permutations(nb) : [];

  const heuristic = (boxes: number[]): number => {
    if (useAssignment) return assignmentHeuristic(boxes, dists, perms);
    let s = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const d of dists) if (d[b]! >= 0 && d[b]! < m) m = d[b]!;
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);
  if (solved(sub.boxes)) return { pushes: 0, moves: '' };

  // Reachability scratch: two stamp arrays (one for the state being
  // expanded, one for its successors) so a successor's region never
  // clobbers the current state's reachability marks.
  const seen = new Int32Array(n);
  const mark = new Int32Array(n);
  const stack = new Int32Array(n);
  let stampSeen = 0;
  let stampMark = 0;
  // Lowest square of the region the player reaches from `from` with
  // `occupied` boxes in the way, marked in `arr` with its own stamp.
  const regionLow = (
    occupied: Uint8Array,
    from: number,
    arr: Int32Array,
    stamp: number,
  ): number => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    arr[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && !occupied[q] && arr[q] !== stamp) {
          arr[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  // A push to `t` is frozen if `t` sits in a 2x2 block of walls/boxes
  // holding a box off its goal.
  const frozenBlock = (occupied: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= n) continue;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
      if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if (
        (occupied[a] && !goalSet[a]) ||
        (occupied[b] && !goalSet[b]) ||
        (occupied[c] && !goalSet[c]) ||
        (occupied[d] && !goalSet[d])
      ) {
        return true;
      }
    }
    return false;
  };

  // State key: region-low plus boxes, packed into one number.
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * n + b;
    return k;
  };

  // Binary heap on (f, g, seq): smallest f first, then largest g, then
  // earliest insertion. Fully deterministic.
  type HeapEntry = [number, number, number, number]; // f, g, seq, state
  const heap: HeapEntry[] = [];
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const boxesList: number[][] = [sub.boxes.slice()];
  const playerList: number[] = [sub.player];
  const gList: number[] = [0];
  const parent: number[] = [-1];
  const pushBox: number[] = [-1]; // box square before the push
  const pushDir: number[] = [-1];
  const occupied = new Uint8Array(n);
  for (const b of sub.boxes) occupied[b] = 1;
  const startLow = regionLow(occupied, sub.player, seen, ++stampSeen);
  for (const b of sub.boxes) occupied[b] = 0;
  const best = new Map<number, number>();
  best.set(keyOf(sub.boxes, startLow), 0);
  let seq = 0;
  heapPush([heuristic(sub.boxes), 0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, g, , s] = heapPop();
    if (g !== gList[s]) continue; // stale heap entry
    const boxes = boxesList[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= cap) return null;
    expanded++;
    const player = playerList[s]!;
    for (const b of boxes) occupied[b] = 1;
    const hereStamp = ++stampSeen;
    regionLow(occupied, player, seen, hereStamp);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        // Player must reach the square behind the box; the square ahead
        // must be open floor, live, and not frozen.
        if (seen[b - d] !== hereStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(occupied, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, x) => a - x);
        const low = regionLow(occupied, b, mark, ++stampMark);
        const key = keyOf(next, low);
        const prevG = best.get(key);
        if (prevG !== undefined && prevG <= g + 1) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        best.set(key, g + 1);
        const ns = boxesList.length;
        boxesList.push(next);
        playerList.push(b);
        gList.push(g + 1);
        parent.push(s);
        pushBox.push(b);
        pushDir.push(k);
        const h = heuristic(next);
        if (h !== Infinity) heapPush([g + 1 + h, g + 1, seq++, ns]);
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Reconstruct: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  for (const s of path) {
    const nextBoxes = boxesList[s]!;
    const from = pushBox[s]!;
    const k = pushDir[s]!;
    const d = DY[k]! * w + DX[k]!;
    const to = from + d;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH_LETTER[k]!;
    player = from;
    boxes = nextBoxes;
    void to;
  }
  return { pushes: path.length, moves };
}

// Split a level into rooms: cut the hallway row's dead squares (floor
// the player starts on, from which no box can reach a goal) out of the
// floor; each remaining component holding boxes is a room.
function roomsOf(level: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i]! + DY[k] * w + DX[k];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    // Solve room by room, in scan order. Other rooms' boxes stand as
    // walls; the player walks on from where the last room left it.
    let player = level.player;
    let moves = '';
    let pushes = 0;
    // Each room's boxes as they stand now: unsolved rooms still hold
    // their starting boxes; a solved room's boxes sit on its goals.
    const currentBoxes = rooms.map((r) => r.boxes.slice());
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let oi = 0; oi < rooms.length; oi++) {
        if (oi === ri) continue;
        for (const b of currentBoxes[oi]!) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushAStar(sub, ROOM_EXPANSION_CAP);
      if (solved === null) return '';
      moves += solved.moves;
      pushes += solved.pushes;
      currentBoxes[ri] = room.goals.slice();
      // Player's square after the moves.
      for (const ch of solved.moves.toLowerCase()) {
        player += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
      }
    }
    void pushes;
    return moves;
  }
  // No room split: solve the whole level at once.
  const solved = solvePushAStar(level, WHOLE_EXPANSION_CAP);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
