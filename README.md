# Muggenjacht — "Nog één mug"

Browsergame (Babylon.js, WebGL 2): jaag in een chalet op muggen, van namiddag tot bedtijd, in tien rondes.
Bedoeld voor een telefoon in liggende stand; werkt ook op een desktopbrowser met muis en toetsenbord.

## Structuur

- `spel/` — het spel: broncode (`src/`), tests (`tests/`) en de spelbestanden (`public/`). Zie `spel/README.md`.
- Alleen de spelbestanden staan in deze repository. Referentiefoto's, het dossier en de bouwhulpmiddelen niet.

## Lokaal draaien

Vereist Node.js 22 of nieuwer (lokaal getest met 22; Vercel bouwt met 24).

```
cd spel
npm ci
npm run dev      # http://127.0.0.1:5173
npm test
npm run build    # -> spel/dist/
```

## Publiceren (Vercel)

Importeer deze repository in Vercel (vercel.com/new) met **Root Directory `spel`**. De build-instellingen
staan in `spel/vercel.json` (Vite, `npm ci`, `npm run build`, uitvoer `dist`). Na het koppelen wordt elke push
naar `main` de productieversie en krijgt elke pull request een previewlink.

## Licenties van onderdelen

- Babylon.js — Apache-2.0 (npm-afhankelijkheid, gebundeld in de build).
- meshoptimizer-decoder — MIT, zie `spel/public/lib/meshopt_decoder.LICENSE.md`.
- Hand in `spel/public/assets/arm.glb` — gebaseerd op het MakeHuman-model (MakeHuman-assets: CC0).
- Poly Haven-assets — CC0 1.0. De hemel gebruikt de HDRI's `charolettenbrunn_park`, `sunset_forest` en
  `kloppenheim_07`; `chalet.glb` bevat onder meer de plant `potted_plant_04`. De herkomstregistratie van het
  project (`assets/extern/HERKOMST.json`, niet in deze repository; per bestand bron-URL, SHA-256 en licentie)
  noemt verder: texturen `white_oak_veneer`, `oak_veneer_03`, `wood_planks`, `beige_wall_001`, `leather_white`,
  `terlenka`, `cotton_jersey`, `rough_linen`, `leafy_grass` en `bark_brown_02`; modellen `shrub_01`, `shrub_04`,
  `tree_small_02` en de texturen van `pine_tree_01`; HDRI's `cloudy_vondelpark` en `blaubeuren_night`. Niet elk
  gedownload onderdeel komt in het spel voor.
