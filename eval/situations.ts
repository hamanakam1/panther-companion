export const SITUATIONS = [
  {
    id: "s1",
    name: "Unfamiliar command failure",
    description: "A terminal command exits non-zero with stderr; the companion explains the failure for the current goal.",
    expectedTopic: "command-failure",
    expectedZeroSurface: false,
  },
  {
    id: "s2",
    name: "Documentation mismatch",
    description: "Two captured sources disagree on a project fact (e.g. port 3000 vs 8080).",
    expectedTopic: "doc-mismatch",
    expectedZeroSurface: false,
  },
  {
    id: "s3",
    name: "Multiple agents, same failure",
    description: "Two agents report the same captured error; treated as one blocked task.",
    expectedTopic: "shared-agent-failure",
    expectedZeroSurface: false,
  },
  {
    id: "s4",
    name: "Return to interrupted task",
    description: "After a pause, the stored open question is briefed.",
    expectedTopic: "interrupted-task",
    expectedZeroSurface: false,
  },
  {
    id: "s5",
    name: "Routine successful work",
    description: "A command exits 0 with clean output; the companion stays quiet (zero surface).",
    expectedTopic: "routine-success",
    expectedZeroSurface: true,
  },
];
