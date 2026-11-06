# vendor/wms-core.mjs

The order tracer from [Where's My Swap](https://github.com/cryppit/wheres-my-swap), bundled so this repo needs no install.

- Source: `cryppit/wheres-my-swap` at commit `76cac26` (MIT), written before this project. It is declared baseline, not hackathon work.
- `wms-entry.ts` lists what is exported. Build it from the root of that repo with:

```sh
esbuild vendor/wms-entry.ts --bundle --format=esm --platform=neutral --outfile=vendor/wms-core.mjs
```
