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
    /**
     * Ticks after an act before the same person can act again. Raised
     * from 288 when the Ship's Routine landed: a scheduled ship empties
     * its system rooms for hours at a time (the crew is in quarters, or
     * all at table), so solitude with a system, the act's gate, became
     * far more common. The longer cooldown restores the intended act
     * frequency against the denser opportunity.
     */
    cooldownTicks: 720,
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

  /**
   * The Ship's Routine (Playtest Note #4): watches, sleep and work blocks,
   * two shared meal windows a day, gossip that only travels between people
   * actually together, and free-time texture. Hours are ship hours; a day
   * is CONFIG.time.ticksPerDay ticks of ten minutes.
   */
  routine: {
    /** How many crew stand the night watch (drawn one per pool below). */
    nightWatchSize: 2,
    /**
     * Night-watch pools, in draw order: one engineering hand, one
     * bridge/security hand, so the ship is never unwatched. The member is
     * drawn from each pool on the "routine" stream.
     */
    nightWatchPools: [
      ["chief engineer", "engineer"],
      ["pilot", "navigator", "security officer", "executive officer"],
    ],
    /** Meal windows: breakfast and the evening meal, start/end ship hour. */
    breakfastStartHour: 7,
    breakfastEndHour: 8,
    eveningStartHour: 18,
    eveningEndHour: 19,
    /** Day watch shape: asleep 22:00-06:00, works two blocks between. */
    daySleepStartHour: 22,
    daySleepEndHour: 6,
    dayWorkWindows: [
      [8, 12],
      [13, 18],
    ] as [number, number][],
    /** Night watch shape: works the dark, sleeps through the morning. */
    nightSleepStartHour: 7,
    nightSleepEndHour: 15,
    nightWorkWindows: [
      [22, 24],
      [0, 6],
    ] as [number, number][],
    /** Rest is offered at at least this score during the sleep block. */
    sleepRestBase: 0.85,
    /** Work scores are scaled by this outside a work block. */
    sleepWorkFactor: 0.05,
    freeWorkFactor: 0.15,
    mealWorkFactor: 0.1,
    /** Non-failed repairs are scaled by this during the sleep block;
     *  failed systems ignore the schedule entirely (see below). */
    sleepRepairFactor: 0.25,
    /** Travel desire toward a FAILED system the member can repair is
     *  scaled by this, in any block: emergencies pull people out of bed. */
    emergencyRepairFactor: 1.6,
    /** During a meal window, travel desire toward the mess is at least
     *  this, and eating there scores at this multiple. */
    mealTravelDesire: 0.8,
    mealEatFactor: 1.5,
    /** Socialize scores are scaled by this in free and meal blocks. */
    freeSocialFactor: 1.3,
    /**
     * Gossip: a suspicion held at or above gossipThreshold can pass from
     * a speaker to a co-located listener, by at most gossipTransfer per
     * occasion (scaled by the listener's trust in the speaker), and never
     * above the level the speaker holds it at. Companionship drift: shared
     * free time moves trust this much per occasion, in the direction of
     * its current sign.
     */
    gossipThreshold: 0.48,
    gossipTransfer: 0.008,
    /** A tipping of one person's suspicion of one target is recorded at
     *  most once per this many ticks, however often rumour re-tops it. */
    gossipTipCooldownTicks: 144,
    companionDrift: 0.002,
    /** Free-time leisure candidates and their effects. */
    gameBase: 0.5,
    exerciseBase: 0.45,
    readBase: 0.4,
    gameMinPlayers: 2,
    gameMaxPlayers: 4,
    /** A room hosts at most one table game per this many ticks, and a
     *  person starts at most one leisure event per this many ticks, so
     *  free time textures the log instead of flooding it. */
    gameCooldownTicks: 9,
    leisureCooldownTicks: 30,
    gameTrustDrift: 0.004,
    gameBondDrift: 0.006,
    gameWinnerMorale: 0.05,
    gamePlayerMorale: 0.01,
    gameSocialRestore: 0.12,
    exerciseMorale: 0.03,
    exerciseEnergyCost: 0.015,
    readMorale: 0.02,
    /** Free-block travel desires toward the gym and toward quarters. */
    freeGymDesire: 0.3,
    freeQuartersDesire: 0.25,
  },

  /**
   * The galaxy, step 1: a procedural sector of named ports and the
   * factions that hold them, and the voyage as one leg between two
   * ports. Generation draws only from the "galaxy" stream, so the
   * sector can grow (traffic, convoys, port calls) without shifting
   * the ship, the crew, or the weather.
   */
  galaxy: {
    /** Ports per sector: enough to feel like a place, few enough
     *  that the witness can learn their names in one voyage. */
    minPorts: 6,
    maxPorts: 9,
    /** Factions per sector; every faction holds a home port. */
    minFactions: 3,
    maxFactions: 5,
    /**
     * The sector is a square this many light-days on a side. Ports
     * sit on a jittered grid of sectorCellsPerAxis cells per axis:
     * one port per cell, its position offset inside the cell by
     * between separationJitterMin and cell-minus-that light-days.
     * Two ports in neighbouring cells are then never closer than
     * minSeparationLightDays, by construction, not by luck.
     */
    sectorSpanLightDays: 60,
    sectorCellsPerAxis: 3,
    minSeparationLightDays: 12,
    /** Chance a non-home port answers to no faction. */
    independentChance: 0.25,
    /**
     * Cruise speed, light-days per ship day. With the sector scale
     * above, a leg in the chartered band below runs about two to
     * four weeks: long enough for a shipboard month to have a
     * shape, short enough to end inside a standard 30-day run.
     */
    cruiseLightDaysPerDay: 2,
    /** A voyage is chartered to a port this many days out, when the
     *  sector offers one; otherwise the nearest thing to the band. */
    minLegDays: 12,
    maxLegDays: 26,
    /** What a port is, in the sector's economy and imagination. */
    portCharacters: [
      "industrial",
      "agrarian",
      "free port",
      "refinery",
      "shrine",
      "company town",
      "shipyard",
      "listening post",
    ],
    portNameFirst: [
      "Kestrel",
      "Vostok",
      "Alden",
      "Maren",
      "Sorrel",
      "Ilyin",
      "Tamar",
      "Ostra",
      "Belka",
      "Corvin",
      "Halle",
      "Niska",
    ],
    portNameSecond: [
      "Reach",
      "Anchorage",
      "Shoal",
      "Exchange",
      "Haven",
      "Docks",
      "Terminus",
      "Crossing",
      "Market",
      "Rest",
      "Gate",
      "Spur",
    ],
    factionNameFirst: [
      "Vostok",
      "Helion",
      "Marengo",
      "Ostara",
      "Tallinn",
      "Umbral",
      "Verge",
      "Kestrel",
    ],
    factionNameSecond: [
      "Combine",
      "Accord",
      "Syndicate",
      "League",
      "Compact",
      "Trust",
      "Concord",
      "Cartel",
    ],
  },

  /**
   * The galaxy, step 2: traffic. Other ships cross the sector on
   * schedules generated whole at build from the "traffic" stream:
   * a leg table per ship, drawn until it covers the horizon below,
   * so a ship's position at any tick is a pure function of the tick
   * (the same arithmetic discipline as the voyage leg) and the
   * tick loop never simulates or decides anything for them. A
   * contact is geometry, not drama: it opens when another ship
   * crosses inside sensor range of the player's ship and closes
   * when it leaves, and both edges are computed, never drawn.
   */
  traffic: {
    /** Other ships per sector: enough that the sky is not empty,
     *  few enough that a contact still means something. */
    minShips: 6,
    maxShips: 10,
    /**
     * Sensor range, in light-days. A contact opens inside it. At
     * the sector's 12 light-day minimum port separation, a ship
     * berthed at a neighbouring port stays out of reach; a ship
     * passing on a crossing course does not. Set at 8 rather than
     * 6 after measuring the daily seeds at both: at 6, one seed's
     * month passed without a single traffic line of any kind,
     * which is the barren sky this step exists to end.
     */
    sensorRangeLightDays: 8,
    /** Schedules are generated until they cover this many days;
     *  past the table's end a ship simply stays at her last port. */
    scheduleHorizonDays: 400,
    /** Port stays, in ticks (a tick is ten ship-minutes): half a
     *  day to three days, the first stay included, so the sector
     *  does not all sail on the same morning. */
    minStayTicks: 72,
    maxStayTicks: 432,
    /** Chance a traffic ship answers to no faction. */
    independentChance: 0.25,
    /**
     * The traffic's kinds, and each kind's cruise as a multiple of
     * the player's cruise speed: couriers run hot, tankers wallow.
     * The kinds are the archetypes chapter's working hulls, worn
     * by other people's ships.
     */
    shipTypes: [
      { kind: "hauler", cruiseFactor: 0.9 },
      { kind: "courier", cruiseFactor: 1.3 },
      { kind: "tanker", cruiseFactor: 0.8 },
      { kind: "salvage rig", cruiseFactor: 0.85 },
      { kind: "patrol cutter", cruiseFactor: 1.2 },
      { kind: "passenger transport", cruiseFactor: 1.0 },
    ],
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
