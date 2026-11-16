# Changelog

## [0.6.0](https://github.com/shuymn/artifacts/compare/v0.5.0...v0.6.0) (2026-11-16)


### Features

* **gallery:** add consent tokens and components ([0a4bc21](https://github.com/shuymn/artifacts/commit/0a4bc2100e735b9a3efe8ae08dfac7c69c8d4448))
* **gallery:** design the consent page ([fdd50f5](https://github.com/shuymn/artifacts/commit/fdd50f5f764a17d13f86c0ac3bf68139c89614d6))
* **worker:** serve the OAuth authorization server ([7e87241](https://github.com/shuymn/artifacts/commit/7e87241f7fbd1cc4ab5b772ab6790bca7d29f719))
* **worker:** serve the OAuth authorization server ([5c0b3d0](https://github.com/shuymn/artifacts/commit/5c0b3d021b7e9af5c11b328a82e54aabf93cc2cf))


### Bug Fixes

* **worker:** refuse grant keys KV cannot hold ([47d7030](https://github.com/shuymn/artifacts/commit/47d703052f9181d6dfe1a8f4f26be4c8e9fb912c))

## [0.5.0](https://github.com/shuymn/artifacts/compare/v0.4.0...v0.5.0) (2026-11-16)


### Features

* **worker:** bind OAuth KV, optional API tokens ([d008d0b](https://github.com/shuymn/artifacts/commit/d008d0bba9992770198516bc247286fd146308a9))


### Bug Fixes

* **gallery:** stack info rows in a narrow list ([0469007](https://github.com/shuymn/artifacts/commit/0469007fa081ed5638cea9ec16ea03b64eff1967))

## [0.4.0](https://github.com/shuymn/artifacts/compare/v0.3.0...v0.4.0) (2026-11-16)


### Features

* **gallery:** show the icon and version in header ([8eef0bd](https://github.com/shuymn/artifacts/commit/8eef0bdad7152267227a8385585a1f08d75d7446))
* **gallery:** show the icon and version in the header ([76c3cb1](https://github.com/shuymn/artifacts/commit/76c3cb198916e2b2fe347f6a1c9c73ac11ee0e0b))


### Bug Fixes

* **gallery:** set the header icon on the baseline ([1c52174](https://github.com/shuymn/artifacts/commit/1c52174325613e5073d67de10c8b06d12c617ab9))
* **gallery:** wrap the header at narrow widths ([532147e](https://github.com/shuymn/artifacts/commit/532147ec1fa68ef3e207375d4d580cb629cbfb38))
* **hooks:** keep oxfmt from restaging .pen files ([71f6224](https://github.com/shuymn/artifacts/commit/71f6224b7e20749069fbc40328aa8a71ba2e1e49))
* **hooks:** stage the stripped design file first ([79228f4](https://github.com/shuymn/artifacts/commit/79228f49a2ed637e98627a112136a8d7d37d5ee3))
* **hooks:** strip fileToken from the staged blob only ([66f5932](https://github.com/shuymn/artifacts/commit/66f5932590c7190e93402da6c5b93aa59daddb88))

## [0.3.0](https://github.com/shuymn/artifacts/compare/v0.2.2...v0.3.0) (2026-11-16)


### Features

* **cli:** ship the CLI as single binaries on releases ([64028fd](https://github.com/shuymn/artifacts/commit/64028fdb007c3b74bca99c9f9add8412a975ac3a))

## [0.2.2](https://github.com/shuymn/artifacts/compare/v0.2.1...v0.2.2) (2026-11-16)


### Bug Fixes

* revalidate gallery pages, set Vary and MCP headers ([e1a1171](https://github.com/shuymn/artifacts/commit/e1a1171df697e666d20f3b9f6c4e319847a9e100))

## [0.2.1](https://github.com/shuymn/artifacts/compare/v0.2.0...v0.2.1) (2026-11-16)


### Bug Fixes

* **gallery:** serve stale asset paths, revalidated ([846f9c8](https://github.com/shuymn/artifacts/commit/846f9c888171fb540561e17ac048dc966b42d2bf))
* **gallery:** stop the font flash on reload ([fa6a312](https://github.com/shuymn/artifacts/commit/fa6a3123f983b922e66c5acbb40729e61a8f8fa6))
* **gallery:** stop the font flash on reload ([a0fe73b](https://github.com/shuymn/artifacts/commit/a0fe73bdfdc635b311950c99a08dbfae818b484b))

## [0.2.0](https://github.com/shuymn/artifacts/compare/v0.1.2...v0.2.0) (2026-11-16)


### Features

* add a favicon for the gallery and artifact pages ([98fe376](https://github.com/shuymn/artifacts/commit/98fe376be32df325eab36d2ca9d3af4efc867325))
* **gallery:** add the gallery icon ([4308842](https://github.com/shuymn/artifacts/commit/4308842b1578db25062a3bb43aab4cc59f415f3d))
* **worker:** fall back to the gallery's favicon ([0aee51b](https://github.com/shuymn/artifacts/commit/0aee51b19aabda3d3e1aeff769c8fe9ba561f334))

## [0.1.2](https://github.com/shuymn/artifacts/compare/v0.1.1...v0.1.2) (2026-11-16)


### Bug Fixes

* **worker:** silence the module rule warnings ([95b231e](https://github.com/shuymn/artifacts/commit/95b231e3382f296f2d9af57afe6010e6b9da042f))
* **worker:** silence the module rule warnings ([60bde22](https://github.com/shuymn/artifacts/commit/60bde22b4408f8113659af04178e59511d95a6c1))

## [0.1.1](https://github.com/shuymn/artifacts/compare/v0.1.0...v0.1.1) (2026-11-16)


### Bug Fixes

* take build tool versions from the commit ([5453c93](https://github.com/shuymn/artifacts/commit/5453c93cdb9998be52f25e40a7d3e712648e37a7))
* **worker:** install with the pnpm of mise.lock ([2007cae](https://github.com/shuymn/artifacts/commit/2007cae78e34de7ccecbd8425d31558d75231c3a))

## 0.1.0 (2026-11-16)


### Features

* add deployment tooling and the operations guide ([4eb3d03](https://github.com/shuymn/artifacts/commit/4eb3d038207933f379634dcb6368d6a6147b4b1f))
* **cli:** add the artifacts command ([d1165f3](https://github.com/shuymn/artifacts/commit/d1165f36c3b998486f265694204587d4b1289e96))
* **cli:** add the artifacts command ([0c02332](https://github.com/shuymn/artifacts/commit/0c023326d8c3000858e51b5802944c27a22f98e3))
* **gallery:** add the stylesheet that carries the design tokens ([ff46a03](https://github.com/shuymn/artifacts/commit/ff46a036242b9925a8c1afae2ad5e20902c6a500))
* **gallery:** serve the gallery pages ([e46dd87](https://github.com/shuymn/artifacts/commit/e46dd87dba371d85113676ebf563ece21fbf2b7a))
* **worker:** add the D1 schema and bindings ([48c18b7](https://github.com/shuymn/artifacts/commit/48c18b7b785dacf9b364c574a3b8fb1e5e07924d))
* **worker:** add the deployment script ([559e154](https://github.com/shuymn/artifacts/commit/559e1544fc5ce946dd0837027981d0194138ba73))
* **worker:** encode MCP file content ([3d8a260](https://github.com/shuymn/artifacts/commit/3d8a260d17151f9d9d1435eb42c7d703336d3a30))
* **worker:** parse config and verify callers ([3eb49df](https://github.com/shuymn/artifacts/commit/3eb49df12d8e49464f979d5981fd24f14f418450))
* **worker:** read gallery pages in one snapshot ([c92510f](https://github.com/shuymn/artifacts/commit/c92510f3062dce5e18a799c6a4a9852af1f411c1))
* **worker:** serve the MCP endpoint at /mcp ([6da6e63](https://github.com/shuymn/artifacts/commit/6da6e6334ec54209da2a4b0de895157376468a06))
* **worker:** store, publish and serve artifacts ([c658ea4](https://github.com/shuymn/artifacts/commit/c658ea4066d27d244b49108672852bc1b486a05a))
* **worker:** validate publish paths and input ([0414b07](https://github.com/shuymn/artifacts/commit/0414b0730bdca5dde9f106266609d75b59b80a10))


### Bug Fixes

* check the created App and keep its key out of logs ([b2584ab](https://github.com/shuymn/artifacts/commit/b2584ab2fae61e740fd45f3a79c8ad9384033095))
* **cli:** advise get after a lost update ([af59b74](https://github.com/shuymn/artifacts/commit/af59b74b02eee91149dd54d7233876796cf2935b))
* **cli:** keep pulled files inside the directory ([ea2a12a](https://github.com/shuymn/artifacts/commit/ea2a12ac81797314ddfeb93cc64533e7c192034e))
* **cli:** match a lost create by the bytes sent ([6299aae](https://github.com/shuymn/artifacts/commit/6299aae69f563c81e1ee39e04495a2f5302cd118))
* **cli:** refuse a symlinked pull destination ([d38f57b](https://github.com/shuymn/artifacts/commit/d38f57b5074a6d9c9e0b09f4a34abcbfe3fe715d))
* **cli:** report an error status with a cut body ([7c4626d](https://github.com/shuymn/artifacts/commit/7c4626d07645e0ffe19614fd37c4dfb913636d44))
* **cli:** treat a broken answer body as lost ([cbcf33a](https://github.com/shuymn/artifacts/commit/cbcf33aec2afc524c6ecbe177871c3bfddc3e195))
* **gallery:** keep stacked tables inside their box and accessible ([8ce09fa](https://github.com/shuymn/artifacts/commit/8ce09fab79f4feec2b0bb40f11385a666c2c89a1))
* **gallery:** send the CSP on every app-host answer ([662ec85](https://github.com/shuymn/artifacts/commit/662ec8563408201809a2ac9e8307d4e1b2fe4c8b))
* make the operations commands run as written ([f738b24](https://github.com/shuymn/artifacts/commit/f738b2486b33ebebb744cfd8024b3d966712fc8f))
* **worker:** accept a zone name in any case ([cc103c5](https://github.com/shuymn/artifacts/commit/cc103c5ff126a59f68988c21f4430f1165289d27))
* **worker:** cancel an R2 body that arrives late ([f40ff37](https://github.com/shuymn/artifacts/commit/f40ff37dbfae369383d9e689fddc1e5023d8e722))
* **worker:** check route zones before migrations ([b8e77cd](https://github.com/shuymn/artifacts/commit/b8e77cd492cf8c16e483396d803d68a4aceccdfa))
* **worker:** derive the ETag from bytes and type ([52d35b4](https://github.com/shuymn/artifacts/commit/52d35b4d4dd9904612f4f8a2f86430a5a39d55fe))
* **worker:** mark changes that remove as destructive ([8c3150f](https://github.com/shuymn/artifacts/commit/8c3150fee4c10c291118762de707fdf8356b5773))
* **worker:** refuse file parts without a file name ([7fa5624](https://github.com/shuymn/artifacts/commit/7fa5624e5ba821971911ef9a7139747a33825db4))
* **worker:** signal every process of a deploy step ([406a134](https://github.com/shuymn/artifacts/commit/406a134e3b8cd73a6a0bba994f173724ed410838))
