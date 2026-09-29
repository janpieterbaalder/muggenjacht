# Nog één mug — browsergame (G1)

Babylon.js 9.27, TypeScript 7, Vite 8. Alleen `dist/` hoort in een oplevering; bronfoto's en dossier nooit.

```
npm ci            # eenmalig
npm run dev       # http://127.0.0.1:5173 (dev: window.mjDev hulpmiddelen)
npm test          # rolldown-gebundelde node:test suites (tests/)
npm run build     # tsc --noEmit && vite build -> dist/
```

## Structuur
- `src/game/` — core (engine, camera, beweging, deuren), doors (deurbladen: onderlinge botsing, opzij duwen), session (ronde-runtime), rounds (10 rondes + oefenen), save.
- `src/engine/` — world (GLB, lichtkaarten, probes, hemel, deuren), lightmap (gebakken irradiantie-plugin), whitebalance.
- `src/physics/` — driehoeks-BVH, spelerscapsule. `src/swatter/` — slag + continue botsing, hand/mouw/mepper-weergave.
- `src/mosquito/` — gedrag en model. `src/audio/` — Web Audio. `public/audio/buzz-worklet.js` — zoemsynthese.
- `public/assets/` — gegenereerd door `hulpmiddelen/chalet/pipeline.py` (chalet.glb, chalet_coll.bin, lm/, probes/, sky/) en `hulpmiddelen/chalet/bl/hand.py` (arm.glb).

## Buitentafel: aanpassing in de gegenereerde bestanden
De tafel op de veranda (160 x 90 cm, midden x 1,30 / z 1,25 in het Babylon-frame) met zes stoelen die naar de tafel kijken
(noord en zuid op x 0,90 en 1,70, koppen op x 0,33 en 2,27) is op 29-09-2026 rechtstreeks in `chalet.glb`,
`chalet_coll.bin` en `lm/lm_D_{dag,avond,nacht}.jpg` gezet: elke stoel is een verschoven kopie van een oude stoel die al
de goede kant op keek; het tafelblad is in het midden verlengd. De schaduwen op het dek zijn herberekend (verhouding van de
hemel- en lichtzichtbaarheid met nieuwe en oude meubels, gefit op de oude bake). De bron (`hulpmiddelen/chalet`) heeft de
oude opstelling nog: zonder dezelfde wijziging daar zet een nieuwe export de vier stoelen met de rug naar de tafel terug.
`tests/veranda.test.ts` bewaakt de opstelling.

## Licht
Cycles-bake (lichtkaarten per atlas A–F, OIDN-ontruist) vervangt de omgevingsirradiantie van de PBR-shader; reflecties uit box-geprojecteerde probes (opgenomen in het boxmidden). Belichting en witbalans volgen de gebakken meetwaarden op de plek van de speler (camera-achtig, zie BESLUITEN D39).
