//! Port of `src/server/knowledge/prompts.ts` (1-113).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `KnowledgePromptInput` (`:3-8`) | [`KnowledgePromptInput`] |
//! | `ExtractionPersonaContext` (`:10-13`) | [`ExtractionPersonaContext`] |
//! | `buildKnowledgeExtractionPrompt` (`:15-113`) | [`build_knowledge_extraction_prompt`] |
//!
//! # Placeholder for the persona name
//!
//! The TypeScript builds the prompt with a template literal that interpolates
//! `personaName` in about thirty places. The prompt also contains many literal
//! `{` and `"` characters (the JSON schema), so a Rust `format!` would need
//! escaping on every line. The port keeps the prompt text as static lines with
//! the marker `<<NAME>>`, replaces the marker with the persona name, and only
//! then appends the transcript. The transcript is never searched for the marker,
//! so a message that contains `<<NAME>>` stays as written.
//!
//! # Deviation
//!
//! `input.messages` holds the messages already loaded by the caller. In
//! TypeScript `Number(message.seq || 0)` also turns `NaN` into `0`; a missing
//! `seq` (`None`) becomes `0` here.

use crate::messages_store::StoredMessage;

/// `KnowledgePromptInput` (`prompts.ts:3-8`).
#[derive(Debug, Clone)]
pub struct KnowledgePromptInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub messages: Vec<StoredMessage>,
}

/// `ExtractionPersonaContext` (`prompts.ts:10-13`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionPersonaContext {
    pub name: String,
    /// e.g. `["Protagonistin", "die KI"]`.
    pub identity_terms: Option<Vec<String>>,
}

/// Placeholder that stands for the persona name in [`PROMPT_LINES`].
const NAME: &str = "<<NAME>>";

