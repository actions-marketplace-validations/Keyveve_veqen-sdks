# Build Veqen AI Cost Lens

From this directory, using Node.js 22:

```sh
npm ci --ignore-scripts
npm run prepare-data
npm test
npm run package
```

In VS Code choose **Extensions: Install from VSIX…** and select the generated file.

The price book comes from `../python/veqen/data/prices.json`. Packaging copies the repository's reviewed snapshot and license notices; it never downloads a price book during editor use.

Packaging uses VSCE 3.7.1 with Azure Identity 4.13.0 and MSAL's UUID dependency pinned to 11.1.1 to avoid the affected MSAL 6.x authentication dependency and the older UUID buffer-bounds advisory. UUID 11 retains the CommonJS `v4()` API used here. These are build-only dependencies, excluded from the VSIX. Recheck these pins and `npm audit` when updating the packager.
