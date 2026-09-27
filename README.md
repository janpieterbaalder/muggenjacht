# Muggenjacht — "Nog één mug"

Browsergame (Babylon.js, WebGL 2): jaag in een chalet op muggen, van namiddag tot bedtijd, in tien rondes.
Bedoeld voor een telefoon in liggende stand; werkt ook op een desktopbrowser met muis en toetsenbord.

## Structuur

- `spel/` — het spel: broncode (`src/`), tests (`tests/`) en de spelbestanden (`public/`). Zie `spel/README.md`.
- Alleen de spelbestanden staan in deze repository. Referentiefoto's, het dossier en de bouwhulpmiddelen niet.

## Lokaal draaien

Vereist Node.js 22.

```
cd spel
npm ci
npm run dev      # http://127.0.0.1:5173
npm test
npm run build    # -> spel/dist/
```

## Publiceren (Vercel)

Vercel-project gekoppeld aan deze repository met **Root Directory `spel`**. De build-instellingen staan in
`spel/vercel.json` (Vite, `npm run build`, uitvoer `dist`). Elke push naar `main` wordt de productieversie;
pull requests krijgen een previewlink.

## Licenties van onderdelen

- Babylon.js — Apache-2.0 (npm-afhankelijkheid, gebundeld in de build).
- meshoptimizer-decoder — MIT, zie `spel/public/lib/meshopt_decoder.LICENSE.md`.
- Hemel-HDRI's `charolettenbrunn_park`, `sunset_forest` en `kloppenheim_07` van Poly Haven — CC0.
