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
      "hoarding",
    ],
    minTraits: 2,
    /** Directed pairs seeded with low trust, so grudges have a head start. */
    initialRivalries: 3,
    rivalryTrustMin: 0.42,
    rivalryTrustMax: 0.55,
    needMin: 0.55,
    needMax: 0.95,
  },

  /** The twelve roles. affinity: system kinds the role tends and
   *  can repair; starting discipline levels live in skills.boarding,
   *  the table the old flat competence number was drawn from. */
  roles: [
    { key: "captain", title: "Captain", home: "bridge", affinity: ["comms"] },
    { key: "executive officer", title: "Executive Officer", home: "bridge", affinity: ["comms", "engines"] },
    { key: "chief engineer", title: "Chief Engineer", home: "engineering", affinity: ["reactor", "engines", "life support", "water recycler"] },
    { key: "engineer", title: "Engineer", home: "engineering", affinity: ["reactor", "engines", "life support", "water recycler"] },
    { key: "medic", title: "Medic", home: "medbay", affinity: ["medbay unit"] },
    { key: "cook", title: "Cook", home: "mess", affinity: ["water recycler"] },
    { key: "botanist", title: "Botanist", home: "hydroponics", affinity: ["hydroponics rig"] },
    { key: "pilot", title: "Pilot", home: "bridge", affinity: ["engines", "comms"] },
    { key: "navigator", title: "Navigator", home: "bridge", affinity: ["comms"] },
    { key: "security officer", title: "Security Officer", home: "quarters", affinity: [] as string[] },
    { key: "scientist", title: "Scientist", home: "lab", affinity: ["comms"] },
    { key: "quartermaster", title: "Quartermaster", home: "cargo", affinity: ["water recycler"] },
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
    hoarding: {},
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
     *  accusers hold off about the same person for this many ticks.
     *  One ship day. A public claim occupies the ship until it has had
     *  a day to be weighed, and the council, not repetition, is what
     *  moves it. At six hours a scapegoat collected a fresh accusation
     *  every few hours, each one restating the same claim, and the
     *  chronicle filled with restatements instead of events (measured
     *  on seed 42 with room-scoped hearing: accusations still settle
     *  near 25 a day, driven by the per-target re-accusation rate). */
    publicCooldownTicks: 144,
    /** The public cooldown stretches with repetition: each public
     *  accusation the same person has suffered inside this window
     *  adds one more base cooldown to the next (up to the cap).
     *  The first answer to fresh evidence stays immediate; the
     *  fifth restatement of the same claim waits its turn. A
     *  finding clears the record (see the council's venting). */
    repeatWindowTicks: 1008,
    repeatCooldownCap: 3,
    /** Suspicion listeners gain toward the accused from a public claim. */
    spreadSuspicion: 0.02,
    /** Suspicion fades a little every tick; memories are not ledgers.
     *  About 10% a day: slow enough that a repeat offender's pattern
     *  accumulates across a fortnight of acts, fast enough that a
     *  quiet month clears the air. (At 13% a day with the old
     *  unbounded evidence the fade lost either way; paired with the
     *  divided evidence weight this is the cooling half of the
     *  balance.) */
    suspicionDecayPerTick: 0.0007,
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
    /** The total suspicion one act casts per observer, divided among
     *  the suspects seen in or next door to the room by squared
     *  evidence weight and prior distrust. Sized so the culprit of a
     *  quiet act takes the larger share and lands near the gossip
     *  threshold: one act makes a named suspect, two or three acts
     *  inside the fade make a case. */
    suspicionBase: 0.55,
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
  /**
   * The upkeep layer: standing duties, each owned by a
   * department, done in its place, decaying on its own clock.
   * Critical to the routine and quietly expensive to neglect:
   * the consequences live in the systems that read the levels
   * (air and food production, sickness, the stores tally).
   */
  duties: {
    /** A duty below this level is neglected: the ship is told. */
    neglectLine: 0.3,
    /** Servicing a neglected duty past this level restores it. */
    restoreLine: 0.55,
    perDuty: {
      filters: { decayPerDay: 0.3, servicePerTick: 0.02 },
      sanitation: { decayPerDay: 0.5, servicePerTick: 0.025 },
      crops: { decayPerDay: 0.35, servicePerTick: 0.022 },
      audit: { decayPerDay: 0.22, servicePerTick: 0.03 },
    } as Record<string, { decayPerDay: number; servicePerTick: number }>,
    /** Neglected filters throttle oxygen production to this
     *  floor share; kept filters run at full. */
    filterFloor: 0.6,
    /** Neglected crops throttle food production likewise. */
    cropFloor: 0.45,
    /** Sickness pressure per day at zero sanitation, scaled by
     *  how far below the line the ship's hygiene has fallen. */
    grimeSickPerDay: 0.22,
    /** Food milli-units the tally quietly loses per day while
     *  the audit stands neglected, surfaced as a discrepancy. */
    auditDriftFoodMilliPerDay: 400,
  },

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
    /** Rumour loses strength as it travels: a listener can catch at
     *  most this fraction of the level the speaker holds. First-hand
     *  suspicion (from evidence, or from hearing a claim spoken in
     *  the room) is untouched; only the gossip path attenuates, so a
     *  suspicion passed hand to hand sinks below the accusation line
     *  within a few retellings unless evidence refreshes it. Without
     *  the attenuation, gossip's cap was the speaker's full level and
     *  the twice-daily meals re-topped the whole ship at that level
     *  forever: measured on seed 42, accusations re-saturate near
     *  10 a day by month six however the evidence inflow is bounded. */
    gossipFidelity: 0.8,
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
   * Crew chatter: speech from beliefs (the Chatter section of
   * DESIGN). The social machinery already moves suspicion and
   * company silently; this layer gives some of it a voice. Lines
   * are template-composed from real state only, selection is a
   * pure hash of the moment (no RNG stream is drawn, so speech
   * can never shift the simulation it reports), and the fractions
   * and cooldowns below are the dosage: a ship that talks
   * occasionally, not a transcript of every minute.
   */
  chatter: {
    /** Master gate. Exists so tests can prove the speech layer
     *  feeds nothing back: a run with this off must differ from a
     *  run with it on only by the chatter events themselves. */
    enabled: true,
    /** Fraction of gossip transfers that are spoken aloud. */
    gossipSpeakFraction: 0.5,
    /** Fraction of shared-leisure socialize occasions that find
     *  a voice, before topic and cooldown checks. */
    socialSpeakFraction: 0.2,
    /** The same, for a pair at a meal table. */
    tableSpeakFraction: 0.2,
    /** One person speaks at most one general line per this many
     *  ticks, and at most one gossip line per the shorter span. */
    speakerCooldownTicks: 288,
    gossipCooldownTicks: 36,
    /** And the ship as a whole: spoken lines stand at least this
     *  many ticks apart, so a meal window cannot produce a
     *  chorus of announcements in a single hour. */
    shipGapTicks: 12,
    /** Voyage talk (the port ahead, the port alongside) is the
     *  filler of shipboard speech: always available, so it must
     *  also pass this second gate or it crowds out everything
     *  else a person might say. */
    fillerSpeakFraction: 0.5,
    /** The stricter gate inside the filler gate for the voyage
     *  topics themselves: the countdown is true every day, and
     *  remarked on only sometimes. */
    voyageSpeakFraction: 0.35,
    /** Chatter lines the highlights view may carry per ship day:
     *  the notable few (a tip that tips, a rehearsal, a lie), and
     *  never more than this, however loud the day gets. */
    highlightsPerDay: 1,
    /** A speaker whose own suspicion of the subject stands
     *  within this of their accusation threshold is rehearsing
     *  an accusation: the line is notable. Kept narrow: gossip
     *  only transfers suspicions of 0.48 and up, so a wide window
     *  would mark nearly every spoken suspicion. */
    rehearsalWindow: 0.05,
    /** A witness who was there, and holds the truth at or above
     *  this, and names someone else (or nothing), has kept
     *  quiet: the log notes it for the watcher. */
    withheldSuspicion: 0.4,
    /** A crime is talk while it is younger than this. */
    crimeTalkTicks: 1440,
    /** A course decision is talk while it is younger than this. */
    recentCourseTicks: 72,
    /** Line templates by topic. Placeholders: {about} and
     *  {target} are people, {system} a ship system, {port} a
     *  port name, {days} a day count, {store} a store, {part} a
     *  body part, {state} a condition word, {room} a room. Plain
     *  speech, composed from the facts at hand, nothing else. */
    templates: {
      suspicion: [
        "I saw {about} near the {system} the night it was hit.",
        "Keep an eye on {about}. Ever since the {system}, I do.",
        "It was {about} around the {system}. That's what I think.",
      ],
      suspicionNoAct: [
        "I don't trust {about}. No reason I can name.",
        "Watch yourself around {about}.",
        "{about} gives me a bad feeling. That's all it is.",
      ],
      theftSeen: [
        "I saw {about} with their hands in the stores.",
        "{about} took food. I was there. I saw it.",
      ],
      theftHeard: [
        "Someone's been in the stores, and I think it's {about}.",
        "The stores are light, and {about} eats well. Notice that?",
      ],
      system: [
        "The {system} is {state}. Hear it?",
        "Someone ought to see to the {system} before it gives out.",
        "If the {system} goes, we're in real trouble.",
      ],
      storm: [
        "This storm gets in your teeth.",
        "Radiation's up. Keep clear of the hull-side rooms.",
        "Whole ship hums in a storm. Hate it.",
      ],
      rationing: [
        "Rationing on {store} now. Eat slow.",
        "They've cut the {store} again. Half of half.",
        "Short {store}, short tempers. Mind yours.",
      ],
      underway: [
        "{port} in {days} days. Feels longer.",
        "About {days} days out from {port} yet.",
        "Still {days} days to {port}.",
        "Count it how you like: {days} days to {port}.",
      ],
      underwaySoon: [
        "We make {port} tomorrow, with luck.",
        "{port} tomorrow. I can almost smell dock air.",
      ],
      inport: [
        "Good to be alongside at {port}, even a day.",
        "{port} air beats ship air. No offence.",
      ],
      course: [
        "Council says {port} next. Hope they're right.",
        "So it's {port}. The table has spoken.",
      ],
      hungry: [
        "I could eat the plates, I swear.",
        "Is it supper yet? Feels like a week.",
      ],
      tired: [
        "I'm dead on my feet.",
        "Watch ends, I'm horizontal. That's the plan.",
      ],
      hurt: [
        "My {part} is still not right.",
        "Took a knock to the {part}. It'll mend.",
      ],
      sick: [
        "Feel rotten. Something's going around.",
        "Don't stand close. I'm coming down with something.",
      ],
      grudge: [
        "Don't seat me by {target}. That's all I ask.",
        "{target} and me aren't square. Leave it there.",
      ],
      bond: [
        "Glad you're on this ship. Don't tell the others.",
        "You and me keep this ship honest.",
        "Wouldn't sail with a better crew. Present company counted.",
        "You ever need a hand, you come to me.",
      ],
      /** Testimony, spoken to the board. {room} is where it
       *  happened, for the witness who stood there. */
      testimonyPresent: [
        "I was there. It was {about}.",
        "I stood in the {room} when it happened. It was {about}.",
        "I saw enough. It was {about}.",
      ],
      testimonyHeard: [
        "It was {about}. That's my belief, and I'll stand on it.",
        "I say it was {about}.",
        "Ask me who, I'll tell you plain: {about}.",
      ],
      /** The accused, answering the board. */
      denial: [
        "I did nothing of the sort.",
        "It wasn't me. Wrong soul.",
        "I had no hand in it.",
      ],
    } as Record<string, string[]>,
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
    /**
     * Port stays between legs, in whole ship days: the drawn stay
     * runs minStayDays..maxStayDays, bent by the port's character
     * (a free port keeps a ship a day longer; a shipyard's dock
     * schedule does too). The company town's entry is zero on
     * purpose: company towns turn ships around on the company's
     * clock, neither faster nor slower.
     */
    minStayDays: 1,
    maxStayDays: 3,
    stayDayModifier: {
      "free port": 1,
      shipyard: 1,
      "company town": 0,
    } as Record<string, number>,
    /**
     * Drift: a ship whose fuel is gone still makes way on
     * momentum, at this fraction of her voyage clock (the leg
     * stretches by its reciprocal). Drift must never be zero
     * progress: fuel rises only in port, so a frozen clock would
     * strand a ship forever — arrival stays reachable from any
     * state, only later. (Caught by the hosted copy's accuracy
     * pass, which found the frozen version of this bug in its own
     * build; see DECISIONS.)
     */
    driftRate: 0.25,
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
    /** What a faction IS, organisationally. The name's tail word
     *  is part of its name; the kind is its form, and the two may
     *  differ the way a named Trust can be a church. */
    factionKinds: [
      "combine",
      "syndicate",
      "order",
      "church",
      "cartel",
      "league",
      "company",
      "communion",
    ],
    /** How a faction holds itself toward the world. */
    factionTemperaments: [
      "greedy",
      "pious",
      "martial",
      "curious",
      "insular",
      "generous",
      "jealous",
      "patient",
      "proud",
      "weary",
    ],
  },

  /**
   * Standing: the ship's reputation with each galactic faction,
   * a ledger in [-1, 1] moved by the voyage itself. Bands are
   * the names the wider world uses; crossing one is news.
   */
  factions: {
    arrivalGain: 0.03,
    stayBonus: 0.02,
    stayBonusDays: 2,
    coldLine: -0.3,
    warmLine: 0.15,
    honouredLine: 0.5,
    /**
     * The sector itself, step 2: the factions play their own
     * game at the ports, daily, whether or not the witnessed
     * ship is watching. Influence is a share of a port's trade
     * and voice, always summing to 100 across the factions.
     * Control changes hands through contests, never by drift
     * alone; drift only brings a challenger close enough to
     * force one. All numbers are points of share per day
     * unless named otherwise.
     */
    sector: {
      /** Effort spread converted to share movement per day. */
      driftRate: 1.7,
      /**
       * Daily pull of a port's shares toward their natural
       * distribution (the port's character, set at creation).
       * Without it, incumbency compounds and every port ends
       * at 100 for somebody; with it, ports stay plural and
       * challengers stay alive near their natural strength.
       */
      reversion: 0.012,
      /** A challenger must hold at least this share to force a contest. */
      contestFloor: 22,
      /** ...and stand within this many points of the controller. */
      contestGap: 5,
      /** Under an active unrest the gap widens: the port is volatile. */
      unrestGap: 7,
      /** First to this many days takes the contest. */
      contestWinDays: 4,
      /** No contest runs longer than this; the higher score holds. */
      contestMaxDays: 7,
      /** Quiet days at a port after a contest resolves. */
      contestCooldownDays: 10,
      /** A controller under this share with no contest loses the port. */
      collapseLine: 10,
      /** A challenger taking a free port must reach this share. */
      freePortLine: 45,
      /** Daily chance a port ignites a condition, before context. */
      conditionChance: 0.012,
      /** Added ignition chance when the controller is weak. */
      weakControllerBonus: 0.02,
      /** Days a condition spends announced before it bites. */
      conditionPendingDays: 1,
      /** Active days per condition kind. */
      boomDays: 3,
      shortageDays: 3,
      unrestDays: 2,
      /** Quiet days at a port after a condition ends. */
      conditionCooldownDays: 5,
    },
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

  /**
   * Stores: what the ship eats, burns, and breathes (the Stores
   * chapter). Five stores, all read in DAYS OF SUPPLY for the
   * current crew, with absolute quantities tracked underneath in
   * integer milli-units. One food unit is one crew-day of eating,
   * so a store's days are its milli-units over the day's draw:
   * crew count x 1000 for food, water, and oxygen; cruise burn for
   * fuel; a nominal daily draw for spare parts, so all five bars
   * speak the same language.
   */
  stores: {
    /** Tank and locker sizes, in days of supply. The parts
     *  locker is sized against burst, not trend: one bad week of
     *  storm and sabotage repairs can draw ten days of parts, and
     *  the locker, not the fabricator, is what absorbs it. */
    capacityDays: { food: 45, water: 40, oxygen: 25, fuel: 60, parts: 45 },
    /** What fraction of capacity a healthy ship sails with. The
     *  food buffer is the chapter's 30 to 45 days: 0.85 of 45. */
    departureFraction: {
      food: 0.85,
      water: 0.85,
      oxygen: 1,
      fuel: 0.9,
      parts: 0.7,
    },
    /** Production per day at system condition 1, as a multiple of
     *  the day's consumption: a healthy hydroponics rig grows a
     *  little more than the crew eats, and the margin is the game. */
    productionFactor: { food: 1.06, water: 1.08, oxygen: 1.2 },
    /** Spare parts the fabricator turns out per day at condition 1
     *  while engineering is staffed, in milli-units. Tuned with
     *  the repair cost below against measured flows: routine wear
     *  draws about 1,300 milli-units a day and the fabricator
     *  covers it with margin, but a damage cluster (storm plus
     *  sabotage) draws 8,000 to 14,000 a day, and no honest rate
     *  covers that — the locker and the ports absorb clusters,
     *  and a hard month can still empty the locker for days at a
     *  time, which is the chapter's shortfall rule working, not
     *  starvation: repairs crawl, nobody goes hungry. A much
     *  higher repair cost was tried and rejected: it made the
     *  crawl permanent and starved the other stores through
     *  unrepaired recyclers. */
    partsMilliPerDay: 3600,
    /** Fuel burn: milli-units per light-day under way. Docked, the
     *  ship sips at the docked fraction of the under-way draw. */
    fuelMilliPerLightDay: 1000,
    fuelDockedFraction: 0.08,
    /** A repair costs parts in proportion to the condition it
     *  restores: milli-units per whole point of condition. When
     *  the locker cannot pay, a repair restores only what the
     *  parts buy; at empty it crawls at the shortfall floor. */
    repairPartsMilliPerCondition: 10000,
    repairPartsShortfallFloor: 0.35,
    /** Thresholds, in days of supply. A crossing speaks once; the
     *  store re-arms only after resupply carries it back above the
     *  threshold plus the hysteresis band. */
    lowDays: 10,
    criticalDays: 4,
    hysteresisDays: 2,
    /**
     * Rationing, interim form (see DECISIONS): below the trigger
     * the quartermaster imposes it as an emergency act; it lifts
     * above the lift line or on arrival. The quartermaster's
     * traits bend the trigger: an anxious quartermaster rations
     * early, a kind one late. Two hooks, no more.
     */
    rationing: {
      triggerDays: 12,
      liftDays: 16,
      consumptionFactor: 0.7,
      /** Strict rationing, the council's harder level. */
      strictFactor: 0.55,
      hungerCap: 0.55,
      moralePerDay: 0.02,
      traitTriggerShift: { anxious: 2, kind: -2 } as Record<string, number>,
    },
    /** Theft and hoarding: small hands in the stores, on scarcity. */
    theft: {
      /** Food below this many days (or rationed) tempts a thief. */
      scarceDays: 8,
      chancePerDay: 0.25,
      /** The hour of the ship's day the temptation is drawn. */
      checkTickOfDay: 53,
      /** One theft's take, in milli-units of food. */
      takeMilli: 350,
      witnessSuspicion: 0.5,
      partialSuspicion: 0.45,
      inventoryMinDelayTicks: 144,
      inventoryDelaySpanTicks: 288,
      /** What a cache feeds its owner per day, eaten in secret. */
      cacheEatMilliPerDay: 300,
    },
    /** Zero-store consequences, needs-level only in this build. */
    zero: {
      foodMoralePerDay: 0.05,
      oxygenStrainPerDay: 0.01,
    },
    /** Port calls: what a stay does to the stores and the crew. */
    port: {
      /** Resupply lands this many ticks into the stay. */
      resupplyDelayTicks: 6,
      /** Harbour news arrives this many ticks into the stay. */
      newsDelayTicks: 30,
      /** Shore leave rotates in blocks of this many ticks. */
      leaveBlockTicks: 36,
      leaveGroupSize: 4,
      shoreSocialPerTick: 0.004,
      shoreMoralePerTick: 0.002,
      /** Chance a call earns one flavour incident line. */
      incidentChance: 0.5,
      /** No port lets a ship sail shorter of fuel than this
       *  fraction of her tanks: emergency bunkering is a right of
       *  the road, whatever the port sells above it. */
      minDepartureFuelFraction: 0.55,
      /** Dockyard repair assist at a shipyard, per tick. */
      repairAssistPerTick: 0.0008,
      /** A shrine's gift is morale, not mass. */
      shrineMoraleGift: 0.15,
      /**
       * What a port can fill each store TO, as a fraction of
       * capacity, by the port's character. There is no money in
       * this build: resupply is by charter right and port
       * reciprocity, and the character's table is the whole cap.
       */
      supply: {
        industrial: { food: 0.7, water: 0.95, oxygen: 0.9, fuel: 0.8, parts: 0.95 },
        agrarian: { food: 1, water: 0.9, oxygen: 0.8, fuel: 0.7, parts: 0.5 },
        "free port": { food: 1, water: 1, oxygen: 1, fuel: 1, parts: 1 },
        refinery: { food: 0.6, water: 0.7, oxygen: 0.8, fuel: 1, parts: 0.85 },
        shrine: { food: 0.45, water: 0.5, oxygen: 0.6, fuel: 0.6, parts: 0.15 },
        "company town": { food: 0.95, water: 0.95, oxygen: 0.95, fuel: 0.95, parts: 0.95 },
        shipyard: { food: 0.7, water: 0.8, oxygen: 0.85, fuel: 0.8, parts: 1 },
        "listening post": { food: 0.35, water: 0.4, oxygen: 0.5, fuel: 0.55, parts: 0.2 },
      } as Record<string, Record<string, number>>,
      /** Flavour: one per call at most, beliefs-safe colour. */
      incidentLines: [
        "A wedding in the dock chapel at {port} delayed the liberty boats, happily.",
        "A brawl in a dockside bar at {port} was witnessed by half the liberty party and harmed no one aboard.",
        "The market at {port} ran a festival of lights while the ship lay berthed.",
        "A choir from the mission at {port} sang the liberty party back to the airlock.",
        "Longshore crews at {port} struck for a day over tea; the ship's boats ran the gap.",
        "A lost child at {port} was returned to her family by two of the liberty party, to general applause.",
      ],
      /** Harbour rumour, when no traffic gives the port news. */
      rumourLines: [
        "Harbour talk at {port} says {faction} is hiring hulls for quiet work.",
        "Harbour talk at {port} says {faction} quartermasters are buying food ahead of something.",
        "Harbour talk at {port} tells of a {faction} courier overdue and unmissed.",
        "Harbour talk at {port} says the {faction} berthing office has new orders and old grudges.",
      ],
    },
  },
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

  /**
   * Consequences: the body, harm, and the cause ledger (the
   * Consequences chapter). Harm is modeled, never rolled out of
   * nowhere: accident risk rides on work actually done, cascades
   * ride on system condition, sickness rides on water, air, and
   * crowding, and violence rides on grudges at their far end.
   * Every point of harm is booked to a cause in the ledger at the
   * moment it lands; death is health reaching zero through the
   * ledger, and nothing else.
   */
  health: {
    /** Body parts that carry wounds, in ledger order. */
    parts: ["head", "torso", "arms", "legs"],
    /**
     * Accident risk per tick for a member at work, before the
     * multipliers below. Work aboard is mostly safe; repair of a
     * failed system in a storm, tired and hurried, is not. Tuned
     * against the frequency law with the fleet table in DECISIONS:
     * a healthy 90-day voyage should see a handful of injuries
     * and zero to two deaths.
     */
    accidentPerTick: 0.00009,
    /** Activity danger: repair is hands inside machinery. */
    dangerRepair: 1.6,
    dangerWork: 0.7,
    /** System-kind danger for the room a member works in. */
    dangerByKind: {
      reactor: 1.7,
      engines: 1.5,
      "life support": 1.1,
      "water recycler": 0.8,
      "hydroponics rig": 0.6,
      comms: 0.5,
      "medbay unit": 0.3,
    } as Record<string, number>,
    stormFactor: 1.8,
    /** A failed system in the room: failed lighting, live faults. */
    failedRoomFactor: 1.7,
    /** Any failed system aboard: the ship hurries. */
    hurryFactor: 1.35,
    fatigueLowEnergy: 0.3,
    fatigueFactor: 1.9,
    tiredFactor: 1.3,
    tiredEnergy: 0.55,
    /** A drawn accident's wound severity lands in this span. */
    woundSeverityMin: 0.14,
    woundSeverityMax: 0.55,
    /** Immediate health booked when a wound lands, per severity. */
    woundImpact: 0.22,
    /** Bleeding: health per day per unit of wound severity. */
    bleedPerDay: 0.16,
    /** A treated wound bleeds at this fraction. */
    treatedBleedFactor: 0.25,
    /** Wound severity healed per day before treatment factors. */
    healPerDay: 0.16,
    treatedHealFactor: 1.6,
    medbayHealFactor: 1.7,
    restHealFactor: 1.4,
    /** No Chief Medical Officer: lay treatment at this strength. */
    layHealFactor: 0.55,
    /** Quiet health recovery per day when unwounded and well. */
    recoveryPerDay: 0.03,
    /** Infection: daily chance per unit severity, untreated. */
    infectionChancePerDay: 0.10,
    treatedInfectionFactor: 0.3,
    /** Infected wounds: health per day, and severity growth. */
    infectionHarmPerDay: 0.11,
    infectionGrowthPerDay: 0.05,
    /** A wound at or above this severity can leave a lasting mark. */
    markSeverity: 0.42,
    /** Cascades: health per day at zero condition / zero store. */
    airHarmPerDay: 0.11,
    oxygenZeroHarmPerDay: 0.1,
    radiationPerDay: 0.26,
    dehydrationPerDay: 0.13,
    starvationPerDay: 0.05,
    /** System conditions below which the cascades begin. */
    cascadeThreshold: 0.35,
    reactorCascadeThreshold: 0.3,
    /** Sickness: build-up per day from bad water, bad air, crowds. */
    sickWaterPerDay: 0.14,
    sickAirPerDay: 0.07,
    sickCrowdPerDay: 0.02,
    crowdSize: 5,
    /** A sick member (sick above spreadLine) infects roommates. */
    spreadLine: 0.6,
    spreadPerDay: 0.1,
    /** Sickness fades per day when the ship's water and air are sound. */
    sickRecoveryPerDay: 0.2,
    medbaySickFactor: 2.2,
    /** Health harm per day from sickness above the harm line. */
    sickHarmLine: 0.6,
    sickHarmPerDay: 0.07,
    /** Sickness onset is spoken once per crossing of this level. */
    sickOnsetLine: 0.6,
    /**
     * Violence, the far end of a grudge: the holder's trust in the
     * target at or below violenceTrust, morale at or below
     * violenceMorale, both awake in one room, and this chance per
     * tick on the "harm" stream. Rare by construction: all four
     * gates must stand open at once.
     */
    violenceTrust: -0.85,
    violenceMorale: 0.22,
    violenceChancePerTick: 0.0007,
    violenceTraitFactor: { bold: 0.6, "hot-tempered": 0.8 } as Record<
      string,
      number
    >,
    violenceCooldownTicks: 4320,
    /** The grudge must have burned at least this long, too. */
    violenceGrudgeAgeTicks: 288,
    violenceWoundMin: 0.3,
    violenceWoundMax: 0.62,
    /** Witnesses of an attack take this suspicion of the attacker. */
    violenceWitnessSuspicion: 0.55,
    /** A wounded member whose total severity reaches this is
     *  carried to the medbay by whoever stands with them. */
    carrySeverity: 0.85,
    /** Days of failed life support with an empty oxygen margin
     *  (or a reactor at the floor) before the ship is lost. */
    doomDays: 2,
  },

  /**
   * Crew skills (the "hands learn" chapter): seven disciplines,
   * levels 0 to 10, experience booked from work actually done in
   * integer milli-units, the way harm is booked to its ledger.
   * The booking is pure arithmetic and draws nothing from any
   * stream, so experience can never change a run's luck.
   */
  skills: {
    /** Cumulative milli-XP needed to REACH each level, 1 to 10.
     *  The gaps grow as they rise: the first levels of a new
     *  discipline come in days, the last levels of a mastered
     *  one take a voyage, and nobody reaches 10 in anything
     *  they did not board near. */
    thresholdsMilli: [
      20000, 55000, 105000, 175000, 270000, 430000, 610000, 820000, 1060000,
      1330000,
    ],
    /** The competence the old flat number's formulas read, per
     *  effective level: a level 7 hand reads 0.98, the way the
     *  chief engineer's rolled number read before the chapter. */
    skillPerLevel: 0.14,
    /** A hand at this level in a system's discipline can repair
     *  that system whether or not their role lists it: practice
     *  outranks the roster. */
    repairGateLevel: 6,
    /** An affinity holder needs at least this level in the
     *  system's discipline to repair it (the old 0.2 floor). */
    affinityGateLevel: 2,
    /** Milli-XP per tick of work, before difficulty and rate
     *  factors. Maintaining a system, repairing one, treating a
     *  patient, and the unguided work of a room, per tick. */
    maintainMilliPerTick: 50,
    repairMilliPerTick: 60,
    treatMilliPerTick: 55,
    genericMilliPerTick: 45,
    /** Duty work teaches its discipline slowly: chores are not
     *  mastery, and the tuning law caps cross-training. */
    dutyMilliPerTick: 15,
    /** A meal window served books this to the cook's husbandry:
     *  two windows a day, and the cook's primary trade has few
     *  other teachers in this engine, so the service carries the
     *  weight of a working day. Sized so a working cook gains
     *  about a level of husbandry in 90 days of service. */
    mealServiceMilli: 1150,
    /** A port resupply books this to the quartermaster's
     *  husbandry: the manifest and the loading are stores work,
     *  and stores handling is husbandry's named trade. */
    resupplyMilli: 2500,
    /** A repair that brings a damaged system back books this
     *  bonus to the hand that finished it. */
    completionBonusMilli: 800,
    /** Carrying a wounded crewmate to the medbay books this to
     *  the carrier's medicine: beside the medic is a school. */
    carryMilli: 440,
    /** The lesson of a work accident: milli-XP booked in the
     *  work's discipline, at the failure factor below. */
    failureMilli: 300,
    /** Difficulty of the work, from the system's condition when
     *  the work began: in the red teaches most, work on a damaged
     *  system next, routine maintenance least. Mirrors the
     *  systems chapter's strain and damaged lines. */
    difficultyRed: 2.5,
    difficultyDamaged: 1.75,
    difficultyRoutine: 1,
    /** Treatment teaches with the patient's hurt: the rate
     *  multiplier is 1 + total severity times this. */
    treatSeverityFactor: 2,
    /** A passion learns at this multiple of the booked rate. */
    passionFactor: 2,
    /** Necessity teaches at the passion rate: appointed cover,
     *  or work no able native hand remains aboard to do. */
    coverFactor: 2,
    /** Failure teaches at this fraction of the work's rate. */
    failureFactor: 0.5,
    /** Co-presence teaches at this fraction of the worker's
     *  booked lesson, to juniors standing with them. */
    mentorFraction: 0.2,
    /** A repair that draws parts from the locker also books
     *  fabrication at this fraction of the repair's lesson: the
     *  fabricator is not a system in this engine, and its work
     *  is the parts a repair consumes (see DECISIONS). */
    fabricationFraction: 0.2,
    /** Rust: a discipline unpractised for this many days loses
     *  this much milli-XP a day, down to the boarding level's
     *  threshold and never below. Gains are all rust can eat. */
    rustGraceDays: 7,
    rustMilliPerDay: 250,
    /** Marks cap the disciplines they touch at this effective
     *  level: a ruined hand caps engineering and fabrication, a
     *  lost eye caps operations. */
    markCapLevel: 5,
    /** Believed skill: at generation each observer's belief
     *  about a crewmate's level starts offset by at most this
     *  many levels, either way. */
    beliefOffsetMax: 2,
    /** A witnessed work session moves the witness's believed
     *  level this far toward the truth. */
    beliefCorrection: 0.5,
    /** Outside a session, a witness's belief corrects at most
     *  once per this many ticks per person and discipline. */
    beliefSeenGateTicks: 72,
    /** Testimony weight at an inquiry scales with the hearing
     *  officer's believed skill in the sitting's discipline:
     *  the factor is base + perLevel times believed level. */
    testimonyBeliefBase: 0.7,
    testimonyBeliefPerLevel: 0.06,
    /** The accident roll: each effective level in the work's
     *  discipline relieves this much of the danger, to a floor.
     *  A practised hand is a safer hand. */
    accidentReliefPerLevel: 0.045,
    accidentReliefFloor: 0.55,
    /** Treatment pricing: a treated body's healing scales by
     *  this plus the treater's medicine competence. Hands at
     *  medicine 0 heal at 0.6 of the old rate; the medic's
     *  practised hands heal faster than the old flat price. */
    treatHealBase: 0.6,
    /** Boarding levels per role, from the role table the flat
     *  number was drawn from: the chief engineer boards at
     *  engineering 7, the medic at medicine 6, the cook at
     *  husbandry 6 and almost nothing anywhere else. */
    boarding: {
      captain: { operations: 5, engineering: 1, husbandry: 1 },
      "executive officer": { operations: 4, engineering: 2, husbandry: 1 },
      "chief engineer": {
        engineering: 7,
        lifeSystems: 5,
        fabrication: 3,
        operations: 1,
      },
      engineer: { engineering: 6, lifeSystems: 4, fabrication: 3 },
      medic: { medicine: 6, lifeSystems: 1, husbandry: 1 },
      cook: { husbandry: 6, lifeSystems: 2 },
      botanist: { hydroponics: 4, lifeSystems: 2, husbandry: 2, medicine: 1 },
      pilot: { operations: 5, engineering: 3 },
      navigator: { operations: 5, engineering: 1 },
      "security officer": { operations: 3, engineering: 1, medicine: 1 },
      scientist: { operations: 4, hydroponics: 2, lifeSystems: 2 },
      quartermaster: { husbandry: 5, lifeSystems: 3, fabrication: 2, operations: 1 },
    } as Record<string, Record<string, number>>,
    /** The discipline a role's unguided work belongs to: the
     *  trade they ply when no system in the room claims them. */
    primary: {
      captain: "operations",
      "executive officer": "operations",
      "chief engineer": "engineering",
      engineer: "engineering",
      medic: "medicine",
      cook: "husbandry",
      botanist: "hydroponics",
      pilot: "operations",
      navigator: "operations",
      "security officer": "operations",
      scientist: "operations",
      quartermaster: "husbandry",
    } as Record<string, string>,
  },

  /**
   * The Ship's Council (the Council chapter): seven seats worn
   * over roles, sittings that judge from beliefs, and votes
   * computed from four inspectable terms with no dice at the
   * table. The numbers below are those terms' weights.
   */
  council: {
    /** Seats in sitting order, with the role that first wears each. */
    seats: [
      { key: "captain", seat: "Captain", role: "captain" },
      { key: "first officer", seat: "First Officer", role: "executive officer" },
      { key: "chief engineer", seat: "Chief Engineer", role: "chief engineer" },
      { key: "chief medical officer", seat: "Chief Medical Officer", role: "medic" },
      { key: "security chief", seat: "Security Chief", role: "security officer" },
      { key: "science officer", seat: "Science Officer", role: "scientist" },
      { key: "quartermaster", seat: "Quartermaster", role: "quartermaster" },
    ],
    /** A triggered sitting convenes this many ticks after its trigger. */
    conveneDelayTicks: 36,
    /** Ticks of each day at which the council's standing business runs. */
    appointmentTickOfDay: 30,
    rationTickOfDay: 60,
    reliefTickOfDay: 90,
    /** An inquiry into sabotage needs damage at or above this. */
    sabotageInquiryDamage: 0.55,
    /** A Security-certified accusation: the chief's own suspicion line. */
    certifiedSuspicion: 0.9,
    /** Discipline range for a Security accusation below certification. */
    disciplineSuspicion: 0.72,
    disciplineCooldownTicks: 2016,
    /** Boards are set-pieces, not a drumbeat: two judicial sittings
     *  sit at least this far apart, and one accused faces at most
     *  one accusation-born inquiry per this span. */
    inquiryGapTicks: 720,
    inquiryAccusedCooldownTicks: 2880,
    /** Vote score lines: at or above, for; at or below, against. */
    voteForLine: 0.12,
    voteAgainstLine: -0.12,
    /** The science seat abstains when its evidence is thinner than this. */
    scienceAbstainEvidence: 0.15,
    /** Median evidence lines for finding strength. */
    strengthStrong: 0.55,
    strengthFair: 0.3,
    /** Sentence lengths in ticks, by finding strength. */
    brigStrongTicks: 720,
    brigFairTicks: 432,
    quartersWeakTicks: 288,
    disciplineStrongTicks: 288,
    disciplineWeakTicks: 144,
    /** A bond at or above this recuses an officer from a case.
     *  Shipboard bonds run warm here (a month of socializing puts
     *  close shipmates near 0.7), so "closely bonded" is set at
     *  the inner circle, or half the bench stands down at once. */
    recuseBond: 0.8,
    /** Same department plus this bond also recuses. */
    recuseDeptBond: 0.5,
    /** Scapegoat testimony: suspicion pushed on officers, discounted. */
    scapegoatPush: 0.12,
    /** Witness testimony: suspicion pushed per witness statement. */
    testimonyPush: 0.07,
    testimonyWitnessCap: 3,
    /** Rationing: the council's lines, in days of supply. */
    rationEmergencyDays: 6,
    rationStrictDays: 8,
    /** Days a refused proposal waits before it may be re-tabled. */
    rationRefusalCooldownDays: 3,
    /** Emergency ratification must come within this many ticks. */
    ratifyWithinTicks: 144,
    /** Emergency powers: grant length and the renewal share ladder. */
    emergencyGrantTicks: 432,
    emergencyRenewalShareStep: 0.17,
    emergencyCooldownTicks: 432,
    /** Relief: officers at or below this trust in the captain,
     *  who also hold a settled grudge against them, may move. The
     *  double gate is what keeps the terminal motion rare: distrust
     *  alone is weather aboard a feuding ship. */
    reliefTrustLine: -0.85,
    reliefMoversNeeded: 3,
    reliefCooldownTicks: 8640,
    /** Legitimacy moves: per sitting, scaled by crew agreement. */
    legitimacySwing: 0.06,
    /** Findings vent suspicion: when a sitting concludes, every
     *  member's suspicion of the accused closes this share of its
     *  distance to the verdict's resting level (scaled by their
     *  trust in the chair: a distrusted bench vents less). What a
     *  court has judged stops circulating as raw suspicion. */
    ventShare: 0.35,
    ventRestAcquitted: 0.32,
    ventRestConvicted: 0.4,
    /** The ship's blocs: departments by role. A bench officer
     *  shields a department-mate on trial and backs a
     *  department-mate's claim, by these weights on the vote
     *  score. Small against the evidence term: loyalty bends a
     *  close vote, it does not buy one. */
    departments: {
      captain: "Command",
      "executive officer": "Command",
      "chief engineer": "Engineering",
      engineer: "Engineering",
      medic: "Medical",
      scientist: "Science",
      botanist: "Science",
      pilot: "Operations",
      navigator: "Operations",
      "security officer": "Operations",
      cook: "Services",
      quartermaster: "Services",
    } as Record<string, string>,
    factionShield: 0.12,
    /** Commendations: the council's one positive motion. A
     *  member who restores a failed system may be tabled for
     *  one, at most this often ship-wide and per member. */
    factionLoyalty: 0.06,
    commendationGlobalCooldownTicks: 1440,
    commendationMemberCooldownTicks: 4320,
    legitimacyStart: 0.7,
    /** Elections: one seat (never the captain's) comes up per
     *  cycle, on a stagger. A challenger from the seat's own
     *  department declares, the campaign runs its days in the
     *  open, and the whole crew votes: trust, bonds, department
     *  loyalty, incumbency, and whatever sway the campaign won.
     *  The winner takes the seat, not the job. */
    electionCycleDays: 45,
    firstElectionDay: 18,
    campaignDays: 3,
    campaignBeatTicks: 72,
    electionSwayPerBeat: 0.02,
    electionEndorseSway: 0.05,
    electionIncumbency: 0.08,
    electionDeptLoyalty: 0.18,
    electionBondWeight: 0.6,
    /** A seat holder below this health retires hurt at the daily check. */
    retireHealth: 0.3,
    /** Stores counts drift when the quartermaster's seat stands empty:
     *  milli-units of food lost to bad counting, per day. Booked as
     *  charged, so the stores identity still reconciles. */
    qmVacancyDriftMilliPerDay: 50,
    /**
     * Portfolio leanings per motion kind and seat key: the standing
     * bias the chronicle can name. Positive leans toward the motion
     * (convict, adopt, grant, relieve), negative against.
     */
    portfolioLean: {
      inquiry: {
        "security chief": 0.18,
        "chief engineer": 0.12,
        "chief medical officer": -0.08,
        "science officer": -0.1,
        quartermaster: 0.02,
        "first officer": 0,
        captain: 0,
      },
      discipline: {
        "security chief": 0.15,
        "first officer": 0.08,
        "chief medical officer": -0.06,
        "science officer": -0.05,
        quartermaster: 0,
        "chief engineer": 0.04,
        captain: 0,
      },
      rationing: {
        quartermaster: 0.22,
        "chief medical officer": -0.16,
        "first officer": 0.06,
        "security chief": 0.02,
        "chief engineer": 0,
        "science officer": 0,
        captain: 0.04,
      },
      emergency: {
        "chief engineer": 0.14,
        "security chief": 0.1,
        "first officer": 0.06,
        "chief medical officer": -0.04,
        "science officer": -0.06,
        quartermaster: 0.02,
        captain: 0.1,
      },
      relief: {
        "first officer": 0.08,
        "security chief": 0.04,
        "chief medical officer": 0,
        "science officer": -0.04,
        "chief engineer": 0,
        quartermaster: 0,
        captain: 0,
      },
      appointment: {
        "first officer": 0.05,
        "security chief": 0,
        "chief medical officer": 0,
        "science officer": 0,
        "chief engineer": 0,
        quartermaster: 0,
        captain: 0.08,
      },
    } as Record<string, Record<string, number>>,
    /** Personal trait leanings at the table, by motion family. */
    traitLean: {
      guilty: {
        kind: -0.12,
        gentle: -0.1,
        "hot-tempered": 0.06,
        anxious: 0.05,
        disciplined: -0.03,
        bold: 0.04,
      } as Record<string, number>,
      motion: {
        stubborn: -0.05,
        disciplined: 0.03,
        bold: 0.03,
        anxious: -0.03,
      } as Record<string, number>,
    },
    /**
     * Course decisions: at every port after the charter, the
     * council sets the course. The navigator lays the chart (the
     * chartered band, the previous port admitted under a standing
     * penalty), the captain tables a course as the motion, and the
     * officers vote it against their own best alternative, each
     * pricing the candidates from their portfolio. The weights
     * below are that pricing; the vote itself runs through the
     * same four-term machinery as every other motion.
     */
    course: {
      /** The sitting convenes this many ticks into the stay. */
      conveneAfterTicks: 12,
      /** The standing bias against sailing straight back. */
      previousPortPenalty: 0.12,
      /** A small pull toward new sky, felt by every officer. */
      unvisitedLean: 0.02,
      /** The tank does not reach: a candidate past the fuel
       *  counter's range is priced out of the argument. */
      fuelShortfallPenalty: 0.6,
      /** The leg's own burn, priced by projection: a candidate
       *  whose leg lands any store under this many projected
       *  days at arrival is priced down per day of shortfall.
       *  This is the term that keeps a council from voting a
       *  hurt ship onto a leg her air cannot finish. */
      projectionSafeLineDays: 6,
      projectionRiskWeight: 0.06,
      projectionRiskCap: 0.5,
      /** The damage report, read aloud: when the ship stands
       *  hurt (the worst system under this condition) or her
       *  repair position is short (parts under this many days
       *  on a worn ship), every officer prices a candidate by
       *  how well its parts supply answers damage, centred on
       *  this supply fraction. In a crisis the chart is read
       *  for survival first; the portfolios speak after. */
      crisisConditionLine: 0.55,
      crisisPartsLineDays: 10,
      crisisSupplyCentre: 0.55,
      crisisWeight: 1.2,
      /** In a crisis, time at sea is itself the risk: each day
       *  out is a day repairs cannot be made good. Priced per
       *  leg day, scaled by the crisis. The standing penalty
       *  on going back also yields as the crisis rises: the
       *  preference is for ordinary times. */
      crisisDistancePerDay: 0.01,
      /** The captain prices sea-days when tabling a course: a
       *  longer leg is more exposure, whatever it buys. */
      captainDistancePerDay: 0.004,
      /** Trust in the navigator, priced on their recommendation. */
      trustInProposerWeight: 0.15,
      /** The quartermaster's short line: a store under this many
       *  days is a need the next port should answer. */
      shortLineDays: 20,
      /** The quartermaster's fit is scaled to vote size by this. */
      storesFitScale: 0.35,
      /** The chief engineer's shipyard pull at a fully hurt ship. */
      shipyardPull: 0.55,
      /** Per-day distance risk the engineer prices on damage. */
      distanceRiskPerDay: 0.012,
      /** The medical officer's leave values, by port character. */
      leaveValue: {
        "free port": 0.25,
        shrine: 0.18,
        agrarian: 0.1,
        "company town": 0.08,
        shipyard: 0.06,
        industrial: 0.05,
        refinery: 0.04,
        "listening post": 0.02,
      } as Record<string, number>,
      /** The security chief's standing read of port characters. */
      securityLean: {
        "free port": -0.1,
        "company town": 0.06,
        "listening post": 0.04,
        shipyard: 0.02,
        shrine: 0.02,
      } as Record<string, number>,
      /** A theft in the recent log deepens the free-port lean. */
      recentTheftFreePortLean: -0.06,
      recentTheftWindowDays: 30,
    },
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
