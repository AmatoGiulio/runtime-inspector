# Visione

Runtime Inspector è un tool protocol-first per React Native.

Il suo scopo è permettere a una runtime app di dichiarare controlli modificabili in tempo reale e a un pannello esterno di renderizzarli automaticamente.

Il cuore architetturale non è il pannello. Il cuore è il contratto dichiarativo tra Runtime SDK e Client Panel.

## Perché

Molti tool di tuning per animazioni e UI finiscono per essere hardcoded, locali alla singola app, o dipendenti da una UI specifica. Runtime Inspector separa tre responsabilità:

- la runtime app dichiara cosa può essere controllato;
- il protocollo descrive schema, patch, preset ed errori;
- il panel renderizza controlli generici e invia modifiche live.

## Il protocollo è il mezzo, la demo è il prodotto

Nessuno adotta un protocollo: si adotta un tool che in 60 secondi fa muovere uno slider e cambia una spring dal vivo. Il protocollo è la stella polare architetturale; il successo si misura sulla developer experience:

- **Setup in 60 secondi**: da `runtime-inspector dev` a slider funzionante su device reale, zero config.
- **Il loop deve chiudersi nel codice**: il tuning trovato non muore nel pannello. "Copy as code" trasforma i valori scelti in codice pronto da incollare (es. `withSpring(x, { damping: 14, stiffness: 180 })`).
- **Il tuning si fa al tatto**: le animazioni si giudicano sul device fisico, non nel simulatore. Il supporto a device reale (LAN + QR) è un requisito, non un nice-to-have.

## Il panel è un client, non "il" client

Se il protocollo è disegnato bene, il broker WebSocket e il panel web sono dettagli implementativi sostituibili. Client previsti sopra lo stesso protocollo:

- **Panel web** (oggi): il client di riferimento.
- **Plugin React Native DevTools via Rozenite** (poi): distribuzione dentro l'ecosistema DevTools ufficiale, senza finestre o server extra. È la prova concreta della tesi "protocol-first, panel intercambiabili".
- **Agenti AI** (oggi, `packages/client-mcp`): un protocollo dichiarativo e tipizzato è perfetto per un agente. Il client MCP si connette al broker come "panel" e fa tuning iterativo (cambia parametri → osserva → ripeti). Il broker non distingue chi manda i patch: un agente è solo un client in più — tesi già dimostrata dal vivo.

## Primo obiettivo

Validare e rendere indistruttibile il loop minimo:

`Panel Web -> broker WebSocket -> runtime React Native -> SharedValue/Reanimated`

Il tuning di motion è comparativo per natura ("meglio questa o quella?"): il loop deve supportare replay dell'animazione dal pannello e confronto rapido tra set di parametri.

La prima fase deve restare piccola, leggibile e sviluppabile da agenti AI.

## Non obiettivi ora

- Nitro;
- desktop app;
- plugin system completo;
- recording;
- discovery remota;
- autorizzazione avanzata;
- monetizzazione: questo progetto vale come reputazione ed ecosistema, non come revenue. Un eventuale prodotto a pagamento (collaborazione designer↔dev via tunnel remoto) è fuori scope per questa fase.
