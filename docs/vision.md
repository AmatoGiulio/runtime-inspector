# Visione

Runtime Inspector è un tool protocol-first per React Native.

Il suo scopo è permettere a una runtime app di dichiarare controlli modificabili in tempo reale e a un pannello esterno di renderizzarli automaticamente.

Il cuore non è il pannello. Il cuore è il contratto dichiarativo tra Runtime SDK e Client Panel.

## Perché

Molti tool di tuning per animazioni e UI finiscono per essere hardcoded, locali alla singola app, o dipendenti da una UI specifica. Runtime Inspector separa tre responsabilità:

- la runtime app dichiara cosa può essere controllato;
- il protocollo descrive schema, patch, preset ed errori;
- il panel renderizza controlli generici e invia modifiche live.

## Primo obiettivo

Validare il loop minimo:

`Panel Web -> broker WebSocket -> runtime React Native -> SharedValue/Reanimated`

La prima fase deve restare piccola, leggibile e sviluppabile da agenti AI.

## Non obiettivi ora

- Nitro;
- desktop app;
- plugin system completo;
- recording;
- discovery remota;
- autorizzazione avanzata.