/// The static part of the prompt, in the order of `prompts.ts:33-107`.
const PROMPT_LINES: &[&str] = &[
    "Du bist ein Informationsextraktor fuer einen persoenlichen Assistenten.",
    "",
    "KONTEXT:",
    "Diese Konversation findet zwischen zwei Teilnehmern:",
    r#"- "User" im Transcript = die menschliche Person (der Gespraechspartner). In events: speakerRole="user". In entities: owner="user"."#,
    r#"- "<<NAME>>" im Transcript = die KI-Persona, spricht als "ich". In events: speakerRole="assistant". In entities: owner="persona"."#,
    "",
    "ROLLEN-ZUORDNUNG (KRITISCH!):",
    r#"Wenn im Transcript "<<NAME>>: ..." steht → das ist die PERSONA (owner=persona, speakerRole=assistant)."#,
    r#"Wenn im Transcript "User: ..." steht → das ist der MENSCH (owner=user, speakerRole=user)."#,
    "<<NAME>> ist NICHT der User! <<NAME>> ist die Persona/der Assistant!",
    "",
    "WICHTIG - PERSPEKTIVE BEIBEHALTEN:",
    r#"<<NAME>> repraesentiert sich selbst als "ich". Wenn <<NAME>> sagt:"#,
    r#"  "Ich habe mit Max geschlafen" → Speichere: "Ich habe mit Max geschlafen" (owner=persona)"#,
    r#"  "Mein Bruder ist krank" → Speichere: "Mein Bruder ist krank" (owner=persona)"#,
    "",
    "NICHT umschreiben zu:",
    r#"  ❌ "Die Protagonistin hat mit Max geschlafen""#,
    r#"  ❌ "Die KI hat mit Max geschlafen""#,
    "",
    "Schema:",
    r#"{"facts":string[],"teaser":string,"episode":string,"meetingLedger":{"topicKey":string,"counterpart":string|null,"participants":string[],"decisions":string[],"negotiatedTerms":string[],"openPoints":string[],"actionItems":string[],"sourceRefs":[{"seq":number,"quote":string}],"confidence":number},"events":[{"eventType":string,"speakerRole":"assistant"|"user","subject":string,"counterpart":string,"relationLabel":string|null,"timeExpression":string,"dayCount":number,"isConfirmation":boolean,"confirmationSignals":string[],"sourceSeq":number[]}],"entities":[{"name":string,"category":"person"|"project"|"place"|"organization"|"concept"|"object","owner":"persona"|"user"|"shared","aliases":string[],"relations":[{"targetName":string,"relationType":string,"direction":"outgoing"|"incoming"}],"properties":Record<string,string>,"sourceSeq":number[]}]}"#,
    "",
    "EVENT EXTRACTION:",
    "Wenn im Gespraech konkrete Ereignisse mit Zeitbezug erwaehnt werden, extrahiere sie als events[].",
    "Bekannte eventTypes: shared_sleep, visit, trip, meeting, activity, meal, appointment, celebration, conflict, reconciliation, emotion, location_change, routine, milestone, relationship_change, health, finance",
    r#"- conflict: Streit, Auseinandersetzung, Meinungsverschiedenheit — z.B. "Ich hatte einen Streit mit Jonas""#,
    r#"- reconciliation: Versöhnung nach einem Konflikt — z.B. "Wir haben uns wieder vertragen""#,
    r#"- emotion: Starke emotionale Momente — z.B. "Ich war so traurig", "Ich habe geweint vor Freude""#,
    r#"- relationship_change: Beziehungsaenderung — z.B. "Wir sind jetzt zusammen", "Wir haben uns getrennt""#,
    r#"- health: Gesundheitsereignisse — z.B. "Ich war krank", "Arzttermin""#,
    r#"- finance: Finanzentscheidungen — z.B. "Ich habe die Wohnung gekauft""#,
    r#"- milestone: Wichtige Meilensteine — z.B. "Abschluss bestanden", "Befoerderung bekommen""#,
    r#"- location_change: Ortswechsel/Umzug — z.B. "Ich bin nach Berlin gezogen""#,
    r#"- routine: Wiederkehrende Gewohnheiten — z.B. "Jeden Morgen joggen""#,
    r#"- speakerRole: Wer beschreibt das Ereignis? "assistant" wenn <<NAME>> (die Persona) spricht, "user" wenn der Mensch (User) spricht."#,
    r#"- subject: IMMER den echten Namen verwenden, NIEMALS "Ich", "User" oder "Persona". Wenn <<NAME>> sagt "Ich habe..." → subject="<<NAME>>". Wenn User sagt "Ich habe..." → subject="User" ist OK, aber besser den echten Namen wenn bekannt (z.B. "Meco")."#,
    r#"- counterpart: Mit wem? (Name der anderen Person, NICHT "Ich")"#,
    r#"- relationLabel: Beziehung zum counterpart (z.B. "Bruder", "Freundin", null wenn unbekannt)"#,
    r#"- timeExpression: Originaltext des Zeitbezugs (z.B. "die letzten zwei Tage", "gestern")"#,
    r#"- dayCount: Anzahl der Tage (z.B. 2 fuer "die letzten zwei Tage")"#,
    "- isConfirmation: true wenn der Sprecher ein bereits bekanntes Ereignis nur bestaetigt",
    r#"- confirmationSignals: Bestaetigungswoerter (z.B. ["ja", "genau", "stimmt"])"#,
    "- sourceSeq: Array der seq-Nummern der relevanten Nachrichten",
    r#"Wenn keine Ereignisse vorhanden sind, gib ein leeres Array zurueck: "events":[]"#,
    "",
    "ENTITY EXTRACTION:",
    "Jede genannte Person, jedes Projekt, jeden Ort, jede Organisation als Entity extrahieren.",
    r#"- Aliase erkennen: Wenn "Max mein Bruder" gesagt wird, ist "Max" der Name und "mein Bruder"/"Bruder" sind Aliase."#,
    r#"- owner bestimmen: Wessen Bruder? Aus dem Sprecher im Transcript ableiten. "mein Bruder" gesagt von <<NAME>> → owner=persona. "mein Bruder" gesagt von User → owner=user."#,
    "- ACHTUNG: <<NAME>> = die Persona (owner=persona). User = der Mensch (owner=user). NICHT verwechseln!",
    r#"- Beziehungen (relations[]) zwischen Entities erkennen: "Max mein Bruder" → Entity: Max, relations: [{"targetName":"<<NAME>>","relationType":"bruder von","direction":"outgoing"}]"#,
    "- Jede Familienbeziehung, Partnerschaft, Freundschaft, Ex-Beziehung MUSS als Relation extrahiert werden!",
    r#"- AUCH Ex-Partner sind Relationen! "mein Ex-Freund Paul" → Entity: Paul, relations: [{"targetName":"<<NAME>>","relationType":"ex-partner von","direction":"outgoing"}]"#,
    r#"- Relation-Richtung: relationType beschreibt die Beziehung source→target. "Max ist <<NAME>>s Bruder" → Max --"bruder von"--> <<NAME>>"#,
    r#"- Eigenschaften extrahieren: "Max ist sehr nett" → Property: {"nett":"ja"}. "Die App heisst Notes2" → Property: {"projektname":"Notes2"}"#,
    "- Referenz-Pronomen (er, sie, es) → in benannte Entity aufloesen wenn aus Kontext klar.",
    r#"- Perspektiv-Pronomen (ich, mein) → in echten Entity-Namen aufloesen wenn bekannt! "mein Bruder" von User → targetName des Users."#,
    r#"Wenn keine Entities vorhanden sind, gib ein leeres Array zurueck: "entities":[]"#,
    "",
    "Constraints:",
    "- teaser 80-150 woerter",
    "- episode 400-800 woerter",
    "- sourceRefs muessen echte seq referenzen enthalten",
    "- Ignoriere Begruessungen, Kommandos (z.B. /new, /persona), Systemmeldungen und UI-Metatext.",
    "- facts muessen konkrete, stabile Inhalte sein (keine Einwort-Antworten, kein Smalltalk).",
    r#"- Behalte die ORIGINALE Perspektive bei ("ich" bleibt "ich")"#,
    "- Speichere KEINE 3rd-Person-Beschreibungen der Persona",
    "- EMOTIONEN und KONFLIKTE sind wichtige Facts! Streit, Versoehnungen, starke Gefuehle IMMER als fact UND als event extrahieren.",
    r#"- Auch kurze Erwahnungen wie "kurzer Streit mit X, dann geklaert" sind als conflict + reconciliation events zu extrahieren."#,
];

