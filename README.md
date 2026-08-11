# Kiln

**Throw, glaze, and fire pottery in the browser **

**Live: [kiln.shaux.dev](https://kiln.shaux.dev)** · Figma plugin (in Community review) · [full build log](docs/BUILDLOG.md)

![Kiln — a crystalline bottle on the pedestal](packages/playground/public/og.png)

## The idea

WIP

## Running locally

```bash
pnpm install
pnpm dev          # playground at localhost:5173
pnpm typecheck    # engine + playground + plugin
```

For the Figma plugin: `pnpm --filter @kiln/figma-plugin build`, then in the Figma
desktop app: *Plugins → Development → Import plugin from manifest…* →
`packages/figma-plugin/manifest.json`.

Useful debug views: `?debug=sound` (audition every synthesized sound),
`?debug=cursor` (the cursor state board), `?debug=texture&shift=1` (glaze textures
flat, seam-check mode), `?demo=1` (pre-stocked shelf).

## Roadmap

- **The multiplayer kiln**: a Figma widget where a whole team loads one kiln and fires
  it together — widget state is natively multiplayer, and a communal kiln opening is
  the most honest use of it.
- **Fire your brand**: derive a glaze from a selection's fills or the file's color
  variables — pot your design system.
- Dev Mode codegen: a placed pot hands you its TSL material as code.

## Credits

Type: [Fraunces](https://github.com/undercasetype/Fraunces) and
[IBM Plex Mono](https://github.com/IBM/plex), self-hosted via Fontsource.
Rendering: [three.js](https://threejs.org). Everything else grown from seeds.

MIT © Shaurya Sarma
