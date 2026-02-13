# API & KI-Integration

Das Herzstück des Gateways ist die Integration der Google Gemini API via `@google/genai`.

## Modell-Konfiguration
Wir verwenden primär folgende Modelle:
- **gemini-3-flash-preview**: Für schnelle Analysen, Chat-Antworten und Echtzeit-Routing.
- **gemini-3-pro-preview**: Für komplexe Planungsprozesse in den Worker-Nodes.
- **gemini-2.5-flash-native-audio-preview**: Für den Voice-Modus und Live-Audio-Streaming.

## Tool-Capabilities
Die Agenten verfügen über spezialisierte Funktionen (Function Calling):
- `browser_snapshot`: Erfasst den Status des verwalteten Browsers.
- `location_get`: Ermittelt die GPS-Koordinaten des aktiven Nodes.
- `system_notify`: Sendet System-Benachrichtigungen an den Host.

## Token-Tracking
Das Gateway schätzt den Token-Verbrauch in Echtzeit (ca. 1 Token pro 4 Zeichen) und visualisiert diesen im Dashboard zur Kostenkontrolle.
