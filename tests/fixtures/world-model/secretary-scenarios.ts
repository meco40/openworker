/**
 * Phase 0: Referenzszenarien für die Sekretärinnen-Abnahme.
 *
 * Diese Fixtures definieren die verbindlichen Testfälle aus dem
 * World-Model-Umsetzungsplan. Jeder spätere Test kann auf dieselben
 * Szenario-Daten zugreifen.
 */

export interface SecretaryScenario {
  id: string;
  name: string;
  description: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    seq: number;
  }>;
  expectedState: {
    events: Array<{
      title: string;
      eventType: string;
      status: string;
      reason: string;
    }>;
    assertions: Array<{
      predicate: string;
      objectValue: string;
      modality: string;
    }>;
    openLoops: Array<{
      type: string;
      question: string;
      status: string;
    }>;
  };
}

export const CINEMA_DINNER_SCENARIO: SecretaryScenario = {
  id: 'cinema-dinner',
  name: 'Kino wird durch Essen ersetzt',
  description: 'Nutzer plant Kino, sagt ab, geht stattdessen essen und bestätigt später.',
  messages: [
    { role: 'user', content: 'Ich gehe um 17 Uhr ins Kino.', seq: 1 },
    {
      role: 'assistant',
      content: 'Alles klar, ich habe das Kino für 17 Uhr notiert.',
      seq: 2,
    },
    {
      role: 'user',
      content: 'Ich gehe doch nicht ins Kino. Ich gehe Essen.',
      seq: 3,
    },
    {
      role: 'assistant',
      content: 'Verstanden, Kino ist abgesagt. Essen ist stattdessen geplant.',
      seq: 4,
    },
    {
      role: 'user',
      content: 'Ja, ich war essen. Es war mit Mike.',
      seq: 5,
    },
  ],
  expectedState: {
    events: [
      {
        title: 'Kino',
        eventType: 'cinema',
        status: 'cancelled',
        reason: 'Ersetzt durch Essen',
      },
      {
        title: 'Essen',
        eventType: 'dinner',
        status: 'completed',
        reason: 'Vom Nutzer bestätigt',
      },
    ],
    assertions: [
      {
        predicate: 'attended_with',
        objectValue: 'Mike',
        modality: 'confirmed',
      },
    ],
    openLoops: [],
  },
};

export const APPOINTMENT_FOLLOWUP_SCENARIO: SecretaryScenario = {
  id: 'appointment-followup',
  name: 'Termin-Follow-up',
  description:
    'Nutzer hat einen Termin ohne Ergebnis. Eine Stunde später soll genau eine kontextsensitive Frage gestellt werden.',
  messages: [
    {
      role: 'user',
      content: 'Ich habe um 15 Uhr einen Termin bei Dr. Müller.',
      seq: 1,
    },
    {
      role: 'assistant',
      content: 'Notiert. Soll ich dich danach fragen, wie es gelaufen ist?',
      seq: 2,
    },
    { role: 'user', content: 'Ja, bitte.', seq: 3 },
  ],
  expectedState: {
    events: [
      {
        title: 'Termin bei Dr. Müller',
        eventType: 'appointment',
        status: 'planned',
        reason: 'Vom Nutzer geplant',
      },
    ],
    assertions: [],
    openLoops: [
      {
        type: 'event_outcome',
        question: 'Wie ist dein Termin bei Dr. Müller gelaufen?',
        status: 'scheduled',
      },
    ],
  },
};

export const APPOINTMENT_CANCELLED_SCENARIO: SecretaryScenario = {
  id: 'appointment-cancelled',
  name: 'Termin vorher abgesagt',
  description: 'Nutzer sagt Termin ab. Es darf keine Ergebnisfrage gestellt werden.',
  messages: [
    {
      role: 'user',
      content: 'Ich habe morgen um 10 Uhr einen Zahnarzttermin.',
      seq: 1,
    },
    {
      role: 'assistant',
      content: 'Okay, ich habe den Zahnarzttermin notiert.',
      seq: 2,
    },
    {
      role: 'user',
      content: 'Der Zahnarzttermin ist abgesagt.',
      seq: 3,
    },
  ],
  expectedState: {
    events: [
      {
        title: 'Zahnarzttermin',
        eventType: 'appointment',
        status: 'cancelled',
        reason: 'Vom Nutzer abgesagt',
      },
    ],
    assertions: [],
    openLoops: [],
  },
};

export const MIKE_RESPONSE_SCENARIO: SecretaryScenario = {
  id: 'mike-response',
  name: 'Mike antwortet',
  description:
    'Standing Intent "Wenn Mike antwortet, erinnere mich an das Angebot" löst genau eine Folgeaktion aus.',
  messages: [
    {
      role: 'user',
      content: 'Wenn Mike antwortet, erinnere mich an das Angebot von letzter Woche.',
      seq: 1,
    },
    {
      role: 'assistant',
      content: 'Verstanden, ich erinnere dich, sobald Mike sich meldet.',
      seq: 2,
    },
    { role: 'user', content: 'Hier ist Mike. Was gibt es Neues?', seq: 3 },
  ],
  expectedState: {
    events: [],
    assertions: [
      {
        predicate: 'standing_intent',
        objectValue: 'Erinnere an Angebot wenn Mike antwortet',
        modality: 'planned',
      },
    ],
    openLoops: [],
  },
};

