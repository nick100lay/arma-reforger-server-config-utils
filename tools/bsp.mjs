/**
 * The BSP tree a world carries, decoded from its integers.
 *
 * A world's root entity has a `BSP` member, and both forms of the resource write it as a list of
 * decimal integers: the binary world (`worlds/**.ent`, read by `tools/ebin.mjs`) as an ASCII
 * payload inside a block, and the editable layer (`worlds/*_Layers/default.layer`, read by
 * `tools/etconf.mjs` and `tools/layer.mjs`) as an ordinary member value. The list is
 *
 *     <u32 nodeCount> ( <i32 axis> <i32 plane> <i32 child> <i32 child> ) × nodeCount
 *
 * Measured on all 19 worlds of the installed 1.8.0.13 that carry one — 19 blocks and 20 721 nodes
 * across `worlds.pak`, `worlds001.pak`, `worlds002.pak` and `data010.pak`, plus the layers of a
 * Workbench project: every one is a **tree** — node 0 is the root, and each of nodes 1..count-1 is
 * the child of exactly one node, so nothing is unreachable and nothing is shared. It is *not* a
 * full binary tree and must not be read as one: a node may have two children, **one** (764 nodes
 * across the corpus do) or none, so "N nodes means N+1 leaves" holds only in `EmptyCain` and
 * `EmptyEden` — 11 of the 19 have about half as many leaves as that. `axis` is 0 = X, 1 = Y (up) or
 * 2 = Z, and the Y planes read as metres — Cain's maximum is 731, against the world's own
 * `boundMaxs.y` of 731.6.
 *
 * That is the whole of what is proven. The **plane** value is *not* interpreted: along X and Z it
 * lies on a quantized per-world lattice (±29750 in 4250 steps on both Cain and Eden) that does not
 * agree with `boundMins`/`boundMaxs`, which are metres, so the unit stays unknown rather than
 * guessed. The tree is reported as nodes, and nothing in this file claims what the engine does
 * with it beyond that.
 *
 * A malformed list is reported as an error and **not** as a tree: inventing nodes for a payload
 * that does not hold together is the same mistake as inventing a width for an unknown tag in
 * `ebin.mjs`. `check` and `verify` therefore catch a broken BSP instead of printing a truncated
 * tree, and every reader shows the reason on one line.
 */

/** The split axes the tree uses: 0 = X, 1 = Y (up), 2 = Z. */
export const BSP_AXES = 3;

/**
 * Decode the integers of a BSP payload.
 *
 * Returns `{ count, nodes, error }`: `nodes` is an array of 4-element arrays (`[axis, plane, child,
 * child]`, `-1` for a leaf) and `count` its length, or `nodes` is null and `error` says which
 * condition failed — the first one, so the message names a place in the list rather than a count.
 */
export function decodeBsp(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { count: null, nodes: null, error: "there is no integer to read a node count from" };
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isInteger(values[i])) {
      return { count: null, nodes: null, error: `value ${i + 1} of ${values.length} is not an integer (${values[i]})` };
    }
  }
  const count = values[0];
  if (count < 1) {
    return { count, nodes: null, error: `the node count is ${count}, and a tree has at least one node` };
  }
  const needed = 1 + 4 * count;
  if (values.length !== needed) {
    return {
      count,
      nodes: null,
      error: `the node count is ${count}, so ${needed} integers are needed, and the list has ${values.length}`,
    };
  }
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push(values.slice(1 + 4 * i, 5 + 4 * i));

  // A child slot is -1 (a leaf) or the index of another node. Node 0 is the root, so it cannot be
  // a child: an index of 0 would make the tree a cycle, which is why the range starts at 1.
  const referencedBy = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const [axis, , first, second] = nodes[i];
    if (axis !== 0 && axis !== 1 && axis !== 2) {
      return { count, nodes: null, error: `node ${i}: the split axis is ${axis}, and an axis is 0, 1 or 2` };
    }
    // Both slots are checked, so a node that names the same child twice is caught by the second
    // visit rather than passing as one.
    for (const child of [first, second]) {
      if (child === -1) continue;
      if (child < 1 || child >= count) {
        return {
          count,
          nodes: null,
          error: `node ${i}: child ${child} is neither -1 nor a node index in 1..${count - 1}`,
        };
      }
      if (referencedBy[child]) {
        return {
          count,
          nodes: null,
          error: `node ${i}: child ${child} is already the child of node ${referencedBy[child] - 1}, so this is not a tree`,
        };
      }
      referencedBy[child] = i + 1;
    }
  }
  for (let i = 1; i < count; i++) {
    if (!referencedBy[i]) {
      return { count, nodes: null, error: `node ${i} is not the child of any node, so ${count - 1} nodes are not all reachable` };
    }
  }
  return { count, nodes, error: null };
}

/**
 * The one-line summary every text renderer prints for a decoded BSP: `4319 nodes`, or
 * `invalid: <reason>`. The member is already called `BSP`, so the name is not repeated here.
 */
export function describeBsp(bsp) {
  if (!bsp) return "";
  if (bsp.error) return `invalid: ${bsp.error}`;
  return `${bsp.count} node${bsp.count === 1 ? "" : "s"}`;
}