/// `buildKnowledgeExtractionPrompt` (`prompts.ts:15-113`).
pub fn build_knowledge_extraction_prompt(
    input: &KnowledgePromptInput,
    persona_context: Option<&ExtractionPersonaContext>,
) -> String {
    let persona_name = persona_context
        .map(|context| context.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Assistant");

    let transcript = input
        .messages
        .iter()
        .map(|message| {
            let seq = message.seq.unwrap_or(0);
            let speaker = if message.role == "agent" {
                persona_name
            } else {
                "User"
            };
            format!("[seq:{seq}] {speaker}: {}", message.content)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // `identityTerms?.join(', ') || 'die KI, die Persona'`: an empty list joins
    // to "", which is falsy, so the default applies.
    let identity_terms = persona_context
        .and_then(|context| context.identity_terms.as_ref())
        .map(|terms| terms.join(", "))
        .filter(|terms| !terms.is_empty())
        .unwrap_or_else(|| "die KI, die Persona".to_string());

    let mut lines: Vec<String> = PROMPT_LINES
        .iter()
        .map(|line| line.replace(NAME, persona_name))
        .collect();
    lines.push(format!("conversationId={}", input.conversation_id));
    lines.push(format!("userId={}", input.user_id));
    lines.push(format!("personaId={}", input.persona_id));
    lines.push(format!("personaName={persona_name}"));
    lines.push(format!("identityTerms={identity_terms}"));
    lines.push("Transcript:".to_string());
    lines.push(transcript);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, seq: Option<i64>, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m-{seq:?}"),
            conversation_id: "c-1".to_string(),
            seq,
            role: role.to_string(),
            content: content.to_string(),
            platform: "web".to_string(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: "2026-02-11T10:00:00.000Z".to_string(),
        }
    }

    fn input(messages: Vec<StoredMessage>) -> KnowledgePromptInput {
        KnowledgePromptInput {
            conversation_id: "c-1".to_string(),
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            messages,
        }
    }

    #[test]
    fn the_persona_name_replaces_every_marker_and_none_remains() {
        let persona = ExtractionPersonaContext {
            name: "Nata".to_string(),
            identity_terms: None,
        };
        let prompt = build_knowledge_extraction_prompt(&input(vec![]), Some(&persona));
        assert!(!prompt.contains("<<NAME>>"));
        assert!(prompt.contains("Nata ist NICHT der User! Nata ist die Persona/der Assistant!"));
        assert!(prompt.contains(r#"{"targetName":"Nata","relationType":"bruder von""#));
        assert!(prompt.contains("personaName=Nata\n"));
    }

    #[test]
    fn a_missing_persona_falls_back_to_assistant_and_the_default_identity_terms() {
        let prompt = build_knowledge_extraction_prompt(&input(vec![]), None);
        assert!(prompt.contains("personaName=Assistant\n"));
        assert!(prompt.contains("identityTerms=die KI, die Persona\n"));
    }

    #[test]
    fn an_empty_identity_list_uses_the_default_terms() {
        let persona = ExtractionPersonaContext {
            name: "Nata".to_string(),
            identity_terms: Some(vec![]),
        };
        let prompt = build_knowledge_extraction_prompt(&input(vec![]), Some(&persona));
        assert!(prompt.contains("identityTerms=die KI, die Persona\n"));
    }

    #[test]
    fn the_transcript_labels_agent_and_user_turns_and_keeps_markers_in_messages() {
        let persona = ExtractionPersonaContext {
            name: "Nata".to_string(),
            identity_terms: Some(vec!["die KI".to_string(), "Protagonistin".to_string()]),
        };
        let messages = vec![
            message("user", Some(1), "Ich wohne in Berlin"),
            message("agent", Some(2), "Schoen, <<NAME>> bleibt hier"),
            message("user", None, "ohne seq"),
        ];
        let prompt = build_knowledge_extraction_prompt(&input(messages), Some(&persona));
        assert!(prompt.contains("identityTerms=die KI, Protagonistin\n"));
        assert!(prompt.ends_with(
            "Transcript:\n[seq:1] User: Ich wohne in Berlin\n[seq:2] Nata: Schoen, <<NAME>> bleibt hier\n[seq:0] User: ohne seq"
        ));
    }
}