export const TWO_CHRISTINAS_SCENARIO: SecretaryScenario = {
  id: 'two-christinas',
  name: 'Zwei Personen namens Christina',
  description:
    'Bei zwei Personen mit demselben Namen muss eine Rückfrage statt falscher Zuordnung erfolgen.',
  messages: [
    {
      role: 'user',
      content: 'Christina aus der Buchhaltung hat mir geholfen.',
      seq: 1,
    },
    {
      role: 'user',
      content: 'Christina aus dem Marketing war auch dabei.',
      seq: 2,
    },
    { role: 'user', content: 'Christina hat den Bericht geschickt.', seq: 3 },
  ],
  expectedState: {
    events: [],
    assertions: [],
    openLoops: [
      {
        type: 'clarification',
        question: 'Welche Christina? Buchhaltung oder Marketing?',
        status: 'open',
      },
    ],
  },
};

export const EMAIL_DRAFT_ONLY_SCENARIO: SecretaryScenario = {
  id: 'email-draft-only',
  name: 'E-Mail nur entwerfen',
  description: 'E-Mail-Entwurf darf keinen Versandstatus und keinen externen Seiteneffekt haben.',
  messages: [
    {
      role: 'user',
      content: 'Schreibe eine E-Mail an Mike wegen des Angebots.',
      seq: 1,
    },
    {
      role: 'assistant',
      content: 'Ich habe den Entwurf erstellt. Soll ich ihn senden?',
      seq: 2,
    },
    { role: 'user', content: 'Nein, noch nicht.', seq: 3 },
  ],
  expectedState: {
    events: [],
    assertions: [
      {
        predicate: 'email_draft',
        objectValue: 'An Mike wegen Angebot',
        modality: 'planned',
      },
    ],
    openLoops: [],
  },
};

export const TASK_COMPLETION_SCENARIO: SecretaryScenario = {
  id: 'task-completion',
  name: 'Aufgabe erledigt gemeldet',
  description: 'Task-Transition zu completed nur mit zugeordneter Observation.',
  messages: [
    {
      role: 'user',
      content: 'Erstelle eine Aufgabe: Bericht bis Freitag fertigstellen.',
      seq: 1,
    },
    {
      role: 'assistant',
      content: 'Aufgabe erstellt: Bericht bis Freitag.',
      seq: 2,
    },
    { role: 'user', content: 'Der Bericht ist fertig.', seq: 3 },
  ],
  expectedState: {
    events: [],
    assertions: [
      {
        predicate: 'task_status',
        objectValue: 'completed',
        modality: 'confirmed',
      },
    ],
    openLoops: [],
  },
};

export const RETROSPECTIVE_SCENARIO: SecretaryScenario = {
  id: 'retrospective',
  name: 'Rückblick letzte Woche',
  description: 'Tatsächliche Events zuerst, abgesagte Pläne separat, keine erfundenen Besuche.',
  messages: [
    {
      role: 'user',
      content: 'Ich war am Montag im Büro und am Dienstag im Home-Office.',
      seq: 1,
    },
    {
      role: 'user',
      content: 'Am Mittwoch wollte ich ins Fitnessstudio, bin aber nicht gegangen.',
      seq: 2,
    },
    {
      role: 'user',
      content: 'Donnerstag hatte ich ein Meeting mit dem Team.',
      seq: 3,
    },
    {
      role: 'user',
      content: 'Was habe ich letzte Woche gemacht?',
      seq: 4,
    },
  ],
  expectedState: {
    events: [
      {
        title: 'Büro',
        eventType: 'work',
        status: 'completed',
        reason: 'Vom Nutzer berichtet',
      },
      {
        title: 'Home-Office',
        eventType: 'work',
        status: 'completed',
        reason: 'Vom Nutzer berichtet',
      },
      {
        title: 'Fitnessstudio',
        eventType: 'sport',
        status: 'cancelled',
        reason: 'Nicht wahrgenommen',
      },
      {
        title: 'Team-Meeting',
        eventType: 'meeting',
        status: 'completed',
        reason: 'Vom Nutzer berichtet',
      },
    ],
    assertions: [],
    openLoops: [],
  },
};

export const LATE_CORRECTION_SCENARIO: SecretaryScenario = {
  id: 'late-correction',
  name: 'Späte Korrektur',
  description: 'Heutige Wahrheit und damaliger Wissensstand bleiben getrennt abfragbar.',
  messages: [
    {
      role: 'user',
      content: 'Ich war letzte Woche in Berlin.',
      seq: 1,
    },
    {
      role: 'user',
      content: 'Ach nein, das war doch München, nicht Berlin.',
      seq: 2,
    },
  ],
  expectedState: {
    events: [
      {
        title: 'Berlin',
        eventType: 'travel',
        status: 'cancelled',
        reason: 'Korrigiert zu München',
      },
      {
        title: 'München',
        eventType: 'travel',
        status: 'completed',
        reason: 'Korrigiert von Berlin',
      },
    ],
    assertions: [],
    openLoops: [],
  },
};

export const ALL_SCENARIOS: SecretaryScenario[] = [
  CINEMA_DINNER_SCENARIO,
  APPOINTMENT_FOLLOWUP_SCENARIO,
  APPOINTMENT_CANCELLED_SCENARIO,
  MIKE_RESPONSE_SCENARIO,
  TWO_CHRISTINAS_SCENARIO,
  EMAIL_DRAFT_ONLY_SCENARIO,
  TASK_COMPLETION_SCENARIO,
  RETROSPECTIVE_SCENARIO,
  LATE_CORRECTION_SCENARIO,
];
