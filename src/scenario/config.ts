// Scenario configuration: every tunable number and table for the current
// scaffold world lives here, in one place, so balancing never means hunting
// through system code. Systems read this object; they do not redefine it.

export const CONFIG = {
  /** Room names, in index order. Crew state stores a room index. */
  rooms: ["bridge", "engine room", "quarters"],

  /** Placeholder crew roster: id, starting room index, starting energy. */
  crew: [
    { id: "ada", room: 0, energy: 0.9 },
    { id: "bek", room: 2, energy: 0.8 },
  ],

  weather: {
    /** Weather state names, in index order. */
    states: ["calm", "solar wind", "radiation storm"],
    /** Ticks between weather rolls. 1 means the chain is rolled every tick. */
    cadenceTicks: 1,
    /**
     * Markov transition table. Row per current state: probability of moving
     * to calm, solar wind, radiation storm, in state index order.
     */
    transitions: [
      [0.9, 0.08, 0.02],
      [0.25, 0.65, 0.1],
      [0.35, 0.25, 0.4],
    ],
  },
} as const;
