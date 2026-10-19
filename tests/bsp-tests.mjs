// Test suite for tools/bsp.mjs (the world's BSP tree, decoded from its integers).
//
//   node tests/bsp-tests.mjs
//
// The trees here are written by hand, so the suite pins the **rules** rather than a captured world:
// which lists are a tree, which are not, and what a reader is told when they are not. The shapes are
// taken from the 19 trees the installed 1.8.0.13 ships (19 blocks, 20 721 nodes) — including the one
// that is *not* a full binary tree, because a rule that demanded two children per node would call
// 764 shipped nodes broken.
import { decodeBsp, describeBsp, BSP_AXES } from "../tools/bsp.mjs";

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** `<count>` followed by nodes, as the world writes them. */
const tree = (nodes) => [nodes.length, ...nodes.flat()];

// --- a list that is a tree ----------------------------------------------------------------
{
  // Two levels: the root splits X at 0 into a child that splits Y at 5 and a leaf.
  const r = decodeBsp(tree([[0, 0, 1, 2], [1, 5, -1, -1], [2, 9, -1, -1]]));
  check("a full tree decodes to one array per node", r.error === null && r.count === 3 && r.nodes.length === 3
    && r.nodes[0].join() === "0,0,1,2" && r.nodes[2].join() === "2,9,-1,-1", JSON.stringify(r));
  check("decodeBsp reports the three axes it knows", BSP_AXES === 3);
}
{
  // A node with **one** child: the root splits, its first child splits again, and that grandchild has
  // a single child of its own. 764 nodes of the shipped corpus are exactly this, so a reader that
  // insisted on two children per node would reject real worlds.
  const r = decodeBsp(tree([[0, 0, 1, 2], [1, 5, 3, -1], [2, 9, -1, -1], [2, 1, -1, -1]]));
  check("a node may have one child — the corpus has 764 of them", r.error === null && r.count === 4,
    r.error);
}
{
  // The degenerate but legal case: a single node that is a leaf.
  const r = decodeBsp(tree([[2, 7, -1, -1]]));
  check("a one-node tree decodes", r.error === null && r.count === 1 && r.nodes[0].join() === "2,7,-1,-1");
}

// --- a list that is not a tree ------------------------------------------------------------
const BROKEN = [
  ["an empty list has no node count", [], /no integer/],
  ["a non-integer value is refused where it stands", [5, 0, 0, 1, -1, 1.5], /value \d+ of \d+ is not an integer/],
  ["a node count of 0 is not a tree", [0], /at least one node/],
  ["a negative node count is not a tree", [-2], /at least one node/],
  ["the integer count must be 1 + 4 × the node count", [3, 0, 0, 1, -1, 0, 0, -1, -1], /13 integers are needed, and the list has 9/],
  ["the split axis is 0, 1 or 2", tree([[3, 0, 1, -1], [1, 0, -1, -1]]), /split axis is 3/],
  ["a child index 0 would make the root its own child", tree([[0, 0, 0, -1]]), /child 0 is neither -1 nor a node index in 1\.\.0/],
  ["a child index past the last node is refused", tree([[0, 0, 1, 9], [1, 0, -1, -1]]), /child 9 is neither -1/],
  ["the same child twice is not a tree", tree([[0, 0, 1, 1], [1, 0, -1, -1]]), /already the child of node 0/],
  ["a node no other node names is unreachable", tree([[0, 0, -1, -1], [1, 0, -1, -1]]), /node 1 is not the child of any node/],
];
for (const [what, values, pattern] of BROKEN) {
  const r = decodeBsp(values);
  check(`broken: ${what}`, r.nodes === null && pattern.test(r.error ?? ""), `${r.error} / ${JSON.stringify(r.nodes)}`);
}
check("broken: an error never comes with half a tree", decodeBsp([2, 0, 0, 5, -1, 1, 0, -1, -1]).nodes === null);

// --- the one-line summary -----------------------------------------------------------------
check("describe: a tree is its node count", describeBsp({ count: 3, nodes: [] }) === "3 nodes");
check("describe: one node is not \"1 nodes\"", describeBsp({ count: 1, nodes: [] }) === "1 node");
check(
  "describe: an invalid list is the error, prefixed",
  describeBsp({ count: 2, nodes: null, error: "node 0: child 5 is neither -1 nor a node index in 1..1" })
    === "invalid: node 0: child 5 is neither -1 nor a node index in 1..1",
);
check("describe: no BSP prints nothing", describeBsp(null) === "");

if (failures) {
  console.log(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nALL BSP TESTS PASSED");
