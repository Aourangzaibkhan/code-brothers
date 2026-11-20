# Contributing to Code Brothers

Contributions are welcome: new connectors, new language packs, bug fixes and docs.

1. Fork the repo and create a feature branch.
2. Follow the monorepo structure in Section 9 of the platform spec (docs/).
3. Every connector must declare a permission manifest (packages/node-sdk).
4. Never commit secrets — CI runs Gitleaks on every push.
5. Open a pull request with a clear description and test notes.
