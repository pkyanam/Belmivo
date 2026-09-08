# Documentation site

Six responsive static pages, generated from the public self-hosting guides. No browser scripts, analytics or external fonts.

```sh
node site/build.mjs
node site/check.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory site/public
```

The GitHub Pages workflow deploys `site/public/`. Page and stylesheet links are relative for the repository subpath. Generated output is ignored and rebuilt from scratch.
