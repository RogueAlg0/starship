// Scenario configuration: every tunable number and table for the simulation
// lives here, in one place, so balancing never means hunting through system
// code. Systems read this object; they do not redefine it.

export const CONFIG = {
  /** Ship time: one tick is ten ship-minutes, 144 ticks to a ship day. */
  time: {
    minutesPerTick: 10,
    ticksPerDay: 144,
  },

  ship: {
    minRooms: 10,
    maxRooms: 14,
    /** Room kinds every ship has exactly one of (quarters may also repeat). */
    requiredKinds: [
      "bridge",
      "engineering",
      "medbay",
      "mess",
      "quarters",
      "hydroponics",
      "cargo",
      "airlock",
    ],
    /** Kinds that may fill the remaining rooms, repeats allowed. */
    repeatableKinds: ["quarters", "lab", "gym", "cargo", "hydroponics"],
    roomLabels: {
      bridge: "Bridge",
      engineering: "Engineering",
      medbay: "Medbay",
      mess: "Mess",
      quarters: "Quarters",
      hydroponics: "Hydroponics",
      cargo: "Cargo Bay",
      airlock: "Airlock",
      lab: "Laboratory",
      gym: "Gymnasium",
    } as Record<string, string>,
    /** Extra non-tree edges attempted after the spanning tree, for loops. */
    extraEdgeAttempts: 6,
    nameFirst: [
      "Meridian",
      "Vela",
      "Sable",
      "Aurora",
      "Cobalt",
      "Halcyon",
      "Juniper",
      "Tern",
      "Ostara",
      "Zephyr",
      "Marisol",
      "Keel",
    ],
    nameSecond: [
      "Dawn",
      "Verge",
      "Lantern",
      "Compass",
      "Harbour",
      "Signal",
      "Meadow",
      "Cinder",
      "Voyage",
      "Theorem",
      "Garden",
      "Drift",
    ],
  },

  /** Every ship system kind there is. Ships guarantee one of each. */
  systemKinds: [
    "reactor",
    "life support",
    "engines",
    "water recycler",
    "hydroponics rig",
    "comms",
    "medbay unit",
  ],

  /** Which system kinds a room kind can host. */
  roomSystemAffinity: {
    bridge: ["comms"],
    engineering: ["reactor", "engines", "life support", "water recycler"],
    medbay: ["medbay unit"],
    mess: ["water recycler"],
    quarters: [] as string[],
    hydroponics: ["hydroponics rig"],
    cargo: ["water recycler"],
    airlock: [] as string[],
    lab: ["comms"],
    gym: [] as string[],
  } as Record<string, string[]>,

  systemGen: {
    /** Roll below this: the room hosts no system (when it could). */
    emptyChance: 0.25,
    /** Roll below emptyChance + this: one system; otherwise two. */
    oneChance: 0.5,
    minCondition: 0.85,
    maxCondition: 1.0,
  },

  systems: {
    wearPerTick: 0.00035,
    stormWearMultiplier: 3,
    maintainPerTick: 0.006,
    repairPerTick: 0.03,
    damagedThreshold: 0.7,
    strainThreshold: 0.35,
    failedThreshold: 0.05,
    repairCompleteThreshold: 0.9,
    strainCadenceTicks: 96,
    strainMoraleHit: 0.012,
    lifeSupportStrainMoraleHit: 0.025,
    blameTrustHit: 0.004,
  },

  crewGen: {
    firstNames: [
      "Amara",
      "Yusuf",
      "Priya",
      "Tomas",
      "Ingrid",
      "Kenji",
      "Naledi",
      "Piotr",
      "Lucia",
      "Emeka",
      "Sanna",
      "Rafael",
      "Mei",
      "Dmitri",
      "Aisha",
      "Bruno",
      "Chiamaka",
      "Denis",
      "Elif",
      "Farid",
      "Greta",
      "Hiro",
      "Ines",
      "Jamal",
      "Katya",
      "Leandro",
      "Mina",
      "Nils",
      "Odessa",
      "Ravi",
    ],
    lastNames: [
      "Okafor",
      "Novak",
      "Haddad",
      "Tanaka",
      "Lindqvist",
      "Kowalski",
      "Rahman",
      "Duarte",
      "Kim",
      "Alvarez",
      "Petrov",
      "Ndiaye",
      "Rossi",
      "Adeyemi",
      "Fischer",
      "Marino",
      "Iqbal",
      "Sokolov",
      "Meyer",
      "Costa",
      "Havel",
      "Osei",
      "Barlow",
      "Quintana",
      "Weiss",
      "Diallo",
      "Ferreira",
      "Nilsen",
    ],
    traitPool: [
      "bold",
      "meticulous",
      "hot-tempered",
      "kind",
      "loner",
      "gossipy",
      "disciplined",
      "anxious",
      "wry",
      "stubborn",
      "gentle",
      "restless",
    ],
    minTraits: 2,
    /** Directed pairs seeded with low trust, so grudges have a head start. */
    initialRivalries: 3,
    rivalryTrustMin: 0.42,
    rivalryTrustMax: 0.55,
    needMin: 0.55,
    needMax: 0.95,
  },

  /** The twelve roles. affinity: system kinds the role tends and can repair. */
  roles: [
    { key: "captain", title: "Captain", home: "bridge", affinity: ["comms"], repair: 0.1 },
    { key: "executive officer", title: "Executive Officer", home: "bridge", affinity: ["comms", "engines"], repair: 0.25 },
    { key: "chief engineer", title: "Chief Engineer", home: "engineering", affinity: ["reactor", "engines", "life support", "water recycler"], repair: 0.95 },
    { key: "engineer", title: "Engineer", home: "engineering", affinity: ["reactor", "engines", "life support", "water recycler"], repair: 0.85 },
    { key: "medic", title: "Medic", home: "medbay", affinity: ["medbay unit"], repair: 0.35 },
    { key: "cook", title: "Cook", home: "mess", affinity: ["water recycler"], repair: 0.2 },
    { key: "botanist", title: "Botanist", home: "hydroponics", affinity: ["hydroponics rig"], repair: 0.4 },
    { key: "pilot", title: "Pilot", home: "bridge", affinity: ["engines", "comms"], repair: 0.3 },
    { key: "navigator", title: "Navigator", home: "bridge", affinity: ["comms"], repair: 0.2 },
    { key: "security officer", title: "Security Officer", home: "quarters", affinity: [] as string[], repair: 0.15 },
    { key: "scientist", title: "Scientist", home: "lab", affinity: ["comms"], repair: 0.25 },
    { key: "quartermaster", title: "Quartermaster", home: "cargo", affinity: ["water recycler"], repair: 0.35 },
  ],

  /**
   * Trait effects. sabotage: added to the sabotage trait factor; repair and
   * maintain: fractional bonuses; socialDesire: added to socialize scores;
   * suspicion: fractional bonus to suspicion this person forms; accuse:
   * cut to this person's accusation threshold. Traits not listed for an
   * effect have no mechanical effect there (flavour only, for now).
   */
  traitEffects: {
    bold: { sabotage: 0.35 },
    meticulous: { repair: 0.3, maintain: 0.2 },
    "hot-tempered": { sabotage: 0.35 },
    kind: { sabotage: -0.2, socialDesire: 0.1 },
    loner: { socialDesire: -0.25 },
    gossipy: { accuse: 0.08 },
    disciplined: { sabotage: -0.45 },
    anxious: { suspicion: 0.25 },
    wry: {},
    stubborn: {},
    gentle: {},
    restless: {},
  } as Record<
    string,
    {
      sabotage?: number;
      repair?: number;
      maintain?: number;
      socialDesire?: number;
      suspicion?: number;
      accuse?: number;
    }
  >,

  needs: {
    energyDecay: 0.0045,
    hungerDecay: 0.0038,
    socialDecay: 0.0028,
    workEnergyCost: 0.004,
    moveEnergyCost: 0.0015,
    eatRestore: 0.5,
    restRestore: 0.055,
    /** Rest outside quarters restores at this fraction of the full rate. */
    restOffQuartersFactor: 0.4,
    socialRestore: 0.14,
    moraleRate: 0.02,
    moraleBase: 0.72,
  },

  scores: {
    idle: 0.08,
    work: 0.5,
    workLowEnergy: 0.12,
    genericWorkFactor: 0.5,
    eatBase: 0.35,
    eatUrgencyBase: 0.4,
    eatUrgencyPerDeficit: 2.4,
    restPerDeficit: 0.9,
    restStormBonus: 0.25,
    restFloor: 0.03,
    socializeBase: 0.18,
    socializePerDeficit: 0.55,
    socializeFloor: 0.02,
    repairBase: 0.8,
    patrol: 0.34,
    travelDiscount: 0.94,
    travelDistanceCost: 0.01,
  },

  relationships: {
    socializeTrustDrift: 0.015,
    socializeBondDrift: 0.01,
    workTrustDrift: 0.003,
    workBondDrift: 0.004,
    snubTrustHit: 0.03,
    /** A socialize target brushes off someone they trust less than this. */
    refuseTrust: -0.2,
    /** Crew do not seek out people they trust less than this. */
    socializeMinTrust: -0.35,
    crowdThreshold: 5,
    crowdTrustHit: 0.0002,
    bondMilestone: 0.6,
    bondMilestoneHigh: 0.8,
    trustBrokenThreshold: -0.6,
  },

  grudge: {
    /** Trust below this, sustained, becomes a grudge. */
    threshold: -0.5,
    formTicks: 72,
    /** A grudge eases away if trust climbs this far above the threshold. */
    easeMargin: 0.15,
  },

  accusation: {
    threshold: 0.65,
    cooldownTicks: 720,
    /** After a public accusation, the matter is already public: other
     *  accusers hold off about the same person for this many ticks. */
    publicCooldownTicks: 36,
    /** Suspicion listeners gain toward the accused from a public claim. */
    spreadSuspicion: 0.02,
    /** Suspicion fades a little every tick; memories are not ledgers. */
    suspicionDecayPerTick: 0.001,
    listenerTrustHit: 0.015,
    /** The accuser's own suspicion vents a little once spoken. */
    ventRelief: 0.12,
    selfTrustHit: 0.05,
    /** Ticks after being accused during which morale runs low. */
    moraleShadowTicks: 288,
    moraleShadowHit: 0.25,
  },

  sabotage: {
    damageMin: 0.3,
    damageMax: 0.6,
    baseScore: 0.25,
    intensityWeight: 0.9,
    /** Grudge intensity times trait factor must reach this to offer the act. */
    minIntensity: 0.45,
    /** Ticks after an act before the same person can act again. */
    cooldownTicks: 288,
    /** Striking back spends some of the grudge's heat. */
    catharsisTrust: 0.1,
    /** Presence snapshots kept, one per tick: the witness evidence window. */
    witnessWindowTicks: 8,
    suspicionBase: 0.34,
  },

  chronicle: {
    /** True: the chronicle names culprits as log-truth. False: it prints
     *  only what the crew could know, and accusations stand as beliefs. */
    knowsTruth: true,
  },

  weather: {
    /** Weather state names, in index order. */
    states: ["calm", "solar wind", "radiation storm"],
    /**
     * Ticks between weather rolls. 6 means the chain is rolled once per
     * ship hour (a tick is ten minutes). Weather is a condition of the
     * voyage, not a coin toss: episodes should last hours, so the chain
     * rolls hourly and every state holds hard (Playtest Note #1).
     */
    cadenceTicks: 6,
    /**
     * Markov transition table. Row per current state: probability of moving
     * to calm, solar wind, radiation storm, in state index order. Expected
     * dwells at the hourly cadence: calm about 33 hours, solar wind about
     * 12.5 hours, radiation storm about 6.7 hours. Storms stay rare out of
     * calm and sit on the ship once they arrive.
     */
    transitions: [
      [0.97, 0.025, 0.005],
      [0.06, 0.92, 0.02],
      [0.05, 0.1, 0.85],
    ],
  },
};
