/**
 * Iterative Tarjan SCC (no recursion, so very long chains cannot overflow the stack).
 * `succ(n)` must return successors in a deterministic order.
 */
export function stronglyConnected<N>(nodes: ReadonlyArray<N>, succ: (n: N) => ReadonlyArray<N>): N[][] {
  const index = new Map<N, number>();
  const low = new Map<N, number>();
  const onStack = new Set<N>();
  const stack: N[] = [];
  const out: N[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: N; edges: ReadonlyArray<N>; i: number }> = [];
    const open = (n: N): void => {
      index.set(n, counter);
      low.set(n, counter);
      counter++;
      stack.push(n);
      onStack.add(n);
      work.push({ node: n, edges: succ(n), i: 0 });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      if (frame.i < frame.edges.length) {
        const w = frame.edges[frame.i++] as N;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(w) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: N[] = [];
        for (;;) {
          const w = stack.pop() as N;
          onStack.delete(w);
          comp.push(w);
          if (w === frame.node) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}

/** Shortest cycle through `start` inside `members` (BFS, successors expanded in the given order). */
export function shortestCycle<N>(start: N, members: ReadonlySet<N>, succ: (n: N) => ReadonlyArray<N>): N[] {
  const prev = new Map<N, N>();
  const queue: N[] = [];
  for (const s of succ(start)) {
    if (!members.has(s)) continue;
    if (s === start) return [start, start];
    if (!prev.has(s)) {
      prev.set(s, start);
      queue.push(s);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi] as N;
    for (const s of succ(n)) {
      if (!members.has(s)) continue;
      if (s === start) {
        const path: N[] = [start];
        let cur: N | undefined = n;
        const rev: N[] = [];
        while (cur !== undefined && cur !== start) {
          rev.push(cur);
          cur = prev.get(cur);
        }
        path.push(...rev.reverse(), start);
        return path;
      }
      if (!prev.has(s)) {
        prev.set(s, n);
        queue.push(s);
      }
    }
  }
  return [start, start];
}

/** Binary min-heap with a caller-supplied comparator. */
export class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(v: T): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i] as T, a[p] as T) >= 0) break;
      [a[i], a[p]] = [a[p] as T, a[i] as T];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as T;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l] as T, a[m] as T) < 0) m = l;
        if (r < a.length && this.cmp(a[r] as T, a[m] as T) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as T, a[i] as T];
        i = m;
      }
    }
    return top;
  }
}
